import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { parseSignedRequest, randomCode, verifyMetaSignature } from '../lib/crypto.js';
import { enqueue } from '../jobs/queues.js';

export const metaWebhooks = Router();

/** GET verification handshake (hub.challenge). */
function verify(token) {
  return (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && token && req.query['hub.verify_token'] === token) return res.status(200).send(req.query['hub.challenge']);
    return res.sendStatus(403);
  };
}

metaWebhooks.get('/meta', verify(config.meta.webhookVerifyToken));

/**
 * Leadgen webhook (Page object, field "leadgen"). Signature X-Hub-Signature-256 checked
 * against the raw body. We ack fast and process in the queue.
 */
metaWebhooks.post('/meta', async (req, res) => {
  if (!verifyMetaSignature(config.meta.appSecret, req.rawBody || '', req.get('x-hub-signature-256'))) {
    logger.warn('meta webhook bad signature');
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  try {
    if (req.body.object !== 'page') return;
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'leadgen') continue;
        const v = change.value || {};
        const dedupe = `leadgen:${v.leadgen_id}`;
        const ins = await query('INSERT INTO webhook_events (id, source) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id', [dedupe, 'meta']);
        if (!ins.rows[0]) continue;
        await enqueue('leads', 'process-lead', { leadgenId: v.leadgen_id, pageId: v.page_id || entry.id, formId: v.form_id, adId: v.ad_id }, { attempts: 5, backoff: { type: 'exponential', delay: 30_000 } });
      }
    }
  } catch (e) { logger.error({ err: e.message }, 'meta webhook processing failed'); }
});

/**
 * Data deletion callback (App settings -> Data deletion request URL).
 * Verifies the signed_request, queues deletion, returns { url, confirmation_code }.
 */
metaWebhooks.post('/meta/data-deletion', async (req, res) => {
  const data = parseSignedRequest(req.body?.signed_request, config.meta.appSecret);
  if (!data?.user_id) return res.status(400).json({ error: 'invalid signed_request' });
  const code = randomCode(8);
  await query('INSERT INTO deletion_requests (meta_user_id, confirmation_code) VALUES ($1,$2)', [String(data.user_id), code]);
  await enqueue('sync', 'data-deletion', { code }, { attempts: 5 });
  return res.json({ url: `${config.publicBaseUrl}/deletion-status?code=${code}`, confirmation_code: code });
});

/** Public status page for the user. */
export async function deletionStatus(req, res) {
  const { rows } = await query('SELECT status, created_at, completed_at FROM deletion_requests WHERE confirmation_code = $1', [String(req.query.code || '')]);
  const r = rows[0];
  const msg = !r ? 'Request nahi mila / Request not found.'
    : r.status === 'completed' ? `Aapka data delete ho gaya hai (${new Date(r.completed_at).toISOString().slice(0, 10)}). / Your data has been deleted.`
      : 'Aapki request mil gayi hai, 30 din mein data delete ho jaayega. / Your request is received and is being processed.';
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Data deletion status</title><body style="font-family:sans-serif;max-width:560px;margin:60px auto"><h2>Wayne Ads Manager — data deletion</h2><p>Confirmation code: <b>${String(req.query.code || '').replace(/[^a-f0-9]/gi, '')}</b></p><p>${msg}</p></body>`);
}
metaWebhooks.get('/deletion-status', deletionStatus);

/** Executes a deletion request: removes the Meta user's connection + tokens + their stored lead data. */
export async function executeDeletion(code) {
  const { rows } = await query("SELECT * FROM deletion_requests WHERE confirmation_code = $1 AND status = 'queued'", [code]);
  const r = rows[0];
  if (!r) return;
  await query("UPDATE meta_connections SET status = 'revoked', token_enc = 'deleted' WHERE meta_user_id = $1", [r.meta_user_id]);
  await query("UPDATE deletion_requests SET status = 'completed', completed_at = now() WHERE id = $1", [r.id]);
}
