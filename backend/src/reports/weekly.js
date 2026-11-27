import { query } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { weeklyRecommendations } from '../ai/service.js';
import { logAction } from '../actions/service.js';
import { notifyOwner } from '../notify/whatsapp.js';
import { weeklyReport } from '../notify/format.js';
import { objectPerformance, totals } from './metrics.js';

const mondayOf = (d = new Date()) => { const x = new Date(d); const day = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - day); return x.toISOString().slice(0, 10); };

/** Every Monday: AI recommendations per ad account + Hinglish WhatsApp report to owner. */
export async function runWeekly(orgId) {
  const { rows: [org] } = await query('SELECT * FROM orgs WHERE id = $1', [orgId]);
  const { rows: accounts } = await query("SELECT * FROM ad_accounts WHERE org_id = $1 AND status = 'active'", [orgId]);
  const last7 = await totals(orgId, { days: 7 });
  const last30 = await totals(orgId, { days: 30 });
  const objects = [...await objectPerformance(orgId, 'campaign'), ...await objectPerformance(orgId, 'adset'), ...await objectPerformance(orgId, 'ad')];
  let actions = [];
  for (const acc of accounts) {
    try {
      const rec = await weeklyRecommendations({ sector: acc.sector_template, businessName: org.name, targetCpl: acc.target_cpl, last7, last30, objects });
      await query(
        `INSERT INTO recommendations (org_id, ad_account_id, week_start, payload) VALUES ($1,$2,$3,$4)
         ON CONFLICT (ad_account_id, week_start) DO UPDATE SET payload = EXCLUDED.payload, created_at = now()`,
        [orgId, acc.id, mondayOf(), JSON.stringify(rec)]);
      await logAction({ orgId, who: 'ai', source: 'ai', what: 'ai_recommendations', after: { adAccount: acc.meta_account_id, actions: rec.actions } });
      actions = actions.concat(rec.actions);
    } catch (e) { logger.error({ err: e.message, acc: acc.meta_account_id }, 'weekly AI failed'); }
  }
  const crmLinked = last7.won > 0 || (await query("SELECT 1 FROM leads WHERE org_id = $1 AND crm_lead_id IS NOT NULL LIMIT 1", [orgId])).rows.length > 0;
  const body = weeklyReport({ businessName: org.name, spend: last7.spend, leads: last7.leads, won: crmLinked ? last7.won : null, actions });
  await notifyOwner(orgId, body);
  return { body, actions };
}
