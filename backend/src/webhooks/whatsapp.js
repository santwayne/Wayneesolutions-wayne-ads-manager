import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { verifyMetaSignature } from '../lib/crypto.js';
import { enqueue } from '../jobs/queues.js';

export const whatsappWebhooks = Router();

whatsappWebhooks.get('/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && config.whatsapp.verifyToken && req.query['hub.verify_token'] === config.whatsapp.verifyToken) return res.status(200).send(req.query['hub.challenge']);
  return res.sendStatus(403);
});

export function parseWaMessages(body) {
  const out = [];
  for (const entry of body.entry || []) {
    for (const ch of entry.changes || []) {
      for (const m of ch.value?.messages || []) {
        const msg = { id: m.id, from: m.from, type: m.type };
        if (m.type === 'text') msg.text = m.text?.body;
        if (m.type === 'interactive') { msg.buttonId = m.interactive?.button_reply?.id || m.interactive?.list_reply?.id; msg.text = m.interactive?.button_reply?.title; }
        if (m.type === 'button') { msg.buttonId = m.button?.payload; msg.text = m.button?.text; }
        if (m.type === 'location') msg.location = m.location;
        if (m.type === 'image') { msg.image = m.image; msg.text = m.image?.caption; }
        if (m.type === 'video') { msg.video = m.video; }
        out.push(msg);
      }
    }
  }
  return out;
}

whatsappWebhooks.post('/whatsapp', async (req, res) => {
  if (!verifyMetaSignature(config.whatsapp.appSecret || config.meta.appSecret, req.rawBody || '', req.get('x-hub-signature-256'))) return res.sendStatus(401);
  res.sendStatus(200);
  try {
    for (const m of parseWaMessages(req.body)) {
      const ins = await query('INSERT INTO webhook_events (id, source) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id', [`wa:${m.id}`, 'whatsapp']);
      if (!ins.rows[0]) continue;
      // jobId per number keeps one conversation's messages in order (single-concurrency worker).
      await enqueue('whatsapp', 'inbound', m, { attempts: 2 });
    }
  } catch (e) { logger.error({ err: e.message }, 'whatsapp webhook failed'); }
});
