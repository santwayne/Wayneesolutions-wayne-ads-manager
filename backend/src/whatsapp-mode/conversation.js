import { config } from '../config.js';
import { query } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { geocode } from '../lib/geocode.js';
import { parseBrief, generateCopy, changeRequestToPatch } from '../ai/service.js';
import { createDraft, updateDraft, validate, createOnMeta, uploadMedia, getDraftContext } from '../wizard/service.js';
import { getTemplate } from '../wizard/templates/index.js';
import { GOALS } from '../wizard/goals.js';
import { launchCampaign, logAction } from '../actions/service.js';
import { decideAlert } from '../rules/runner.js';
import { analyzeImage } from '../wizard/media.js';
import { sendText, sendButtons } from '../notify/whatsapp.js';
import { enqueue } from '../jobs/queues.js';
import { inr } from '../notify/format.js';

/**
 * WhatsApp Mode: client never opens the app. Same wizard logic, chat instead of screens.
 * States: idle -> collecting (max 3 follow-ups) -> preview -> awaiting_change -> preview ... -> launched
 * AI rules: only template-allowed fields, policy pre-check on every copy, budget never above
 * the client's number, every AI decision in actions_log. Never live without "Haan".
 */
export const FOLLOWUP_TIMEOUT_MS = 2 * 3600_000;
const MAX_FOLLOWUPS = 3;

let downloader = downloadWaMedia;
export function setMediaDownloader(fn) { downloader = fn; }

async function getConv(waNumber) {
  const { rows } = await query('SELECT * FROM wa_conversations WHERE wa_number = $1', [waNumber]);
  return rows[0] || null;
}
async function saveConv(waNumber, patch) {
  const keys = Object.keys(patch);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await query(`UPDATE wa_conversations SET ${sets}, updated_at = now() WHERE wa_number = $1`, [waNumber, ...keys.map((k) => patch[k])]);
}

async function orgForNumber(waNumber) {
  const { rows } = await query("SELECT * FROM orgs WHERE whatsapp_number = $1 AND type = 'business' LIMIT 1", [waNumber]);
  return rows[0] || null;
}

const say = (org, to, text) => sendText(org.id, to, text);

/** Entry point for every inbound WhatsApp message (webhooks/whatsapp.js). */
export async function handleInbound({ from, type, text, buttonId, location, image }) {
  await query('INSERT INTO wa_messages (wa_number, direction, body) VALUES ($1,$2,$3)', [from, 'in', JSON.stringify({ type, text, buttonId, location, image: image?.id })]);
  const org = await orgForNumber(from);
  if (!org) {
    await sendText(null, from, 'Namaste! Ye number abhi Wayne Ads se juda nahi hai. Wayne E Solutions team se contact karein.');
    return { unknown: true };
  }
  await query('INSERT INTO wa_conversations (org_id, wa_number) VALUES ($1,$2) ON CONFLICT (wa_number) DO NOTHING', [org.id, from]);
  let conv = await getConv(from);
  const actor = { who: `whatsapp:${from}`, source: 'whatsapp' };

  // Button replies first (alerts and preview)
  if (buttonId) {
    const [kind, id, choice] = buttonId.split(':');
    if (kind === 'alert') {
      try {
        const r = await decideAlert(org.id, Number(id), choice === 'yes', actor);
        await say(org, from, r.status === 'approved' ? '✅ Ho gaya. App mein "Undo" se wapas kar sakte hain.' : 'Theek hai, kuch nahi badla.');
      } catch (e) { await say(org, from, `⚠️ ${e.message}`); }
      return { handled: 'alert' };
    }
    if (kind === 'draft' && Number(id) === Number(conv.draft_id)) {
      if (choice === 'launch') return launchFromChat(org, from, conv, actor);
      if (choice === 'change') {
        await saveConv(from, { state: 'awaiting_change' });
        await say(org, from, 'Kya badalna hai? Seedha likh dijiye — jaise "area 5 km karo" ya "Punjabi mein likho".');
        return { handled: 'change' };
      }
    }
  }

  if (conv.state === 'idle' || conv.state === 'launched') {
    if (type !== 'text' || !text) { await say(org, from, 'Bas 3 cheezein likh bhejiye: kya bechna hai, kis area mein, aur kitna budget. Jaise: "IELTS coaching, Model Town Ludhiana, ₹15,000 mahina"'); return { handled: 'hint' }; }
    return startFromBrief(org, from, text, actor);
  }

  if (conv.state === 'collecting') return collectAnswer(org, from, conv, { type, text, location, image }, actor);
  if (conv.state === 'awaiting_change' && text) return applyChange(org, from, conv, text, actor);
  if (conv.state === 'preview') {
    if (/^(haan|ha|yes|ok|launch|chalao|done)\b/i.test(text || '')) return launchFromChat(org, from, conv, actor);
    if (text) return applyChange(org, from, conv, text, actor);
  }
  if (image && conv.draft_id) return collectAnswer(org, from, { ...conv, state: 'collecting' }, { type, image }, actor);
  return { handled: 'noop' };
}

async function defaultAdAccount(orgId) {
  const { rows } = await query("SELECT * FROM ad_accounts WHERE org_id = $1 AND status = 'active' ORDER BY id LIMIT 1", [orgId]);
  return rows[0] || null;
}

async function startFromBrief(org, from, text, actor) {
  const acc = await defaultAdAccount(org.id);
  if (!acc) { await say(org, from, 'Aapka ad account abhi setup nahi hua. Wayne team jaldi setup karegi.'); return { handled: 'no_account' }; }
  const brief = await parseBrief(text);
  const sector = brief.sector || acc.sector_template || 'other';
  const t = getTemplate(sector);
  const loc = brief.area ? await geocode(brief.area) : null;
  const data = {
    sector, businessName: org.name, area: brief.area,
    location: loc, offer: brief.offer || '', goal: brief.goal || t.defaultGoal, language: brief.language || t.language,
    // Budget never above the client's number (AI rule).
    dailyBudget: brief.dailyBudget || t.recommendedDailyBudget,
    maxDailyBudget: brief.maxDailyBudget || null,
    media: [],
  };
  const draft = await createDraft(org.id, { adAccountId: acc.id, channel: 'whatsapp', data });
  await logAction({ orgId: org.id, who: 'ai', source: 'ai', what: 'ai_decision', after: { step: 'parse_brief', input: text, parsed: brief, draftId: draft.id } });
  await saveConv(from, { state: 'collecting', draft_id: draft.id, followups_asked: 0 });
  await enqueue('whatsapp', 'followup-timeout', { waNumber: from, draftId: draft.id }, { delay: FOLLOWUP_TIMEOUT_MS, jobId: `wa-timeout-${draft.id}` });
  return askNext(org, from, await getConv(from), draft.data);
}

/** Missing items in priority order (max 3 asked; else template default). */
function missingItems(d) {
  const m = [];
  if (!d.offer) m.push('offer');
  if (!d._goalConfirmed) m.push('goal');
  if (!d.media?.length && !d._mediaSkipped) m.push('media');
  return m;
}

async function askNext(org, from, conv, d) {
  const missing = missingItems(d);
  const needLocation = !d.location?.lat;
  if ((!missing.length || conv.followups_asked >= MAX_FOLLOWUPS) && !needLocation) return sendPreview(org, from, conv.draft_id);
  const item = conv.followups_asked < MAX_FOLLOWUPS ? missing[0] : null;
  const t = getTemplate(d.sector);
  const q = {
    offer: `Ad mein kya offer dena hai? Jaise: "${t.offerIdeas[0] || 'Free consultation'}"`,
    goal: 'Leads kaise chahiye?\n1. Form (naam + number)\n2. WhatsApp messages\n3. Seedha call\n(1, 2 ya 3 likhein)',
    media: '3–5 photos ya ek video bhej dijiye (achhi, saaf photos). Nahi hain toh "skip" likhein.',
  }[item];
  const locNote = needLocation ? '\n\n📍 Aur apne business ki location pin share kar dijiye (WhatsApp → Attach → Location).' : '';
  await saveConv(from, { followups_asked: conv.followups_asked + (item ? 1 : 0), state: 'collecting' });
  await query("UPDATE wizard_drafts SET data = data || jsonb_build_object('_asking', $2::text) WHERE id = $1", [conv.draft_id, item || 'location']);
  await say(org, from, `${q || 'Bas ek cheez:'}${locNote}`);
  return { asked: item || 'location' };
}

async function collectAnswer(org, from, conv, msg, actor) {
  const { draft } = await getDraftContext(org.id, conv.draft_id);
  const d = draft.data; const patch = {};
  if (msg.location) patch.location = { lat: msg.location.latitude, lng: msg.location.longitude, label: msg.location.name || msg.location.address || d.area };
  if (msg.image) {
    const added = await addImage(org, draft, msg.image);
    if (added) patch.media = [...(d.media || []), added];
    if ((patch.media || d.media || []).length < 3) { await updateDraft(org.id, draft.id, patch); return { handled: 'media_added' }; }
  }
  if (msg.text) {
    const t = msg.text.trim();
    if (d._asking === 'offer') patch.offer = t;
    else if (d._asking === 'goal') { const map = { 1: 'lead_form', 2: 'whatsapp', 3: 'call' }; const k = map[t[0]] || (/whatsapp/i.test(t) ? 'whatsapp' : /call/i.test(t) ? 'call' : 'lead_form'); patch.goal = k; patch._goalConfirmed = true; }
    else if (d._asking === 'media' && /skip|nahi|no/i.test(t)) patch._mediaSkipped = true;
  }
  const updated = await updateDraft(org.id, draft.id, patch);
  // If media was skipped, the preview checklist will flag it (we can't invent photos).
  return askNext(org, from, await getConv(from), updated.data);
}

async function addImage(org, draft, image) {
  try {
    const { buffer, mimeType } = await downloader(image.id);
    const qa = await analyzeImage(buffer);
    const { rows: [acc] } = await query('SELECT * FROM ad_accounts WHERE id = $1', [draft.ad_account_id]);
    const up = await uploadMedia(acc, { type: 'image', base64: buffer.toString('base64') });
    return { type: 'image', ...qa, ...up, mimeType };
  } catch (e) { logger.error({ err: e.message }, 'wa image add failed'); return null; }
}

/** Follow-up timeout: no answer -> template defaults, go to preview. */
export async function followupTimeout({ waNumber, draftId }) {
  const conv = await getConv(waNumber);
  if (!conv || conv.draft_id !== draftId || conv.state !== 'collecting') return;
  const org = await orgForNumber(waNumber);
  const { draft } = await getDraftContext(org.id, draftId);
  const t = getTemplate(draft.data.sector);
  await updateDraft(org.id, draftId, { offer: draft.data.offer || t.offerIdeas[0] || '', _goalConfirmed: true });
  await logAction({ orgId: org.id, who: 'ai', source: 'ai', what: 'ai_decision', after: { step: 'followup_timeout_defaults', draftId } });
  return sendPreview(org, waNumber, draftId);
}

export async function sendPreview(org, from, draftId) {
  const { draft } = await getDraftContext(org.id, draftId);
  let d = draft.data;
  if (!d.offer) {
    // No answer to the follow-up -> template default (spec).
    d = (await updateDraft(org.id, draftId, { offer: getTemplate(d.sector).offerIdeas[0] || 'Special offer' })).data;
  }
  if (!d.primaryTexts?.length || d._regenerate) {
    const copy = await generateCopy({ sector: d.sector, offer: d.offer, language: d.language, businessName: d.businessName, area: d.area, goal: d.goal });
    d = (await updateDraft(org.id, draftId, { primaryTexts: copy.primaryTexts.slice(0, 3), headlines: copy.headlines.slice(0, 3), _regenerate: false })).data;
    await logAction({ orgId: org.id, who: 'ai', source: 'ai', what: 'ai_decision', after: { step: 'generate_copy', draftId, texts: d.primaryTexts } });
  }
  const v = await validate(org.id, draftId, { maxDailyBudget: d.maxDailyBudget });
  const blockers = v.checks.filter((c) => c.level === 'block');
  const lines = [
    '*Aapka ad ready hai* 👇', '', d.primaryTexts[0], '',
    `📌 ${d.headlines[0] || ''}`,
    `💰 Budget: ${inr(v.draft.dailyBudget)}/din (mahine ka ~${inr(v.estimate.monthlyBudget)})`,
    `📍 Area: ${d.area || d.location?.label || 'aapki location'} — ${v.draft.radiusKm} km`,
    `👥 Age: ${v.draft.ageMin}–${v.draft.ageMax}`,
    `🎯 Leads: ${GOALS[v.draft.goal]?.label}`,
  ];
  if (blockers.length) lines.push('', '⚠️ Launch se pehle ye theek karna hoga:', ...blockers.map((b) => `• ${b.message}`));
  await saveConv(from, { state: 'preview' });
  const imageUrl = d.media?.find((m) => m.url)?.url;
  await sendButtons(org.id, from, lines.join('\n'), [
    { id: `draft:${draftId}:launch`, title: 'Haan, launch karo' },
    { id: `draft:${draftId}:change`, title: 'Badlo' },
  ], { imageUrl, templateFallback: 'ads_preview' });
  return { preview: true, blocking: blockers.length > 0 };
}

async function applyChange(org, from, conv, text, actor) {
  const { draft } = await getDraftContext(org.id, conv.draft_id);
  const t = getTemplate(draft.data.sector);
  const patch = await changeRequestToPatch({ text, draft: draft.data, allowedFields: t.aiEditableFields });
  // Budget never above the client's own number.
  if (patch.dailyBudget && draft.data.maxDailyBudget && patch.dailyBudget > draft.data.maxDailyBudget) {
    await say(org, from, `Budget aapke bataye ${inr(draft.data.maxDailyBudget)}/din se upar nahi kar sakte. Zyada chahiye toh naya budget likhein, jaise "budget ₹800 din karo, max ₹800".`);
    delete patch.dailyBudget;
  }
  if (/max\s*₹?\s*([\d,]+)/i.test(text)) patch.maxDailyBudget = Number(text.match(/max\s*₹?\s*([\d,]+)/i)[1].replace(/,/g, ''));
  if (patch.regenerateCopy) { patch._regenerate = true; patch.primaryTexts = []; }
  delete patch.regenerateCopy;
  await updateDraft(org.id, conv.draft_id, patch);
  await logAction({ orgId: org.id, who: 'ai', source: 'ai', what: 'ai_decision', after: { step: 'change_request', text, patch } });
  return sendPreview(org, from, conv.draft_id);
}

async function launchFromChat(org, from, conv, actor) {
  try {
    const created = await createOnMeta(org.id, conv.draft_id, actor);
    await launchCampaign({ orgId: org.id, campaignMetaId: created.metaCampaignId, actor });
    await saveConv(from, { state: 'launched' });
    await say(org, from, '🚀 Ad live ho gaya! Meta review mein ~1 ghanta lag sakta hai. Har roz hum check karenge aur Monday ko report bhejenge.');
    return { launched: created };
  } catch (e) {
    const details = e.details?.map?.((d) => `• ${d.message}`).join('\n');
    await say(org, from, `⚠️ Launch nahi hua: ${e.message}${details ? `\n${details}` : ''}`);
    return { error: e.message };
  }
}

/** WhatsApp Cloud API media download (two-step: id -> url -> bytes). */
export async function downloadWaMedia(mediaId) {
  const h = { authorization: `Bearer ${config.whatsapp.accessToken}` };
  const meta = await (await fetch(`${config.meta.graphBase}/${config.meta.apiVersion}/${mediaId}`, { headers: h })).json();
  const res = await fetch(meta.url, { headers: h });
  return { buffer: Buffer.from(await res.arrayBuffer()), mimeType: meta.mime_type };
}
