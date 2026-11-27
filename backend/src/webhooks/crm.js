import { Router } from 'express';
import { config } from '../config.js';
import { hmacSha256Hex, safeEqual } from '../lib/crypto.js';
import { applyCrmStage } from '../leads/pipeline.js';

/** Jobs CRM -> us: lead stage changed (consultation booked / won / lost / contacted). */
export const crmWebhooks = Router();

crmWebhooks.post('/crm/lead-stage', async (req, res, next) => {
  try {
    const sig = req.get('x-wayne-signature') || '';
    if (!config.crm.webhookSecret || !safeEqual(sig, hmacSha256Hex(config.crm.webhookSecret, req.rawBody || ''))) return res.sendStatus(401);
    const { crm_lead_id: crmLeadId, stage, contacted_at: contactedAt } = req.body || {};
    if (!crmLeadId || !stage) return res.status(400).json({ error: 'crm_lead_id and stage required' });
    return res.json(await applyCrmStage({ crmLeadId: String(crmLeadId), stage, contactedAt }));
  } catch (e) { return next(e); }
});
