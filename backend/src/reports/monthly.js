import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { config } from '../config.js';
import { query } from '../lib/db.js';

/**
 * Monthly report (spec "Monthly PDF/live report"): one payload, three outputs —
 * live web page (share link), PDF, and the 1st-of-month WhatsApp/email.
 */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const monthBounds = (m) => {
  const start = `${m}-01`;
  const d = new Date(`${start}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1);
  return { start, end: d.toISOString().slice(0, 10) }; // [start, end)
};
export const currentMonth = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7); // IST
export const previousMonth = (m = currentMonth()) => { const d = new Date(`${m}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

async function monthTotals(orgId, m) {
  const { start, end } = monthBounds(m);
  const { rows: [r] } = await query(
    `SELECT COALESCE(SUM(spend),0) AS spend, COALESCE(SUM(leads),0) AS leads, COALESCE(SUM(impressions),0) AS impressions, COALESCE(SUM(clicks),0) AS clicks,
            COALESCE(SUM(spend) FILTER (WHERE platform = 'google'),0) AS google_spend
     FROM insights_daily WHERE org_id = $1 AND level = 'account' AND date >= $2 AND date < $3`, [orgId, start, end]);
  const { rows: [l] } = await query(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'won') AS won, COUNT(*) FILTER (WHERE status IN ('consultation_booked','qualified')) AS booked,
            COUNT(*) FILTER (WHERE out_of_area) AS out_of_area, COUNT(*) FILTER (WHERE status = 'junk') AS junk
     FROM leads WHERE org_id = $1 AND created_at >= $2 AND created_at < $3`, [orgId, start, end]);
  const spend = Number(r.spend); const leads = Number(r.leads); const won = Number(l.won);
  return {
    spend, leads, impressions: Number(r.impressions), clicks: Number(r.clicks), googleSpend: Number(r.google_spend),
    cpl: leads ? Math.round(spend / leads) : null, ctr: Number(r.impressions) ? Math.round((Number(r.clicks) / Number(r.impressions)) * 10000) / 100 : null,
    crmLeads: Number(l.total), booked: Number(l.booked), won, costPerCustomer: won ? Math.round(spend / won) : null,
    outOfAreaPct: Number(l.total) ? Math.round((Number(l.out_of_area) / Number(l.total)) * 100) : 0, junk: Number(l.junk),
  };
}

export async function buildMonthlyReport(orgId, m = currentMonth()) {
  const { start, end } = monthBounds(m);
  const { rows: [org] } = await query('SELECT id, name, payment_model FROM orgs WHERE id = $1', [orgId]);
  const [totals, prev] = await Promise.all([monthTotals(orgId, m), monthTotals(orgId, previousMonth(m))]);
  const { rows: daily } = await query(
    `SELECT date, SUM(spend) AS spend, SUM(leads) AS leads FROM insights_daily WHERE org_id = $1 AND level = 'account' AND date >= $2 AND date < $3 GROUP BY date ORDER BY date`,
    [orgId, start, end]);
  const perf = async (level) => (await query(
    `SELECT o.meta_id AS id, o.name, o.status, SUM(i.spend) AS spend, SUM(i.leads) AS leads, MAX(i.frequency) AS frequency
     FROM ${level === 'campaign' ? 'campaigns' : 'ads'} o JOIN insights_daily i ON i.object_id = o.meta_id AND i.date >= $2 AND i.date < $3
     WHERE o.org_id = $1 GROUP BY o.id ORDER BY SUM(i.spend) DESC LIMIT 15`, [orgId, start, end])).rows
    .map((r) => ({ ...r, spend: Number(r.spend), leads: Number(r.leads), cpl: Number(r.leads) ? Math.round(Number(r.spend) / Number(r.leads)) : null }));
  const campaigns = await perf('campaign');
  const ads = (await perf('ad')).filter((a) => a.spend > 0);
  const best = [...ads].filter((a) => a.cpl).sort((a, b) => a.cpl - b.cpl).slice(0, 3);
  const worst = [...ads].sort((a, b) => (b.cpl ?? Infinity) - (a.cpl ?? Infinity)).slice(0, 3);
  const { rows: [act] } = await query(
    `SELECT COUNT(*) FILTER (WHERE what = 'pause') AS paused, COUNT(*) FILTER (WHERE what = 'budget') AS budget, COUNT(*) FILTER (WHERE what = 'launch') AS launched,
            COUNT(*) FILTER (WHERE source = 'rule') AS auto
     FROM actions_log WHERE org_id = $1 AND created_at >= $2 AND created_at < $3`, [orgId, start, end]);
  const { rows: [rec] } = await query('SELECT payload FROM recommendations WHERE org_id = $1 ORDER BY week_start DESC LIMIT 1', [orgId]);
  return {
    business: org.name, month: m, generatedAt: new Date().toISOString(), totals, previous: prev,
    daily: daily.map((d) => ({ date: d.date, spend: Number(d.spend), leads: Number(d.leads) })),
    campaigns, bestAds: best, worstAds: worst,
    actions: { paused: Number(act.paused), budgetChanges: Number(act.budget), launched: Number(act.launched), byRules: Number(act.auto) },
    nextSteps: rec?.payload?.actions || [],
  };
}

const inr = (n) => (n == null ? '—' : `₹${Math.round(Number(n)).toLocaleString('en-IN')}`);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

export function summaryLine(r) {
  const t = r.totals;
  let s = `${monthLabel(r.month)}: ${inr(t.spend)} lage, ${t.leads} leads${t.cpl ? `, ek lead ${inr(t.cpl)} ki` : ''}`;
  if (t.won) s += `, ${t.won} customer bane (ek customer ${inr(t.costPerCustomer)} ka)`;
  if (r.previous.cpl && t.cpl) {
    const ch = Math.round(((t.cpl - r.previous.cpl) / r.previous.cpl) * 100);
    s += `. Pichle mahine se lead ${Math.abs(ch)}% ${ch <= 0 ? 'sasti' : 'mehngi'}`;
  }
  return `${s}.`;
}

/** PDF (A4). Built with pdfkit; body 11pt. ₹ is written as "Rs." because the built-in PDF fonts have no ₹ glyph. */
export function reportPdf(r) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `${r.business} — ${monthLabel(r.month)} ads report` } });
  const money = (n) => (n == null ? '—' : `Rs. ${Math.round(Number(n)).toLocaleString('en-IN')}`);
  const t = r.totals;
  doc.fontSize(20).font('Helvetica-Bold').text(r.business);
  doc.fontSize(12).font('Helvetica').fillColor('#555').text(`Ads report — ${monthLabel(r.month)}`).moveDown(0.8).fillColor('#000');
  doc.fontSize(11).text(summaryLine(r).replace(/₹/g, 'Rs. ')).moveDown(0.8);

  // KPI table
  const kpis = [['Ad spend', money(t.spend), money(r.previous.spend)], ['Leads', String(t.leads), String(r.previous.leads)], ['Cost per lead', money(t.cpl), money(r.previous.cpl)],
    ['Customers won (CRM)', String(t.won), String(r.previous.won)], ['Cost per customer', money(t.costPerCustomer), money(r.previous.costPerCustomer)],
    ['Click-through rate', t.ctr != null ? `${t.ctr}%` : '—', r.previous.ctr != null ? `${r.previous.ctr}%` : '—'], ['Leads out of area', `${t.outOfAreaPct}%`, `${r.previous.outOfAreaPct}%`]];
  if (t.googleSpend) kpis.splice(1, 0, ['  of which Google', money(t.googleSpend), money(r.previous.googleSpend)]);
  const x0 = 50; const cols = [230, 120, 120]; let y = doc.y;
  doc.font('Helvetica-Bold'); [['Metric', 'This month', 'Last month']].concat(kpis).forEach((row, i) => {
    if (i === 1) doc.font('Helvetica');
    let x = x0; row.forEach((c, j) => { doc.text(c, x, y, { width: cols[j], align: j ? 'right' : 'left' }); x += cols[j]; });
    y += 18; doc.moveTo(x0, y - 4).lineTo(x0 + 470, y - 4).strokeColor('#e4e7ec').stroke();
  });
  doc.y = y + 10;

  // Daily spend bars
  if (r.daily.length) {
    doc.font('Helvetica-Bold').text('Daily spend', x0, doc.y).moveDown(0.3);
    const top = doc.y; const h = 90; const w = 470; const max = Math.max(...r.daily.map((d) => d.spend), 1); const bw = w / r.daily.length;
    r.daily.forEach((d, i) => { const bh = (d.spend / max) * h; doc.rect(x0 + i * bw + 1, top + h - bh, Math.max(bw - 2, 1), bh).fill('#1d4ed8'); });
    doc.fillColor('#555').fontSize(8).text(String(r.daily[0].date).slice(8, 10), x0, top + h + 3).text(String(r.daily.at(-1).date).slice(8, 10), x0 + w - 12, top + h + 3);
    doc.fillColor('#000').fontSize(11); doc.y = top + h + 20;
  }

  const table = (title, rows) => {
    if (!rows.length) return;
    if (doc.y > 680) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(11).text(title, x0, doc.y).moveDown(0.3);
    const c = [250, 80, 60, 80]; let yy = doc.y;
    [['Name', 'Spend', 'Leads', 'Per lead']].concat(rows.map((a) => [a.name, money(a.spend), String(a.leads), money(a.cpl)])).forEach((row, i) => {
      doc.font(i ? 'Helvetica' : 'Helvetica-Bold').fontSize(10);
      let x = x0; row.forEach((v, j) => { doc.text(v, x, yy, { width: c[j], align: j ? 'right' : 'left', ellipsis: true, height: 14 }); x += c[j]; });
      yy += 16;
      if (yy > 770) { doc.addPage(); yy = 50; }
    });
    doc.y = yy + 8;
  };
  table('Campaigns', r.campaigns);
  table('Best ads (lowest cost per lead)', r.bestAds);
  table('Ads to fix', r.worstAds);

  if (doc.y > 700) doc.addPage();
  doc.font('Helvetica-Bold').fontSize(11).text('What the tool did this month', x0, doc.y).font('Helvetica').fontSize(10)
    .text(`${r.actions.launched} campaigns launched, ${r.actions.paused} ads paused, ${r.actions.budgetChanges} budget changes (${r.actions.byRules} by autopilot rules).`).moveDown(0.6);
  if (r.nextSteps.length) {
    doc.font('Helvetica-Bold').fontSize(11).text('Next steps').font('Helvetica').fontSize(10);
    r.nextSteps.slice(0, 3).forEach((a, i) => doc.text(`${i + 1}. ${a.title}${a.why ? ` — ${a.why}` : ''}`.replace(/₹/g, 'Rs. ')));
  }
  doc.page.margins.bottom = 0; // footer sits in the bottom margin without starting a new page
  doc.fontSize(8).fillColor('#888').text(`Generated ${new Date(r.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} by Wayne Ads Manager`, x0, 805, { align: 'center', width: 495, lineBreak: false });
  doc.end();
  return doc; // a readable stream
}

export async function pdfBuffer(r) {
  const doc = reportPdf(r);
  const chunks = [];
  for await (const c of doc) chunks.push(c);
  return Buffer.concat(chunks);
}

// ---- Share links (live report) ----
export async function createReportLink(orgId, userId, days = 90) {
  const token = crypto.randomBytes(24).toString('base64url');
  await query('INSERT INTO report_links (org_id, token_hash, created_by, expires_at) VALUES ($1,$2,$3, now() + make_interval(days => $4))', [orgId, sha(token), userId, days]);
  return { token, url: `${config.appUrl}/r/${token}` };
}

export async function orgForReportToken(token) {
  const { rows: [l] } = await query('SELECT org_id FROM report_links WHERE token_hash = $1 AND NOT revoked AND (expires_at IS NULL OR expires_at > now())', [sha(String(token || ''))]);
  return l?.org_id || null;
}
