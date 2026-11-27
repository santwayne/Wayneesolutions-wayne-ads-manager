import { query } from '../lib/db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { graphForAdAccount } from '../meta/tokens.js';
import { toMinor } from '../meta/sync.js';

/**
 * Every write to Meta goes through here (money safety, spec "non-negotiable"):
 *  - launch only from a user click or WhatsApp "Haan" (source user/whatsapp)
 *  - budget increase max 20% per change; never above the owner's daily cap
 *  - every write is logged in actions_log with before/after; last change undoable
 *  - billing / payment method is never touched (graph.js also blocks it)
 */

export const MAX_BUDGET_STEP = 0.20;
const TABLE = { campaign: 'campaigns', adset: 'adsets', ad: 'ads' };
const LAUNCH_SOURCES = new Set(['user', 'whatsapp']);

let graphFactory = graphForAdAccount;
export function setGraphFactory(fn) { graphFactory = fn; } // tests

export async function logAction({ orgId, who, what, level = null, objectId = null, before = null, after = null, source, undoOf = null }, db = { query }) {
  const { rows } = await db.query(
    `INSERT INTO actions_log (org_id, who, what, level, object_id, before, after, source, undo_of)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [orgId, who, what, level, objectId, before && JSON.stringify(before), after && JSON.stringify(after), source, undoOf],
  );
  return rows[0];
}

async function loadObject(orgId, level, metaId) {
  const t = TABLE[level];
  if (!t) throw badRequest('Unknown level');
  const joins = {
    campaigns: 'JOIN ad_accounts a ON a.id = o.ad_account_id',
    adsets: 'JOIN campaigns c ON c.id = o.campaign_id JOIN ad_accounts a ON a.id = c.ad_account_id',
    ads: 'JOIN adsets s ON s.id = o.adset_id JOIN campaigns c ON c.id = s.campaign_id JOIN ad_accounts a ON a.id = c.ad_account_id',
  }[t];
  const { rows } = await query(
    `SELECT o.*, row_to_json(a.*) AS ad_account FROM ${t} o ${joins} WHERE o.meta_id = $1 AND o.org_id = $2`,
    [metaId, orgId],
  );
  if (!rows[0]) throw notFound('Campaign/ad nahi mila');
  return rows[0];
}

async function loadOrg(orgId) {
  const { rows } = await query('SELECT * FROM orgs WHERE id = $1', [orgId]);
  if (!rows[0]) throw notFound('Org nahi mila');
  return rows[0];
}

async function assertWalletOk(org) {
  if (org.payment_model !== 'B') return;
  const { rows } = await query('SELECT balance FROM wallets WHERE org_id = $1', [org.id]);
  if (!rows[0] || Number(rows[0].balance) <= 0) throw conflict('Wallet khaali hai — pehle top-up karein, phir ads chalenge');
}

export async function setStatus({ orgId, level, metaId, status, actor }) {
  if (!['ACTIVE', 'PAUSED'].includes(status)) throw badRequest('status ACTIVE ya PAUSED');
  const obj = await loadObject(orgId, level, metaId);
  if (status === 'ACTIVE') {
    // Resuming a paused object after it was live = resume; first activation = launch (human only).
    const wasLaunched = level === 'campaign' ? obj.launched_at : true;
    if (!wasLaunched && !LAUNCH_SOURCES.has(actor.source)) throw forbidden('Launch sirf insaan kar sakta hai (app click ya WhatsApp "Haan")');
    await assertWalletOk(await loadOrg(orgId));
  }
  if (obj.status === status) return { unchanged: true };
  const g = await graphFactory(obj.ad_account);
  await g.post(metaId, { status });
  await query(`UPDATE ${TABLE[level]} SET status = $1, updated_at = now() WHERE id = $2`, [status, obj.id]);
  const log = await logAction({
    orgId, who: actor.who, source: actor.source, level, objectId: metaId,
    what: status === 'PAUSED' ? 'pause' : 'resume', before: { status: obj.status }, after: { status },
  });
  return { log };
}

/** Launch a wizard-created campaign: campaign + ad set + ads -> ACTIVE. Human only. */
export async function launchCampaign({ orgId, campaignMetaId, actor }) {
  if (!LAUNCH_SOURCES.has(actor.source)) throw forbidden('Launch sirf insaan kar sakta hai (app click ya WhatsApp "Haan")');
  const camp = await loadObject(orgId, 'campaign', campaignMetaId);
  await assertWalletOk(await loadOrg(orgId));
  const g = await graphFactory(camp.ad_account);
  const { rows: sets } = await query('SELECT * FROM adsets WHERE campaign_id = $1', [camp.id]);
  const { rows: ads } = await query('SELECT a.* FROM ads a JOIN adsets s ON s.id = a.adset_id WHERE s.campaign_id = $1', [camp.id]);
  // Children first so nothing half-launches with a live parent.
  for (const ad of ads) await g.post(ad.meta_id, { status: 'ACTIVE' });
  for (const s of sets) await g.post(s.meta_id, { status: 'ACTIVE' });
  await g.post(camp.meta_id, { status: 'ACTIVE' });
  await query("UPDATE ads SET status='ACTIVE', updated_at=now() WHERE adset_id = ANY($1)", [sets.map((s) => s.id)]);
  await query("UPDATE adsets SET status='ACTIVE', updated_at=now() WHERE campaign_id = $1", [camp.id]);
  await query("UPDATE campaigns SET status='ACTIVE', launched_at=now(), updated_at=now() WHERE id = $1", [camp.id]);
  await query("UPDATE wizard_drafts SET status='launched', updated_at=now() WHERE campaign_id = $1", [camp.id]);
  const log = await logAction({ orgId, who: actor.who, source: actor.source, level: 'campaign', objectId: campaignMetaId, what: 'launch', before: { status: camp.status }, after: { status: 'ACTIVE' } });
  return { log };
}

export async function activeDailyBudgetTotal(orgId, excludeAdsetId = null) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(s.daily_budget),0) AS total FROM adsets s JOIN campaigns c ON c.id = s.campaign_id
     WHERE s.org_id = $1 AND s.status = 'ACTIVE' AND c.status = 'ACTIVE' AND ($2::bigint IS NULL OR s.id <> $2)`,
    [orgId, excludeAdsetId],
  );
  return Number(rows[0].total);
}

/** Pure check, exported for tests. */
export function checkBudgetChange({ current, next, capTotal, otherActiveTotal, isUndo = false }) {
  if (!(next > 0)) return { ok: false, reason: 'Budget 0 se zyada hona chahiye' };
  if (!isUndo && current > 0 && next > current * (1 + MAX_BUDGET_STEP) + 0.001) {
    return { ok: false, reason: `Ek baar mein max 20% badha sakte hain (₹${Math.floor(current * 1.2)} tak)` };
  }
  if (capTotal != null && next > current && otherActiveTotal + next > Number(capTotal)) {
    return { ok: false, reason: `Account ki daily cap ₹${capTotal} se upar nahi ja sakte` };
  }
  return { ok: true };
}

export async function changeBudget({ orgId, adsetMetaId, dailyBudget, actor, isUndo = false, undoOf = null }) {
  const set = await loadObject(orgId, 'adset', adsetMetaId);
  const org = await loadOrg(orgId);
  const current = Number(set.daily_budget || 0);
  const next = Math.round(Number(dailyBudget));
  const check = checkBudgetChange({ current, next, capTotal: org.daily_budget_cap, otherActiveTotal: await activeDailyBudgetTotal(orgId, set.id), isUndo });
  if (!check.ok) throw conflict(check.reason);
  if (next === current) return { unchanged: true };
  const g = await graphFactory(set.ad_account);
  await g.post(adsetMetaId, { daily_budget: toMinor(next) });
  await query('UPDATE adsets SET daily_budget = $1, updated_at = now() WHERE id = $2', [next, set.id]);
  const log = await logAction({ orgId, who: actor.who, source: actor.source, level: 'adset', objectId: adsetMetaId, what: isUndo ? 'undo' : 'budget', before: { daily_budget: current }, after: { daily_budget: next }, undoOf });
  return { log };
}

/** Owner one-click undo of the last pause/resume/budget change. */
export async function undoLast({ orgId, actor }) {
  const { rows } = await query(
    `SELECT * FROM actions_log WHERE org_id = $1 AND what IN ('pause','resume','budget') AND undone_by IS NULL
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [orgId],
  );
  const last = rows[0];
  if (!last) throw notFound('Undo karne ke liye koi change nahi');
  let res;
  if (last.what === 'budget') {
    res = await changeBudget({ orgId, adsetMetaId: last.object_id, dailyBudget: last.before.daily_budget, actor, isUndo: true, undoOf: last.id });
  } else {
    const obj = await loadObject(orgId, last.level, last.object_id);
    const g = await graphFactory(obj.ad_account);
    await g.post(last.object_id, { status: last.before.status });
    await query(`UPDATE ${TABLE[last.level]} SET status=$1, updated_at=now() WHERE id=$2`, [last.before.status, obj.id]);
    res = { log: await logAction({ orgId, who: actor.who, source: actor.source, level: last.level, objectId: last.object_id, what: 'undo', before: last.after, after: last.before, undoOf: last.id }) };
  }
  await query('UPDATE actions_log SET undone_by = $1 WHERE id = $2', [res.log.id, last.id]);
  return { undone: last, ...res };
}
