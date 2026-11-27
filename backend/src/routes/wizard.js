import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { badRequest } from '../lib/errors.js';
import { requireOrg } from '../lib/auth.js';
import { ah, parse, actorOf } from './util.js';
import { listTemplates, getTemplate } from '../wizard/templates/index.js';
import { GOALS } from '../wizard/goals.js';
import { createDraft, updateDraft, validate, createOnMeta, uploadMedia, getDraftContext } from '../wizard/service.js';
import { analyzeImage } from '../wizard/media.js';
import { generateCopy, imageTextHeavy } from '../ai/service.js';
import { launchCampaign, logAction } from '../actions/service.js';

export const wizard = Router();

wizard.get('/wizard/templates', (_req, res) => res.json({ templates: listTemplates(), goals: Object.entries(GOALS).map(([key, g]) => ({ key, label: g.label })) }));

wizard.post('/orgs/:orgId/drafts', requireOrg('manager'), ah(async (req, res) => {
  const b = parse(z.object({ adAccountId: z.number().int(), data: z.record(z.any()).default({}) }), req.body);
  res.status(201).json(await createDraft(req.org.id, b));
}));

wizard.get('/orgs/:orgId/drafts/:id', requireOrg('viewer'), ah(async (req, res) => {
  const { draft } = await getDraftContext(req.org.id, Number(req.params.id));
  res.json(draft);
}));

wizard.patch('/orgs/:orgId/drafts/:id', requireOrg('manager'), ah(async (req, res) => {
  const patch = { ...req.body };
  for (const k of Object.keys(patch)) if (k.startsWith('_')) delete patch[k]; // internal keys
  res.json(await updateDraft(req.org.id, Number(req.params.id), patch));
}));

// Live checklist (every screen calls this): warnings + fix buttons.
wizard.get('/orgs/:orgId/drafts/:id/validate', requireOrg('viewer'), ah(async (req, res) => {
  res.json(await validate(req.org.id, Number(req.params.id), { withReach: req.query.reach !== '0' }));
}));

// Screen 5: AI writes 5 primary texts + 3 headlines.
wizard.post('/orgs/:orgId/drafts/:id/copy', requireOrg('manager'), ah(async (req, res) => {
  const { draft, org } = await getDraftContext(req.org.id, Number(req.params.id));
  const d = draft.data;
  if (!d.offer) throw badRequest('Pehle offer likho');
  const out = await generateCopy({ sector: d.sector, offer: d.offer, language: d.language || getTemplate(d.sector).language, businessName: d.businessName || org.name, area: d.location?.label, goal: d.goal });
  await logAction({ orgId: req.org.id, who: 'ai', source: 'ai', what: 'ai_decision', after: { step: 'generate_copy', draftId: draft.id, count: out.primaryTexts.length } });
  res.json(out);
}));

// Screen 5: media upload. Images as raw bytes; videos by URL (e.g. from AI Video Studio).
wizard.post('/orgs/:orgId/drafts/:id/media', requireOrg('manager'), express.raw({ type: ['image/*'], limit: '30mb' }), ah(async (req, res) => {
  const { draft, adAccount } = await getDraftContext(req.org.id, Number(req.params.id));
  let item;
  if (Buffer.isBuffer(req.body) && req.body.length) {
    const qa = await analyzeImage(req.body);
    const textHeavy = await imageTextHeavy({ base64: req.body.toString('base64'), mediaType: req.get('content-type') });
    const up = await uploadMedia(adAccount, { type: 'image', base64: req.body.toString('base64') });
    item = { type: 'image', ...qa, textHeavy, ...up };
  } else {
    const b = parse(z.object({ type: z.literal('video'), fileUrl: z.string().url(), width: z.number().int(), height: z.number().int(), durationSec: z.number(), thumbnailUrl: z.string().url() }), req.body);
    const up = await uploadMedia(adAccount, { type: 'video', fileUrl: b.fileUrl });
    item = { type: 'video', width: b.width, height: b.height, durationSec: b.durationSec, thumbnailUrl: b.thumbnailUrl, url: b.fileUrl, ...up };
  }
  const media = [...(draft.data.media || []), item].slice(0, 5);
  await updateDraft(req.org.id, draft.id, { media });
  res.status(201).json({ item, media });
}));

wizard.delete('/orgs/:orgId/drafts/:id/media/:index', requireOrg('manager'), ah(async (req, res) => {
  const { draft } = await getDraftContext(req.org.id, Number(req.params.id));
  const media = (draft.data.media || []).filter((_, i) => i !== Number(req.params.index));
  await updateDraft(req.org.id, draft.id, { media });
  res.json({ media });
}));

// Screen 7: Create (paused) -> then Launch.
wizard.post('/orgs/:orgId/drafts/:id/create', requireOrg('manager'), ah(async (req, res) => {
  res.status(201).json(await createOnMeta(req.org.id, Number(req.params.id), actorOf(req)));
}));

wizard.post('/orgs/:orgId/campaigns/:metaId/launch', requireOrg('manager'), ah(async (req, res) => {
  res.json(await launchCampaign({ orgId: req.org.id, campaignMetaId: req.params.metaId, actor: actorOf(req) }));
}));

wizard.get('/orgs/:orgId/drafts', requireOrg('viewer'), ah(async (req, res) => {
  const { rows } = await query('SELECT id, channel, status, data->>\'sector\' AS sector, data->>\'offer\' AS offer, campaign_id, updated_at FROM wizard_drafts WHERE org_id = $1 ORDER BY updated_at DESC LIMIT 50', [req.org.id]);
  res.json(rows);
}));
