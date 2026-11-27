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
import { generateCopy, imageTextHeavy, strengthenOffer } from '../ai/service.js';
import { launchCampaign, logAction } from '../actions/service.js';
import { listStudioVideos } from '../integrations/videoStudio.js';

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

// Screen 5: "Offer kamzor hai" -> AI writes 3 stronger offers to pick from.
wizard.post('/orgs/:orgId/drafts/:id/offer-ideas', requireOrg('manager'), ah(async (req, res) => {
  const { draft, org } = await getDraftContext(req.org.id, Number(req.params.id));
  const out = await strengthenOffer({ sector: draft.data.sector, offer: draft.data.offer, businessName: draft.data.businessName || org.name });
  await logAction({ orgId: req.org.id, who: 'ai', source: 'ai', what: 'ai_decision', after: { step: 'offer_ideas', draftId: draft.id, offers: out.offers } });
  res.json(out);
}));

// Screen 5: media. Images as raw bytes; video files as raw bytes (+ cover via /thumbnail);
// or a finished video by link (AI Video Studio).
const ASPECT_SIZE = { '9:16': [1080, 1920], '4:5': [1080, 1350], '1:1': [1080, 1080], '16:9': [1920, 1080] };
async function addMedia(orgId, draft, item) {
  const media = [...(draft.data.media || []), item].slice(0, 5);
  await updateDraft(orgId, draft.id, { media });
  return media;
}

wizard.post('/orgs/:orgId/drafts/:id/media', requireOrg('manager'), express.raw({ type: ['image/*'], limit: '30mb' }), ah(async (req, res) => {
  const { draft, adAccount } = await getDraftContext(req.org.id, Number(req.params.id));
  if ((draft.data.media || []).length >= 5) throw badRequest('Max 5 photo/video');
  let item;
  if (Buffer.isBuffer(req.body) && req.body.length) {
    const qa = await analyzeImage(req.body);
    const textHeavy = await imageTextHeavy({ base64: req.body.toString('base64'), mediaType: req.get('content-type') });
    const up = await uploadMedia(adAccount, { type: 'image', base64: req.body.toString('base64') });
    item = { type: 'image', ...qa, textHeavy, ...up };
  } else {
    const b = parse(z.object({
      type: z.literal('video'), fileUrl: z.string().url().refine((u) => u.startsWith('https://'), 'https link chahiye'),
      width: z.number().int().optional(), height: z.number().int().optional(), aspect: z.enum(['9:16', '4:5', '1:1', '16:9']).optional(),
      durationSec: z.number().optional(), thumbnailUrl: z.string().url().optional(), source: z.enum(['link', 'video_studio']).default('link'), title: z.string().optional(),
    }), req.body);
    const [w, h] = b.width && b.height ? [b.width, b.height] : ASPECT_SIZE[b.aspect] || [null, null];
    const up = await uploadMedia(adAccount, { type: 'video', fileUrl: b.fileUrl, name: b.title });
    item = { type: 'video', width: w, height: h, durationSec: b.durationSec ?? null, thumbnailUrl: b.thumbnailUrl || null, url: b.fileUrl, source: b.source, ...up };
  }
  res.status(201).json({ item, media: await addMedia(req.org.id, draft, item) });
}));

// Video file from the computer/phone. The browser reads width/height/duration and sends them.
wizard.post('/orgs/:orgId/drafts/:id/media/video', requireOrg('manager'), express.raw({ type: ['video/*', 'application/octet-stream'], limit: '200mb' }), ah(async (req, res) => {
  const { draft, adAccount } = await getDraftContext(req.org.id, Number(req.params.id));
  if ((draft.data.media || []).length >= 5) throw badRequest('Max 5 photo/video');
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('Video file khaali hai');
  const q = parse(z.object({ width: z.coerce.number().int().positive(), height: z.coerce.number().int().positive(), duration: z.coerce.number().positive(), name: z.string().max(120).optional() }), req.query);
  const up = await uploadMedia(adAccount, { type: 'video', buffer: req.body, mimeType: req.get('content-type'), name: q.name || 'Wayne video' });
  const item = { type: 'video', width: q.width, height: q.height, durationSec: q.duration, sizeMb: Math.round((req.body.length / 1e6) * 10) / 10, source: 'upload', ...up };
  res.status(201).json({ item, media: await addMedia(req.org.id, draft, item) });
}));

// Cover photo for a video (browser grabs a frame; or the owner picks a photo).
wizard.post('/orgs/:orgId/drafts/:id/media/:index/thumbnail', requireOrg('manager'), express.raw({ type: ['image/*'], limit: '10mb' }), ah(async (req, res) => {
  const { draft, adAccount } = await getDraftContext(req.org.id, Number(req.params.id));
  const media = [...(draft.data.media || [])];
  const i = Number(req.params.index);
  if (media[i]?.type !== 'video') throw badRequest('Ye video nahi hai');
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('Cover image khaali hai');
  const up = await uploadMedia(adAccount, { type: 'image', base64: req.body.toString('base64') });
  media[i] = { ...media[i], thumbnailHash: up.imageHash, thumbnailUrl: up.url || media[i].thumbnailUrl };
  await updateDraft(req.org.id, draft.id, { media });
  res.json({ item: media[i], media });
}));

// AI Video Studio: this business's finished videos (when the two tools are linked).
wizard.get('/orgs/:orgId/video-studio/videos', requireOrg('manager'), ah(async (req, res) => res.json(await listStudioVideos(req.org.id))));

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
