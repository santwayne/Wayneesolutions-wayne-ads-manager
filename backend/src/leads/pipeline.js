import crypto from 'node:crypto';
import { query } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { graphForAdAccount } from '../meta/tokens.js';
import { crmUpsertLead, wayneRingCall } from './integrations.js';
import { enqueue } from '../jobs/queues.js';

let graphFactory = graphForAdAccount;
export function setLeadsGraphFactory(fn) { graphFactory = fn; }

const FIELD_ALIASES = {
  name: ['full_name', 'name', 'first_name'],
  phone: ['phone_number', 'phone', 'mobile'],
  email: ['email'],
  city: ['city'],
  pincode: ['post_code', 'zip_code', 'zip', 'postal_code', 'pincode'],
};

export function parseFieldData(fieldData = []) {
  const map = Object.fromEntries(fieldData.map((f) => [f.name, Array.isArray(f.values) ? f.values.join(', ') : f.values]));
  const pick = (k) => FIELD_ALIASES[k].map((a) => map[a]).find(Boolean) || null;
  const known = new Set(Object.values(FIELD_ALIASES).flat());
  const answers = Object.fromEntries(Object.entries(map).filter(([k]) => !known.has(k)));
  return { name: pick('name'), phone: normalisePhone(pick('phone')), email: pick('email'), city: pick('city'), pincode: (pick('pincode') || '').replace(/\D/g, '') || null, answers };
}

export function normalisePhone(p) {
  if (!p) return null;
  const d = String(p).replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 12 && d.startsWith('91')) return d;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  return d || null;
}

/**
 * Out of area: lead pincode not in the account's service pincodes (Meta location is only
 * "living in or recently in" and VPN users leak through — we tag, we can't fully block).
 */
export function isOutOfArea(lead, servicePincodes = []) {
  if (lead.phone && !lead.phone.startsWith('91')) return true;
  if (!servicePincodes.length || !lead.pincode) return false;
  return !servicePincodes.includes(lead.pincode);
}

async function adAccountForPage(orgId, pageId) {
  const { rows } = await query('SELECT * FROM ad_accounts WHERE page_id = $1 AND ($2::bigint IS NULL OR org_id = $2) ORDER BY id LIMIT 1', [pageId, orgId]);
  return rows[0] || null;
}

/** Steps 2–4 of the leads loop for one leadgen_id. Idempotent on meta_lead_id. */
export async function processLead({ leadgenId, pageId, formId, orgId = null }) {
  const existing = await query('SELECT * FROM leads WHERE meta_lead_id = $1', [leadgenId]);
  if (existing.rows[0]?.crm_lead_id) return { duplicate: true, lead: existing.rows[0] };

  const acc = await adAccountForPage(orgId, pageId);
  if (!acc) { logger.warn({ pageId }, 'lead for unknown page'); return { skipped: true }; }
  const g = await graphFactory(acc);
  const raw = await g.get(leadgenId, { fields: 'id,created_time,field_data,ad_id,adset_id,campaign_id,form_id,platform,is_organic' });
  const f = parseFieldData(raw.field_data);
  const outOfArea = isOutOfArea(f, acc.service_area_pincodes);

  // Duplicate phone = same lead: reuse the CRM lead id of the earlier record.
  const dup = f.phone ? (await query('SELECT crm_lead_id FROM leads WHERE org_id = $1 AND phone = $2 AND crm_lead_id IS NOT NULL ORDER BY id LIMIT 1', [acc.org_id, f.phone])).rows[0] : null;

  const { rows } = await query(
    `INSERT INTO leads (org_id, meta_lead_id, ad_id, adset_id, campaign_id, form_id, page_id, name, phone, email, city, pincode, answers, out_of_area, meta_created_at, crm_lead_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (meta_lead_id) DO UPDATE SET updated_at = now() RETURNING *`,
    [acc.org_id, leadgenId, raw.ad_id, raw.adset_id, raw.campaign_id, raw.form_id || formId, pageId, f.name, f.phone, f.email, f.city, f.pincode,
      JSON.stringify(f.answers), outOfArea, raw.created_time || null, dup?.crm_lead_id || null],
  );
  let lead = rows[0];

  if (!lead.crm_lead_id) {
    try {
      const { crmLeadId } = await crmUpsertLead(acc.org_id, lead);
      lead = (await query('UPDATE leads SET crm_lead_id = $1, updated_at = now() WHERE id = $2 RETURNING *', [crmLeadId, lead.id])).rows[0];
    } catch (e) {
      logger.error({ err: e.message, leadId: lead.id }, 'CRM upsert failed — will retry');
      await enqueue('leads', 'crm-retry', { leadId: lead.id }, { delay: 60_000, attempts: 10, backoff: { type: 'exponential', delay: 60_000 } });
    }
  }

  // WayneRing AI call within 2 min — never for out-of-area leads.
  const { rows: orgRows } = await query('SELECT ai_call_enabled FROM orgs WHERE id = $1', [acc.org_id]);
  if (orgRows[0]?.ai_call_enabled && !outOfArea && lead.phone && !dup) {
    await enqueue('leads', 'wayne-ring', { leadId: lead.id }, { attempts: 3 });
  }
  if (outOfArea) await enqueue('leads', 'audience-sync', { adAccountId: acc.id }, { jobId: `aud-${acc.id}`, delay: 10 * 60_000 });
  return { lead };
}

export async function retryCrm(leadId) {
  const { rows } = await query('SELECT * FROM leads WHERE id = $1', [leadId]);
  const lead = rows[0];
  if (!lead || lead.crm_lead_id) return;
  const { crmLeadId } = await crmUpsertLead(lead.org_id, lead);
  await query('UPDATE leads SET crm_lead_id = $1, updated_at = now() WHERE id = $2', [crmLeadId, lead.id]);
}

export async function triggerWayneRing(leadId) {
  const { rows } = await query('SELECT l.*, a.sector_template FROM leads l LEFT JOIN ad_accounts a ON a.page_id = l.page_id WHERE l.id = $1', [leadId]);
  const lead = rows[0];
  if (!lead) return;
  await wayneRingCall(lead.org_id, lead, { sector: lead.sector_template, answers: lead.answers, source: 'meta_lead_ad' });
}

/** Step 5: CRM stage changed -> our leads table (feeds cost per customer). */
const STAGE_MAP = { contacted: 'contacted', qualified: 'qualified', consultation_booked: 'consultation_booked', booked: 'consultation_booked', won: 'won', lost: 'lost', junk: 'junk' };
export async function applyCrmStage({ crmLeadId, stage, contactedAt }) {
  const status = STAGE_MAP[String(stage).toLowerCase()];
  if (!status) return { ignored: true };
  const { rows } = await query(
    `UPDATE leads SET status = $2, first_contact_at = COALESCE(first_contact_at, $3::timestamptz, CASE WHEN $2 <> 'new' THEN now() END), updated_at = now()
     WHERE crm_lead_id = $1 RETURNING *`,
    [crmLeadId, status, contactedAt || null],
  );
  for (const l of rows) {
    if (status === 'junk') await enqueue('leads', 'audience-sync', { adAccountId: null, orgId: l.org_id }, { delay: 10 * 60_000 });
    // Phase 2: send qualified/won/lost back via Conversions API for CRM (leads/capi.js).
  }
  return { updated: rows.length };
}

/** Fallback: every 15 min poll each form for leads the webhook missed. */
export async function pollForms() {
  const { rows: forms } = await query('SELECT * FROM lead_forms');
  let found = 0;
  for (const form of forms) {
    const acc = await adAccountForPage(form.org_id, form.page_id);
    if (!acc) continue;
    try {
      const g = await graphFactory(acc);
      const since = Math.floor((form.last_polled_at ? new Date(form.last_polled_at).getTime() - 30 * 60_000 : Date.now() - 24 * 3600_000) / 1000);
      const leads = await g.getAll(`${form.meta_form_id}/leads`, { fields: 'id', filtering: [{ field: 'time_created', operator: 'GREATER_THAN', value: since }] }, 1000);
      for (const l of leads) {
        const exists = await query('SELECT 1 FROM leads WHERE meta_lead_id = $1', [l.id]);
        if (!exists.rows[0]) { await processLead({ leadgenId: l.id, pageId: form.page_id, formId: form.meta_form_id, orgId: form.org_id }); found++; }
      }
      await query('UPDATE lead_forms SET last_polled_at = now() WHERE id = $1', [form.id]);
    } catch (e) { logger.error({ err: e.message, form: form.meta_form_id }, 'form poll failed'); }
  }
  return { found };
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Out-of-area + junk leads -> custom audience, excluded in new ad sets. */
export async function syncExclusionAudience(adAccountId) {
  const { rows: accs } = await query('SELECT * FROM ad_accounts WHERE id = $1', [adAccountId]);
  const acc = accs[0];
  if (!acc) return;
  const g = await graphFactory(acc);
  let { rows: [aud] } = await query("SELECT * FROM exclusion_audiences WHERE ad_account_id = $1 AND kind = 'out_of_area_junk'", [acc.id]);
  if (!aud?.meta_id) {
    const r = await g.post(`${acc.meta_account_id}/customaudiences`, { name: 'Wayne | Out of area + junk leads', subtype: 'CUSTOM', description: 'Auto: exclude from targeting', customer_file_source: 'USER_PROVIDED_ONLY' });
    aud = (await query(
      `INSERT INTO exclusion_audiences (org_id, ad_account_id, meta_id) VALUES ($1,$2,$3)
       ON CONFLICT (ad_account_id, kind) DO UPDATE SET meta_id = EXCLUDED.meta_id RETURNING *`, [acc.org_id, acc.id, r.id])).rows[0];
  }
  const { rows: leads } = await query(
    "SELECT id, phone FROM leads WHERE org_id = $1 AND page_id = $2 AND (out_of_area OR status = 'junk') AND NOT audience_synced AND phone IS NOT NULL LIMIT 10000",
    [acc.org_id, acc.page_id],
  );
  if (!leads.length) return { added: 0 };
  await g.post(`${aud.meta_id}/users`, { payload: { schema: 'PHONE_SHA256', data: leads.map((l) => sha256(l.phone)) } });
  await query('UPDATE leads SET audience_synced = true WHERE id = ANY($1)', [leads.map((l) => l.id)]);
  await query('UPDATE exclusion_audiences SET size_sent = size_sent + $2, updated_at = now() WHERE id = $1', [aud.id, leads.length]);
  return { added: leads.length };
}
