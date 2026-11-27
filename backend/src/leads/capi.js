import { query } from '../lib/db.js';
import { graphForAdAccount } from '../meta/tokens.js';

/**
 * Conversions API for CRM (spec leads loop step 7): send CRM stage changes back to Meta
 * so it optimises for real customers ("conversion leads"), not cheap leads.
 * Event = CRM stage name, matched on Meta's lead_id. Needs ad_accounts.capi_dataset_id
 * (the dataset/pixel connected to the CRM in Events Manager).
 * Only works if the client's team marks leads in the CRM — teach this in onboarding.
 */
const STAGE_EVENT = { contacted: 'Contacted', qualified: 'Qualified', consultation_booked: 'Consultation Booked', won: 'Converted', lost: 'Lost', junk: 'Junk' };

let graphFactory = graphForAdAccount;
export function setCapiGraphFactory(fn) { graphFactory = fn; }

export function buildCrmEvent(lead, status, now = new Date()) {
  return {
    event_name: STAGE_EVENT[status],
    event_time: Math.floor(now.getTime() / 1000),
    action_source: 'system_generated',
    user_data: { lead_id: Number(lead.meta_lead_id) || lead.meta_lead_id },
    custom_data: { event_source: 'crm', lead_event_source: 'Loopdesk AI Jobs' },
  };
}

export async function sendCrmStage(leadId) {
  const { rows: [lead] } = await query('SELECT * FROM leads WHERE id = $1', [leadId]);
  if (!lead || !STAGE_EVENT[lead.status]) return { skipped: true };
  const { rows: [acc] } = await query('SELECT * FROM ad_accounts WHERE org_id = $1 AND page_id = $2 AND capi_dataset_id IS NOT NULL LIMIT 1', [lead.org_id, lead.page_id]);
  if (!acc) return { skipped: 'no_dataset' };
  const g = await graphFactory(acc);
  const r = await g.post(`${acc.capi_dataset_id}/events`, { data: [buildCrmEvent(lead, lead.status)] });
  await query('UPDATE leads SET capi_sent_status = $2, capi_sent_at = now() WHERE id = $1', [lead.id, lead.status]);
  return { sent: r.events_received ?? 1 };
}
