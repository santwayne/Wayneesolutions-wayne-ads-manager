import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { signUserToken } from '../lib/auth.js';
import { ah, parse } from '../routes/util.js';
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

export function verifyHubToken(token) {
  if (!config.hub.secret) throw new AppError(503, 'hub_not_configured', 'HUB_SECRET not set');
  let p;
  try {
    p = jwt.verify(token, config.hub.secret, { algorithms: ['HS256'], issuer: 'regulars-hub', audience: config.hub.audience, maxAge: '2m' });
  } catch { throw new AppError(401, 'hub_token_rejected', 'Hub token rejected'); }
  if (!p.sub) throw new AppError(401, 'hub_token_rejected', 'Hub token rejected');
  return p;
}

async function consumeJti(p) {
  const jti = p.jti || crypto.createHash('sha256').update(`${p.sub}:${p.iat}:${p.exp}`).digest('hex');
  const r = await query('INSERT INTO hub_tickets_used (jti) VALUES ($1) ON CONFLICT DO NOTHING RETURNING jti', [jti]);
  if (!r.rows[0]) throw new AppError(401, 'hub_token_rejected', 'Hub token already used');
}

const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '');

const ProvisionBody = z.object({
  business: z.object({ name: z.string().min(1), phone: z.string().optional(), whatsapp: z.string().optional(), city: z.string().optional() }),
  owner: z.object({ name: z.string().min(1), email: z.string().email(), phone: z.string().optional() }),
  status: z.enum(['active', 'paused']).default('active'),
  plan: z.string().optional(),
});

hub.post('/provision', ah(async (req, res) => {
  const p = verifyHubToken(bearer(req));
  await consumeJti(p);
  const b = parse(ProvisionBody, req.body);
  const hubId = String(p.sub);
  const wa = (b.business.whatsapp || b.business.phone || b.owner.phone || '').replace(/\D/g, '') || null;

  const result = await tx(async (c) => {
    const { rows: [existing] } = await c.query('SELECT * FROM orgs WHERE hub_business_id = $1', [hubId]);
    let org = existing;
    if (!org) {
      ({ rows: [org] } = await c.query(
        `INSERT INTO orgs (name, type, parent_agency_id, plan, payment_model, whatsapp_number, hub_business_id, hub_status)
         VALUES ($1,'business',$2,$3,'A',$4,$5,$6) RETURNING *`,
        [b.business.name, config.hub.agencyOrgId, b.plan || 'loopdesk_bundle', wa, hubId, b.status]));
      // Wayne agency staff get access to every hub client (agency mode support).
      if (config.hub.agencyOrgId) await c.query('INSERT INTO memberships (user_id, org_id, role) SELECT user_id, $1, role FROM memberships WHERE org_id = $2 ON CONFLICT DO NOTHING', [org.id, config.hub.agencyOrgId]);
    } else {
      ({ rows: [org] } = await c.query('UPDATE orgs SET name = $2, whatsapp_number = COALESCE($3, whatsapp_number), hub_status = $4, plan = COALESCE($5, plan) WHERE id = $1 RETURNING *',
        [org.id, b.business.name, wa, b.status, b.plan || null]));
    }
    const { rows: [u] } = await c.query(
      `INSERT INTO users (email, name, password_hash, phone) VALUES (lower($1),$2,$3,$4)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [b.owner.email, b.owner.name, await bcrypt.hash(crypto.randomUUID(), 10), b.owner.phone || null]);
    await c.query("INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'owner') ON CONFLICT (user_id, org_id) DO UPDATE SET role = 'owner'", [u.id, org.id]);
    await c.query('UPDATE orgs SET hub_owner_user_id = $2 WHERE id = $1', [org.id, u.id]);
    return { org, created: !existing };
  });

  // Bundle lapsed -> pause everything that is running (money safety), never delete.
  if (b.status === 'paused') {
    const { rows } = await query("SELECT meta_id FROM campaigns WHERE org_id = $1 AND status = 'ACTIVE'", [result.org.id]);
    for (const c of rows) await setStatus({ orgId: result.org.id, level: 'campaign', metaId: c.meta_id, status: 'PAUSED', actor: { who: 'system:hub', source: 'system' } }).catch(() => {});
  }
  await logAction({ orgId: result.org.id, who: 'system:hub', source: 'system', what: 'hub_provision', after: { hubId, status: b.status, created: result.created } });
  res.json({ ok: true, external_id: String(result.org.id), status: b.status });
}));

hub.post('/sso/exchange', ah(async (req, res) => {
  const { ticket } = parse(z.object({ ticket: z.string().min(10) }), req.body);
  const p = verifyHubToken(ticket);
  await consumeJti(p);
  const { rows: [org] } = await query('SELECT * FROM orgs WHERE hub_business_id = $1', [String(p.sub)]);
  if (!org) throw new AppError(404, 'not_provisioned', 'Business abhi provision nahi hua');
  if (org.hub_status === 'paused') throw new AppError(403, 'bundle_paused', 'Aapka Loopdesk bundle paused hai');
  // Ticket may carry the user's email; otherwise log in the org owner.
  const { rows: [u] } = await query(
    `SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id AND m.org_id = $1
     WHERE ($2::text IS NULL OR lower(u.email) = lower($2)) ORDER BY (u.id = $3) DESC, (m.role = 'owner') DESC LIMIT 1`,
    [org.id, p.email || null, org.hub_owner_user_id]);
  if (!u) throw new AppError(404, 'no_user', 'User nahi mila');
  res.json({ token: signUserToken(u), orgId: org.id });
}));

