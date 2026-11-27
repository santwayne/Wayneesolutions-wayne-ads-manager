import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Loopdesk AI Jobs (CRM-HCM) and WayneRing clients.
 * Endpoint paths are the integration contract in docs/INTEGRATIONS.md — the CRM and
 * WayneRing teams expose them (or adjust the paths here to the real ones).
 */
let impl = null;
export function setIntegrationsOverride(o) { impl = o; }

async function call(base, apiKey, method, path, body) {
  if (!base) throw new Error(`Integration base URL missing for ${path}`);
  const res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${json.message || ''}`);
  return json;
}

/** Create or merge lead in Jobs CRM. Duplicate phone = same lead (CRM upserts by phone). */
export async function crmUpsertLead(orgId, lead) {
  if (impl?.crmUpsertLead) return impl.crmUpsertLead(orgId, lead);
  const r = await call(config.crm.baseUrl, config.crm.apiKey, 'POST', '/integrations/ads/leads', {
    hub_business_ref: String(orgId),
    source: 'Meta',
    name: lead.name, phone: lead.phone, email: lead.email, city: lead.city, pincode: lead.pincode,
    tags: lead.out_of_area ? ['out of area'] : [],
    meta: { lead_id: lead.meta_lead_id, ad_id: lead.ad_id, adset_id: lead.adset_id, campaign_id: lead.campaign_id, form_id: lead.form_id },
    answers: lead.answers,
  });
  return { crmLeadId: String(r.id ?? r.lead_id ?? r.data?.id) };
}

/** WayneRing: AI call within 2 minutes of a new lead. */
export async function wayneRingCall(orgId, lead, context) {
  if (impl?.wayneRingCall) return impl.wayneRingCall(orgId, lead, context);
  return call(config.wayneRing.baseUrl, config.wayneRing.apiKey, 'POST', '/api/integrations/ads/call', {
    hub_business_ref: String(orgId), phone: lead.phone, name: lead.name, crm_lead_id: lead.crm_lead_id, context,
  });
}

export const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { logger.error({ err: e.message }, 'integration call failed'); return null; } };
