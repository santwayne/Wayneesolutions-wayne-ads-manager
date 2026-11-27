import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { signUserToken } from '../lib/auth.js';
import { logAction, setStatus } from '../actions/service.js';

/**
 * Loopdesk hub connection (same pattern as Loyvexa):
 *  - POST /api/hub/provision      hub creates/updates/pauses the business + owner
 *  - POST /api/hub/sso/exchange   single-use ticket -> our session
 *  - GET  /sso (frontend page)    calls the exchange and logs the client in
 * Token: HS256 with HUB_SECRET, iss "regulars-hub", aud "wayne-ads", sub = hub business id,
 * single-use (jti), expires in 2 minutes.
 */
export const hub = Router();

/**
 * Same protocol as every Loopdesk tool (see regularsplatform lib/hub-rules.ts):
 *   HS256, iss "regulars-hub", aud "wayne-ads", sub <Loopdesk business id>,
 *   purpose "provision" | "sso", jti single use, exp <= 2 minutes.
 */
export function verifyHubToken(token, purpose) {
  if (!config.hub.secret) throw new AppError(503, 'hub_not_configured', 'Loopdesk connection is not set up on this server (HUB_SECRET missing)');
  if (!token) throw new AppError(401, 'hub_token_rejected', 'Missing token');
  let p;
  try {
    p = jwt.verify(token, config.hub.secret, { algorithms: ['HS256'], issuer: 'regulars-hub', audience: config.hub.audience, maxAge: '120s' });
  } catch { throw new AppError(401, 'hub_token_rejected', 'Hub token rejected'); }
  if (p.purpose !== purpose || !p.sub || !p.jti || typeof p.exp !== 'number') throw new AppError(401, 'hub_token_rejected', 'Hub token rejected');
  return p;
}

async function consumeJti(p) {
  await query("DELETE FROM hub_tickets_used WHERE used_at < now() - interval '1 day'").catch(() => {});
  const r = await query('INSERT INTO hub_tickets_used (jti) VALUES ($1) ON CONFLICT DO NOTHING RETURNING jti', [p.jti]);
  if (!r.rows[0]) throw new AppError(401, 'hub_token_rejected', 'Token already used');
}

const bearer = (req) => { const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || ''); return m ? m[1].trim() : null; };

// Loopdesk sectors -> our wizard templates (closest match; owner can change in Settings).
const SECTOR_MAP = { SALON: 'salon_gym', GYM: 'salon_gym', CLINIC: 'ivf', RESTAURANT: 'restaurant', RETAIL: 'other', HOME_SERVICES: 'other', MANUFACTURER: 'other', OTHER: 'other' };
export const toTemplate = (s) => SECTOR_MAP[String(s || '').toUpperCase()] || 'other';

const ProvisionBody = z.object({
  hubBusinessId: z.string().min(1),
  active: z.boolean(),
  business: z.object({ name: z.string().min(1), sector: z.string().nullish(), country: z.string().nullish(), phone: z.string().nullish(), whatsapp: z.string().nullish() }).passthrough(),
  owner: z.object({ name: z.string().min(1), email: z.string().email(), phone: z.string().nullish() }),
  plan: z.string().nullish(),
}).passthrough(); // Loopdesk sends more (paidUntil, tools...): ignored

/**
 *   POST /api/hub/provision  Authorization: Bearer <purpose "provision">
 *   { hubBusinessId, active, business{name, sector, country}, owner{name, email, phone}, ... }
 *   -> 200 { accountId, status: "ACTIVE" | "PAUSED", data{ ownerEmail, sectorTemplate } }
 * Idempotent per hubBusinessId. active=false pauses live campaigns (never deletes).
 */
hub.post('/provision', async (req, res) => {
  let p;
  try { p = verifyHubToken(bearer(req), 'provision'); await consumeJti(p); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  const r = ProvisionBody.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: 'Invalid body', detail: r.error.issues });
  const b = r.data;
  if (b.hubBusinessId !== String(p.sub)) return res.status(403).json({ error: 'Token is for a different business' });
  const status = b.active ? 'active' : 'paused';
  const wa = (b.business.whatsapp || b.business.phone || b.owner.phone || '').replace(/\D/g, '') || null;
  const email = b.owner.email.toLowerCase();

  try {
    const result = await tx(async (c) => {
      const { rows: [existing] } = await c.query('SELECT * FROM orgs WHERE hub_business_id = $1', [b.hubBusinessId]);
      let org = existing;
      if (!org) {
        // Refuse if this email already owns a different hub-linked business (team sorts it out).
        const { rows: [clash] } = await c.query(
          `SELECT o.id FROM users u JOIN memberships m ON m.user_id = u.id AND m.role = 'owner' JOIN orgs o ON o.id = m.org_id
           WHERE lower(u.email) = $1 AND o.hub_business_id IS NOT NULL AND o.hub_business_id <> $2 LIMIT 1`, [email, b.hubBusinessId]);
        if (clash) throw new AppError(409, 'conflict', "This owner's Wayne Ads account is already linked to another Loopdesk AI client.");
        ({ rows: [org] } = await c.query(
          `INSERT INTO orgs (name, type, parent_agency_id, plan, payment_model, whatsapp_number, hub_business_id, hub_status)
           VALUES ($1,'business',$2,$3,'A',$4,$5,$6) RETURNING *`,
          [b.business.name, config.hub.agencyOrgId, b.plan || 'loopdesk_bundle', wa, b.hubBusinessId, status]));
        if (config.hub.agencyOrgId) await c.query('INSERT INTO memberships (user_id, org_id, role) SELECT user_id, $1, role FROM memberships WHERE org_id = $2 ON CONFLICT DO NOTHING', [org.id, config.hub.agencyOrgId]);
      } else {
        ({ rows: [org] } = await c.query('UPDATE orgs SET name = $2, whatsapp_number = COALESCE($3, whatsapp_number), hub_status = $4, plan = COALESCE($5, plan) WHERE id = $1 RETURNING *',
          [org.id, b.business.name, wa, status, b.plan || null]));
      }
      const { rows: [u] } = await c.query(
        `INSERT INTO users (email, name, password_hash, phone) VALUES ($1,$2,$3,$4)
         ON CONFLICT (email) DO UPDATE SET name = users.name RETURNING id`,
        [email, b.owner.name, await bcrypt.hash(crypto.randomUUID(), 10), b.owner.phone || null]);
      await c.query("INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'owner') ON CONFLICT (user_id, org_id) DO UPDATE SET role = 'owner'", [u.id, org.id]);
      await c.query('UPDATE orgs SET hub_owner_user_id = $2 WHERE id = $1', [org.id, u.id]);
      return { org, created: !existing };
    });

    if (!b.active) {
      const { rows } = await query("SELECT meta_id FROM campaigns WHERE org_id = $1 AND status = 'ACTIVE'", [result.org.id]);
      for (const c of rows) await setStatus({ orgId: result.org.id, level: 'campaign', metaId: c.meta_id, status: 'PAUSED', actor: { who: 'system:hub', source: 'system' } }).catch(() => {});
    }
    await logAction({ orgId: result.org.id, who: 'system:hub', source: 'system', what: 'hub_provision', after: { hubBusinessId: b.hubBusinessId, active: b.active, created: result.created } });
    return res.json({ accountId: String(result.org.id), status: b.active ? 'ACTIVE' : 'PAUSED', data: { ownerEmail: email, sectorTemplate: toTemplate(b.business.sector) } });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'Set-up failed' });
  }
});

/**
 *   POST /api/hub/sso/exchange  { token }  -> { token: <our session JWT>, orgId, next }
 * The /sso page in the app reads ?token= and calls this.
 */
hub.post('/sso/exchange', async (req, res) => {
  let p;
  const t = typeof req.body?.token === 'string' ? req.body.token : (typeof req.body?.ticket === 'string' ? req.body.ticket : null);
  try { p = verifyHubToken(t, 'sso'); await consumeJti(p); } catch (e) { return res.status(e.status || 401).json({ error: e.message, message: e.message }); }
  const { rows: [org] } = await query('SELECT * FROM orgs WHERE hub_business_id = $1', [String(p.sub)]);
  if (!org || (typeof p.acct === 'string' && p.acct !== String(org.id))) return res.status(404).json({ error: "This Wayne Ads account isn't set up yet. Try again in a few minutes.", message: 'Account abhi set up nahi hua, thodi der mein try karein.' });
  if (org.hub_status === 'paused') return res.status(403).json({ error: 'Wayne Ads is paused for this business.', message: 'Is business ke liye Wayne Ads paused hai.' });
  const { rows: [u] } = await query(
    `SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id AND m.org_id = $1 ORDER BY (u.id = $2) DESC, (m.role = 'owner') DESC LIMIT 1`,
    [org.id, org.hub_owner_user_id]);
  if (!u) return res.status(404).json({ error: 'Owner not found' });
  const next = typeof p.next === 'string' && p.next.startsWith('/') && !p.next.startsWith('//') && !p.next.includes('\\') ? p.next : `/orgs/${org.id}`;
  res.set('cache-control', 'no-store');
  return res.json({ token: signUserToken(u), orgId: org.id, next });
});


