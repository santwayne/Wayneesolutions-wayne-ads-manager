import { config } from '../config.js';
import { query } from '../lib/db.js';
import { logger } from '../lib/logger.js';

/**
 * WhatsApp Cloud API sender (Loopdesk number). Alerts/reports in Hinglish.
 * Inside the 24h customer window we send interactive buttons; outside it Meta needs an
 * approved template, so we fall back to `${prefix}_ads_alert` / `${prefix}_ads_report`
 * (see docs/WHATSAPP_TEMPLATES.md for the template bodies to submit).
 */
const OUTSIDE_WINDOW_CODES = new Set([131047, 131026]);
export const sentLog = []; // used in log mode / tests

async function post(payload) {
  if (config.whatsapp.mode === 'log') {
    sentLog.push(payload);
    logger.info({ to: payload.to, type: payload.type }, 'whatsapp (log mode)');
    return { messages: [{ id: `log-${sentLog.length}` }] };
  }
  const url = `${config.meta.graphBase}/${config.meta.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.whatsapp.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const err = new Error(json.error?.message || 'WhatsApp send failed');
    err.code = json.error?.code;
    throw err;
  }
  return json;
}

async function record(orgId, to, payload, res) {
  await query('INSERT INTO wa_messages (org_id, wa_number, direction, body, wa_message_id) VALUES ($1,$2,$3,$4,$5)',
    [orgId || null, to, 'out', JSON.stringify(payload), res?.messages?.[0]?.id || null]).catch(() => {});
}

export async function sendText(orgId, to, body) {
  const payload = { to, type: 'text', text: { body: body.slice(0, 4096) } };
  const res = await post(payload);
  await record(orgId, to, payload, res);
  return res;
}

/** buttons: [{id, title}] max 3, title max 20 chars */
export async function sendButtons(orgId, to, body, buttons, { imageUrl, templateFallback = 'ads_alert' } = {}) {
  const payload = {
    to, type: 'interactive',
    interactive: {
      type: 'button',
      ...(imageUrl ? { header: { type: 'image', image: { link: imageUrl } } } : {}),
      body: { text: body.slice(0, 1024) },
      action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
    },
  };
  try {
    const res = await post(payload);
    await record(orgId, to, payload, res);
    return res;
  } catch (e) {
    if (!OUTSIDE_WINDOW_CODES.has(e.code)) throw e;
    return sendTemplate(orgId, to, templateFallback, [body.slice(0, 1000)], buttons.map((b) => b.id));
  }
}

export async function sendTemplate(orgId, to, name, bodyParams = [], quickReplyPayloads = []) {
  const components = [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: t })) }];
  quickReplyPayloads.forEach((p, i) => components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: p }] }));
  const payload = { to, type: 'template', template: { name: `${config.whatsapp.templatePrefix}_${name}`, language: { code: 'en' }, components } };
  const res = await post(payload);
  await record(orgId, to, payload, res);
  return res;
}

export async function ownerNumber(orgId) {
  const { rows } = await query('SELECT whatsapp_number FROM orgs WHERE id = $1', [orgId]);
  return rows[0]?.whatsapp_number || null;
}

export async function notifyOwner(orgId, body, buttons) {
  const to = await ownerNumber(orgId);
  if (!to) { logger.warn({ orgId }, 'no owner whatsapp number, skipping notify'); return null; }
  try {
    return buttons?.length ? await sendButtons(orgId, to, body, buttons) : await sendText(orgId, to, body);
  } catch (e) {
    logger.error({ orgId, err: e.message }, 'whatsapp notify failed');
    return null;
  }
}
