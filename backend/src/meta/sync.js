import { config } from '../config.js';
import { query, tx } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { createGraphClient } from './graph.js';
import { graphForAdAccount } from './tokens.js';
import { insightRow } from './results.js';

export const INSIGHT_FIELDS = 'date_start,spend,impressions,reach,frequency,clicks,ctr,cpc,actions,campaign_id,adset_id,ad_id,account_id';
const LEVEL_ID = { account: 'account_id', campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id' };

/** Agency mode: list every ad account Wayne's BM can see (owned + partner/client). */
export async function listBusinessAdAccounts() {
  const g = createGraphClient({ token: config.meta.systemUserToken });
  const fields = 'id,account_id,name,currency,timezone_name,account_status';
  const [owned, client] = await Promise.all([
    g.getAll(`${config.meta.businessId}/owned_ad_accounts`, { fields }),
    g.getAll(`${config.meta.businessId}/client_ad_accounts`, { fields }),
  ]);
  const seen = new Map();
  for (const a of [...owned, ...client]) seen.set(a.id, { ...a, access: owned.includes(a) ? 'owned' : 'partner' });
  return [...seen.values()];
}

// Meta returns budgets in the account currency's minor unit (paise for INR).
export const fromMinor = (v) => (v == null ? null : Number(v) / 100);
export const toMinor = (rupees) => Math.round(Number(rupees) * 100);

export async function syncStructure(adAccount, g) {
  const act = adAccount.meta_account_id;
  const [campaigns, adsets, ads] = await Promise.all([
    g.getAll(`${act}/campaigns`, { fields: 'id,name,status,effective_status,objective,daily_budget,special_ad_categories' }),
    g.getAll(`${act}/adsets`, { fields: 'id,name,status,effective_status,campaign_id,optimization_goal,destination_type,daily_budget,targeting,learning_stage_info' }),
    g.getAll(`${act}/ads`, { fields: 'id,name,status,effective_status,adset_id,creative{id},ad_review_feedback' }),
  ]);

  await tx(async (c) => {
    const campIds = new Map();
    for (const x of campaigns) {
      const { rows } = await c.query(
        `INSERT INTO campaigns (org_id, ad_account_id, meta_id, name, status, effective_status, objective, daily_budget, special_ad_categories)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (meta_id) DO UPDATE SET name=EXCLUDED.name, status=EXCLUDED.status, effective_status=EXCLUDED.effective_status,
           objective=EXCLUDED.objective, daily_budget=EXCLUDED.daily_budget, special_ad_categories=EXCLUDED.special_ad_categories, updated_at=now()
         RETURNING id`,
        [adAccount.org_id, adAccount.id, x.id, x.name, x.status, x.effective_status, x.objective, fromMinor(x.daily_budget), x.special_ad_categories || []],
      );
      campIds.set(x.id, rows[0].id);
    }
    const setIds = new Map();
    for (const x of adsets) {
      const campaignId = campIds.get(x.campaign_id);
      if (!campaignId) continue;
      const { rows } = await c.query(
        `INSERT INTO adsets (org_id, campaign_id, meta_id, name, status, effective_status, optimization_goal, destination_type, daily_budget, targeting, learning_stage)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (meta_id) DO UPDATE SET name=EXCLUDED.name, status=EXCLUDED.status, effective_status=EXCLUDED.effective_status,
           optimization_goal=EXCLUDED.optimization_goal, destination_type=EXCLUDED.destination_type, daily_budget=EXCLUDED.daily_budget,
           targeting=EXCLUDED.targeting, learning_stage=EXCLUDED.learning_stage, updated_at=now()
         RETURNING id`,
        [adAccount.org_id, campaignId, x.id, x.name, x.status, x.effective_status, x.optimization_goal, x.destination_type,
          fromMinor(x.daily_budget), x.targeting || null, x.learning_stage_info?.status || null],
      );
      setIds.set(x.id, rows[0].id);
    }
    for (const x of ads) {
      const adsetId = setIds.get(x.adset_id);
      if (!adsetId) continue;
      await c.query(
        `INSERT INTO ads (org_id, adset_id, meta_id, name, status, effective_status, review_feedback)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (meta_id) DO UPDATE SET name=EXCLUDED.name, status=EXCLUDED.status, effective_status=EXCLUDED.effective_status,
           review_feedback=EXCLUDED.review_feedback, updated_at=now()`,
        [adAccount.org_id, adsetId, x.id, x.name, x.status, x.effective_status, x.ad_review_feedback || null],
      );
    }
  });
  return { campaigns: campaigns.length, adsets: adsets.length, ads: ads.length };
}

export async function upsertInsights(orgId, level, rows) {
  if (!rows.length) return 0;
  await tx(async (c) => {
    for (const r of rows) {
      const m = insightRow(r);
      const objectId = level === 'account' ? `act_${r.account_id}` : r[LEVEL_ID[level]];
      if (!objectId) continue;
      await c.query(
        `INSERT INTO insights_daily (org_id, level, object_id, date, spend, impressions, reach, frequency, clicks, ctr, cpc, leads, cpl, raw_actions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (level, object_id, date) DO UPDATE SET spend=EXCLUDED.spend, impressions=EXCLUDED.impressions, reach=EXCLUDED.reach,
           frequency=EXCLUDED.frequency, clicks=EXCLUDED.clicks, ctr=EXCLUDED.ctr, cpc=EXCLUDED.cpc, leads=EXCLUDED.leads, cpl=EXCLUDED.cpl,
           raw_actions=EXCLUDED.raw_actions`,
        [orgId, level, objectId, m.date, m.spend, m.impressions, m.reach, m.frequency, m.clicks, m.ctr, m.cpc, m.leads, m.cpl, JSON.stringify(m.raw_actions)],
      );
    }
  });
  return rows.length;
}

const ymd = (d) => d.toISOString().slice(0, 10);

/** Regular sync: last `days` days (Meta restates recent days, so re-pull a window). */
export async function syncInsights(adAccount, g, { days = 3 } = {}) {
  const until = new Date();
  const since = new Date(Date.now() - (days - 1) * 86400_000);
  const time_range = { since: ymd(since), until: ymd(until) };
  let n = 0;
  for (const level of ['account', 'campaign', 'adset', 'ad']) {
    const rows = await g.getAll(`${adAccount.meta_account_id}/insights`, { level, time_increment: 1, time_range, fields: INSIGHT_FIELDS });
    n += await upsertInsights(adAccount.org_id, level, rows);
  }
  return n;
}

/** History backfill (once per account): big ranges go through async report jobs. */
export async function backfillInsights(adAccount, g, { days = 90 } = {}) {
  const time_range = { since: ymd(new Date(Date.now() - days * 86400_000)), until: ymd(new Date()) };
  let n = 0;
  for (const level of ['account', 'campaign', 'adset', 'ad']) {
    const rows = await g.asyncInsights(adAccount.meta_account_id, { level, time_increment: 1, time_range, fields: INSIGHT_FIELDS });
    n += await upsertInsights(adAccount.org_id, level, rows);
  }
  await query('UPDATE ad_accounts SET backfilled_at = now() WHERE id = $1', [adAccount.id]);
  return n;
}

export async function syncAdAccount(adAccountId, { graph } = {}) {
  const { rows } = await query('SELECT * FROM ad_accounts WHERE id = $1', [adAccountId]);
  const acc = rows[0];
  if (!acc) throw new Error('ad account not found');
  if (acc.meta_account_id.startsWith('act_demo')) return { structure: null, insights: 0 }; // demo data is seeded, never synced
  const g = graph || await graphForAdAccount(acc);
  const structure = await syncStructure(acc, g);
  const insights = acc.backfilled_at ? await syncInsights(acc, g) : await backfillInsights(acc, g);
  await query('UPDATE ad_accounts SET last_synced_at = now() WHERE id = $1', [acc.id]);
  logger.info({ adAccount: acc.meta_account_id, ...structure, insights }, 'ad account synced');
  return { structure, insights };
}
