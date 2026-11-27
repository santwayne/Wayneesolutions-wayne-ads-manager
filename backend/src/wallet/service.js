import { config } from '../config.js';
import { query, tx } from '../lib/db.js';
import { badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { setStatus, logAction } from '../actions/service.js';
import { notifyOwner } from '../notify/whatsapp.js';
import { inr } from '../notify/format.js';

/**
 * Model B (Wayne pays Meta): prepaid wallet. Client tops up first; spend is debited daily
 * from Insights; alert before it runs out; at 0 (incl. today's running spend) ads auto-pause.
 * GST treatment: confirm with the CA. GST_ON_AD_SPEND=0 puts GST on the service fee only.
 */
const GST_ON_AD_SPEND = process.env.GST_ON_AD_SPEND !== '0';

async function ensureWallet(c, orgId) {
  await c.query('INSERT INTO wallets (org_id) VALUES ($1) ON CONFLICT DO NOTHING', [orgId]);
  return (await c.query('SELECT * FROM wallets WHERE org_id = $1 FOR UPDATE', [orgId])).rows[0];
}

export async function postLedger(orgId, { kind, amount, ref = null, note = null }) {
  return tx(async (c) => {
    const w = await ensureWallet(c, orgId);
    const balance = Math.round((Number(w.balance) + Number(amount)) * 100) / 100;
    const ins = await c.query(
      `INSERT INTO wallet_ledger (org_id, kind, amount, balance_after, ref, note) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING RETURNING *`, [orgId, kind, amount, balance, ref, note]);
    if (!ins.rows[0]) return { duplicate: true, balance: Number(w.balance) };
    await c.query('UPDATE wallets SET balance = $2, updated_at = now() WHERE org_id = $1', [orgId, balance]);
    return { entry: ins.rows[0], balance };
  });
}

export async function topUp(orgId, amount, { ref, actor }) {
  if (!(amount > 0)) throw badRequest('Amount 0 se zyada');
  const r = await postLedger(orgId, { kind: 'topup', amount, ref, note: 'Wallet top-up' });
  await logAction({ orgId, who: actor.who, source: actor.source, what: 'wallet_topup', after: { amount, balance: r.balance } });
  const { rows: [w] } = await query('SELECT auto_paused FROM wallets WHERE org_id = $1', [orgId]);
  if (w?.auto_paused && r.balance > 0) {
    await query('UPDATE wallets SET auto_paused = false WHERE org_id = $1', [orgId]);
    await notifyOwner(orgId, `✅ ${inr(amount)} wallet mein aa gaye. Balance ${inr(r.balance)}. Ads dobara chalu karne ke liye app mein campaign "Resume" karein ya WhatsApp pe batayein.`);
  }
  return r;
}

const ymd = (d) => d.toISOString().slice(0, 10);

/** Daily: debit yesterday's final spend (idempotent per date). */
export async function debitDailySpend(orgId, date = ymd(new Date(Date.now() - 86400_000))) {
  const { rows: [s] } = await query(
    "SELECT COALESCE(SUM(spend),0) AS spend FROM insights_daily WHERE org_id = $1 AND level = 'account' AND date = $2", [orgId, date]);
  if (!Number(s.spend)) return { spend: 0 };
  return postLedger(orgId, { kind: 'spend', amount: -Number(s.spend), ref: `spend:${date}`, note: `Meta ad spend ${date}` });
}

/** After every sync: projected balance = balance - today's running spend. */
export async function checkWallet(orgId) {
  const { rows: [org] } = await query('SELECT * FROM orgs WHERE id = $1', [orgId]);
  if (org?.payment_model !== 'B') return null;
  const { rows: [w] } = await query('SELECT * FROM wallets WHERE org_id = $1', [orgId]);
  if (!w) return null;
  const { rows: [t] } = await query(
    "SELECT COALESCE(SUM(spend),0) AS spend FROM insights_daily WHERE org_id = $1 AND level = 'account' AND date = CURRENT_DATE", [orgId]);
  const projected = Number(w.balance) - Number(t.spend);
  if (projected <= 0 && !w.auto_paused) {
    const { rows: camps } = await query("SELECT meta_id FROM campaigns WHERE org_id = $1 AND status = 'ACTIVE'", [orgId]);
    for (const c of camps) {
      try { await setStatus({ orgId, level: 'campaign', metaId: c.meta_id, status: 'PAUSED', actor: { who: 'system:wallet', source: 'system' } }); }
      catch (e) { logger.error({ err: e.message, campaign: c.meta_id }, 'wallet auto-pause failed'); }
    }
    await query('UPDATE wallets SET auto_paused = true WHERE org_id = $1', [orgId]);
    await notifyOwner(orgId, `⛔ Wallet khatam — saare ads pause kar diye gaye hain taaki extra kharcha na ho. Top-up karte hi dobara chalu kar sakte hain.`);
    return { paused: camps.length, projected };
  }
  if (projected > 0 && projected <= Number(w.low_balance_threshold)) {
    const last = w.last_low_alert_at ? new Date(w.last_low_alert_at) : null;
    if (!last || Date.now() - last.getTime() > 20 * 3600_000) {
      await query('UPDATE wallets SET last_low_alert_at = now() WHERE org_id = $1', [orgId]);
      await notifyOwner(orgId, `⚠️ Wallet mein sirf ${inr(projected)} bache hain. Ads band na hon, isliye jaldi top-up karein.`);
    }
  }
  return { projected };
}

export function invoiceAmounts({ adSpend, serviceFee, gstRate = config.gstRate, gstOnAdSpend = GST_ON_AD_SPEND }) {
  const taxable = (gstOnAdSpend ? adSpend : 0) + serviceFee;
  const gst = Math.round(taxable * gstRate * 100) / 100;
  return { adSpend, serviceFee, gst, total: Math.round((adSpend + serviceFee + gst) * 100) / 100 };
}

/** Monthly invoice (1st of month for previous month). Service fee is debited from the wallet. */
export async function issueMonthlyInvoice(orgId, monthStart) {
  const { rows: [org] } = await query('SELECT * FROM orgs WHERE id = $1', [orgId]);
  const { rows: [s] } = await query(
    "SELECT COALESCE(-SUM(amount),0) AS spend FROM wallet_ledger WHERE org_id = $1 AND kind = 'spend' AND created_at >= $2::date AND created_at < ($2::date + INTERVAL '1 month')",
    [orgId, monthStart]);
  const a = invoiceAmounts({ adSpend: Number(s.spend), serviceFee: Number(org.service_fee_monthly) });
  const number = `WAY-${monthStart.slice(0, 7).replace('-', '')}-${orgId}`;
  const { rows } = await query(
    `INSERT INTO invoices (org_id, number, month, ad_spend, service_fee, gst, total) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (org_id, month) DO NOTHING RETURNING *`, [orgId, number, monthStart, a.adSpend, a.serviceFee, a.gst, a.total]);
  if (rows[0] && a.serviceFee + a.gst > 0) {
    await postLedger(orgId, { kind: 'service_fee', amount: -(a.serviceFee + a.gst), ref: number, note: 'Service fee + GST (all GST on this invoice)' });
  }
  return rows[0] || null;
}
