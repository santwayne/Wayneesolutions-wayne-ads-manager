import { query } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { syncAdAccount } from '../meta/sync.js';
import { graphForAdAccount } from '../meta/tokens.js';
import { runRulesForAccount } from '../rules/runner.js';
import { processLead, retryCrm, triggerWayneRing, pollForms, syncExclusionAudience } from '../leads/pipeline.js';
import { runWeekly } from '../reports/weekly.js';
import { checkWallet, debitDailySpend, issueMonthlyInvoice } from '../wallet/service.js';
import { handleInbound, followupTimeout } from '../whatsapp-mode/conversation.js';
import { executeDeletion } from '../webhooks/meta.js';
import { notifyOwner } from '../notify/whatsapp.js';
import { enqueue } from './queues.js';
import { sendCrmStage } from '../leads/capi.js';
import { flushHubEvents } from '../hub/events.js';
import { syncGoogleAccount } from '../google/ads.js';

const activeAccounts = async () => (await query("SELECT * FROM ad_accounts WHERE status = 'active'")).rows;
const businessOrgs = async (where = '') => (await query(`SELECT * FROM orgs WHERE type = 'business' ${where}`)).rows;

/** Website campaigns: pixel last_fired_time for the "tracking toota" rule. */
async function refreshPixel(acc) {
  if (!acc.pixel_id) return;
  try {
    const g = await graphForAdAccount(acc);
    const p = await g.get(acc.pixel_id, { fields: 'last_fired_time' });
    if (p.last_fired_time) await query('UPDATE ad_accounts SET pixel_last_fired_at = $2 WHERE id = $1', [acc.id, p.last_fired_time]);
  } catch (e) { logger.warn({ err: e.message }, 'pixel refresh failed'); }
}

export const handlers = {
  sync: {
    // Every 4h (spec: 3–6h): fan out one job per account.
    'sync-all': async () => { for (const a of await activeAccounts()) await enqueue('sync', 'sync-account', { adAccountId: a.id }, { jobId: `sync-${a.id}-${Math.floor(Date.now() / 3.6e6)}` }); },
    'sync-account': async ({ adAccountId }) => {
      const { rows: [acc] } = await query('SELECT * FROM ad_accounts WHERE id = $1', [adAccountId]);
      try {
        await syncAdAccount(adAccountId, {});
        await refreshPixel(acc);
        await checkWallet(acc.org_id);
      } catch (e) {
        if (/token expired|reconnect/i.test(e.message)) await notifyOwner(acc.org_id, '🔌 Meta connection toot gaya hai. Ads data update nahi ho raha — app mein "Meta reconnect" dabayein.');
        throw e;
      }
    },
    'data-deletion': async ({ code }) => executeDeletion(code),
    'google-sync-all': async () => { for (const g of (await query('SELECT id FROM google_accounts')).rows) await enqueue('sync', 'google-sync', { googleAccountId: g.id }); },
    'google-sync': async ({ googleAccountId }) => syncGoogleAccount(googleAccountId),
    'hub-flush': async () => flushHubEvents(),
  },
  rules: {
    'rules-all': async () => { for (const a of await activeAccounts()) await enqueue('rules', 'rules-account', { adAccountId: a.id }); },
    'rules-account': async ({ adAccountId }) => { const { rows: [a] } = await query('SELECT * FROM ad_accounts WHERE id = $1', [adAccountId]); return runRulesForAccount(a); },
    // Lead follow-up is time critical (15 min): checked every 5 min, only that rule.
    'followup-check': async () => { for (const a of await activeAccounts()) await runRulesForAccount(a, { only: ['lead_followup'] }); },
  },
  leads: {
    'process-lead': async (d) => processLead(d),
    'crm-retry': async ({ leadId }) => retryCrm(leadId),
    'wayne-ring': async ({ leadId }) => triggerWayneRing(leadId),
    'poll-forms': async () => pollForms(),
    capi: async ({ leadId }) => sendCrmStage(leadId),
    'audience-sync': async ({ adAccountId, orgId }) => {
      const ids = adAccountId ? [adAccountId] : (await query('SELECT id FROM ad_accounts WHERE org_id = $1', [orgId])).rows.map((r) => r.id);
      for (const id of ids) await syncExclusionAudience(id);
    },
  },
  reports: {
    'weekly-all': async () => { for (const o of await businessOrgs()) await enqueue('reports', 'weekly-org', { orgId: o.id }); },
    'weekly-org': async ({ orgId }) => runWeekly(orgId),
  },
  wallet: {
    'daily-debit': async () => { for (const o of await businessOrgs("AND payment_model = 'B'")) { await debitDailySpend(o.id); await checkWallet(o.id); } },
    'monthly-invoices': async () => {
      const d = new Date(); const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
      for (const o of await businessOrgs("AND payment_model = 'B'")) await issueMonthlyInvoice(o.id, prev);
    },
  },
  whatsapp: {
    inbound: async (m) => handleInbound(m),
    'followup-timeout': async (d) => followupTimeout(d),
  },
};

/** Repeatable schedules (IST). */
export const SCHEDULES = [
  { queue: 'sync', name: 'sync-all', pattern: '0 */4 * * *' },
  { queue: 'sync', name: 'google-sync-all', pattern: '20 */4 * * *' },
  { queue: 'sync', name: 'hub-flush', pattern: '*/2 * * * *' },
  { queue: 'rules', name: 'rules-all', pattern: '15 * * * *' },
  { queue: 'rules', name: 'followup-check', pattern: '*/5 * * * *' },
  { queue: 'leads', name: 'poll-forms', pattern: '*/15 * * * *' },
  { queue: 'reports', name: 'weekly-all', pattern: '0 9 * * 1' },       // Monday 9:00
  { queue: 'wallet', name: 'daily-debit', pattern: '30 6 * * *' },      // after Meta finalises yesterday
  { queue: 'wallet', name: 'monthly-invoices', pattern: '0 8 1 * *' },
];
