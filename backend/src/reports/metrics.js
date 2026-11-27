import { query } from '../lib/db.js';

/** Spend/leads/CPL + CRM customers for an org (optionally one ad account) over N days. */
export async function totals(orgId, { days = 7, adAccountMetaId = null, offsetDays = 0 } = {}) {
  const { rows: [r] } = await query(
    `SELECT COALESCE(SUM(spend),0) AS spend, COALESCE(SUM(leads),0) AS leads, COALESCE(SUM(impressions),0) AS impressions, COALESCE(SUM(clicks),0) AS clicks
     FROM insights_daily WHERE org_id = $1 AND level = 'account' AND ($2::text IS NULL OR object_id = $2)
       AND date > CURRENT_DATE - ($3::int + $4::int) AND date <= CURRENT_DATE - $4::int`,
    [orgId, adAccountMetaId, days, offsetDays]);
  const { rows: [l] } = await query(
    `SELECT COUNT(*) FILTER (WHERE status = 'won') AS won, COUNT(*) FILTER (WHERE out_of_area) AS out_of_area, COUNT(*) AS crm_leads
     FROM leads WHERE org_id = $1 AND created_at > now() - make_interval(days => $2::int + $3::int) AND created_at <= now() - make_interval(days => $3::int)`,
    [orgId, days, offsetDays]);
  const spend = Number(r.spend); const leads = Number(r.leads); const won = Number(l.won);
  return {
    spend, leads, impressions: Number(r.impressions), clicks: Number(r.clicks),
    cpl: leads ? Math.round(spend / leads) : null,
    won, costPerCustomer: won ? Math.round(spend / won) : null,
    outOfAreaPct: Number(l.crm_leads) ? Math.round((Number(l.out_of_area) / Number(l.crm_leads)) * 100) : 0,
  };
}

/** Per-object performance for the last N days (for dashboard tables + AI). */
export async function objectPerformance(orgId, level, days = 7) {
  const table = { campaign: 'campaigns', adset: 'adsets', ad: 'ads' }[level];
  const { rows } = await query(
    `SELECT o.meta_id AS "objectId", o.name, o.status, o.effective_status AS "effectiveStatus",
       ${level === 'campaign' ? 'o.launched_at IS NOT NULL AS launched, o.created_by_wizard AS "createdByWizard",' : ''}
       COALESCE(SUM(i.spend),0) AS spend, COALESCE(SUM(i.leads),0) AS leads, COALESCE(SUM(i.impressions),0) AS impressions,
       COALESCE(SUM(i.clicks),0) AS clicks, MAX(i.frequency) AS frequency
     FROM ${table} o LEFT JOIN insights_daily i ON i.object_id = o.meta_id AND i.date > CURRENT_DATE - $3::int
     WHERE o.org_id = $1 GROUP BY o.id ORDER BY spend DESC LIMIT $2`, [orgId, 200, days]);
  return rows.map((r) => ({ ...r, level, spend: Number(r.spend), leads: Number(r.leads), cpl: Number(r.leads) ? Math.round(Number(r.spend) / Number(r.leads)) : null }));
}

/**
 * Agency dashboard health: green / yellow / red.
 *  red: critical open alert, or CPL > 1.5x target, or delivery stopped
 *  yellow: any open warning, CPL > target, or out-of-area > 15%
 */
export function healthScore({ openCritical, openWarnings, cpl, targetCpl, outOfAreaPct }) {
  if (openCritical > 0 || (targetCpl && cpl && cpl > targetCpl * 1.5)) return 'red';
  if (openWarnings > 0 || (targetCpl && cpl && cpl > targetCpl) || outOfAreaPct > 15) return 'yellow';
  return 'green';
}

export async function agencyOverview(userId) {
  const { rows: orgs } = await query(
    `SELECT o.id, o.name, o.payment_model, m.role,
       (SELECT MIN(target_cpl) FROM ad_accounts a WHERE a.org_id = o.id) AS target_cpl,
       (SELECT COUNT(*) FROM alerts al WHERE al.org_id = o.id AND al.status = 'open' AND al.severity = 'critical') AS critical,
       (SELECT COUNT(*) FROM alerts al WHERE al.org_id = o.id AND al.status = 'open' AND al.severity <> 'critical') AS warnings,
       (SELECT balance FROM wallets w WHERE w.org_id = o.id) AS wallet_balance
     FROM orgs o JOIN memberships m ON m.org_id = o.id AND m.user_id = $1 WHERE o.type = 'business' ORDER BY o.name`, [userId]);
  const out = [];
  for (const o of orgs) {
    const t = await totals(o.id, { days: 7 });
    const health = healthScore({ openCritical: Number(o.critical), openWarnings: Number(o.warnings), cpl: t.cpl, targetCpl: o.target_cpl && Number(o.target_cpl), outOfAreaPct: t.outOfAreaPct });
    out.push({ ...o, critical: Number(o.critical), warnings: Number(o.warnings), wallet_balance: o.wallet_balance == null ? null : Number(o.wallet_balance), last7: t, health });
  }
  const rank = { red: 0, yellow: 1, green: 2 };
  return out.sort((a, b) => rank[a.health] - rank[b.health] || b.critical - a.critical);
}
