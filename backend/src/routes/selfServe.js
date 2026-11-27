import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, tx } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireOrg, signUserToken } from '../lib/auth.js';
import { ah, parse } from './util.js';
import { decryptSecret } from '../lib/crypto.js';
import { createGraphClient } from '../meta/graph.js';
import { enqueue } from '../jobs/queues.js';

/**
 * Phase 2 self-serve: a business signs up on its own, connects Meta with
 * Facebook Login for Business (routes/metaLogin.js), picks its ad account + Page.
 */
export const signup = Router();

signup.post('/signup', ah(async (req, res) => {
  const b = parse(z.object({
    businessName: z.string().min(2), name: z.string().min(1), email: z.string().email(), password: z.string().min(8),
    whatsappNumber: z.string().regex(/^\d{10,15}$/), privacyPolicyUrl: z.string().url().optional(),
  }), req.body);
  const exists = await query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [b.email]);
  if (exists.rows[0]) throw badRequest('Is email se account pehle se hai — login karein');
  const out = await tx(async (c) => {
    const { rows: [o] } = await c.query(
      "INSERT INTO orgs (name, type, plan, payment_model, whatsapp_number, privacy_policy_url, self_serve, subscription_status) VALUES ($1,'business','self_serve','A',$2,$3,true,'trial') RETURNING *",
      [b.businessName, b.whatsappNumber, b.privacyPolicyUrl || null]);
    const { rows: [u] } = await c.query('INSERT INTO users (email, name, password_hash, phone) VALUES (lower($1),$2,$3,$4) RETURNING *', [b.email, b.name, await bcrypt.hash(b.password, 10), b.whatsappNumber]);
    await c.query("INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'owner')", [u.id, o.id]);
    return { o, u };
  });
  res.status(201).json({ token: signUserToken(out.u), orgId: out.o.id });
}));

export const selfServe = Router();

async function latestUserToken(orgId) {
  const { rows: [c] } = await query("SELECT * FROM meta_connections WHERE org_id = $1 AND kind = 'user' AND status = 'active' ORDER BY id DESC LIMIT 1", [orgId]);
  if (!c) throw notFound('Pehle "Meta connect" karein');
  return { conn: c, token: await decryptSecret(c.token_enc) };
}

selfServe.get('/orgs/:orgId/meta/connection', requireOrg('viewer'), ah(async (req, res) => {
  const { rows } = await query('SELECT id, kind, scopes, expires_at, status, created_at FROM meta_connections WHERE org_id = $1 ORDER BY id DESC', [req.org.id]);
  res.json(rows);
}));

// After Facebook Login: what can this user advertise with?
selfServe.get('/orgs/:orgId/meta/my-assets', requireOrg('owner'), ah(async (req, res) => {
  const { token } = await latestUserToken(req.org.id);
  const g = createGraphClient({ token });
  const [accounts, pages] = await Promise.all([
    g.getAll('me/adaccounts', { fields: 'id,name,currency,timezone_name,account_status' }),
    g.getAll('me/accounts', { fields: 'id,name,tasks,instagram_business_account' }),
  ]);
  // Lead forms need a Page token holder with ADVERTISE task (spec "Token us insaan ka...").
  res.json({ accounts, pages: pages.map((p) => ({ id: p.id, name: p.name, canAdvertise: (p.tasks || []).includes('ADVERTISE'), instagramId: p.instagram_business_account?.id || null })) });
}));

selfServe.post('/orgs/:orgId/meta/attach', requireOrg('owner'), ah(async (req, res) => {
  const b = parse(z.object({
    metaAccountId: z.string().regex(/^act_\d+$/), pageId: z.string(), instagramId: z.string().nullable().optional(), sectorTemplate: z.string(),
    whatsappPhone: z.string().optional(), targetCpl: z.number().positive().optional(), serviceAreaPincodes: z.array(z.string().regex(/^\d{6}$/)).default([]),
  }), req.body);
  const { conn, token } = await latestUserToken(req.org.id);
  const g = createGraphClient({ token });
  // Subscribe our app to the Page's leadgen webhooks (needs pages_manage_metadata).
  const pages = await g.getAll('me/accounts', { fields: 'id,access_token' });
  const page = pages.find((p) => p.id === b.pageId);
  if (!page) throw badRequest('Ye Page aapke account se juda nahi hai');
  await createGraphClient({ token: page.access_token }).post(`${b.pageId}/subscribed_apps`, { subscribed_fields: 'leadgen' });
  const acc = await g.get(b.metaAccountId, { fields: 'name,currency,timezone_name' });
  const { rows: [a] } = await query(
    `INSERT INTO ad_accounts (org_id, connection_id, meta_account_id, name, currency, timezone, sector_template, page_id, instagram_id, whatsapp_phone, target_cpl, service_area_pincodes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (meta_account_id) DO UPDATE SET connection_id = EXCLUDED.connection_id, page_id = EXCLUDED.page_id RETURNING *`,
    [req.org.id, conn.id, b.metaAccountId, acc.name, acc.currency, acc.timezone_name, b.sectorTemplate, b.pageId, b.instagramId || null, b.whatsappPhone || null, b.targetCpl || null, b.serviceAreaPincodes]);
  if (a.org_id !== req.org.id) throw badRequest('Ye ad account kisi aur business se juda hai');
  await enqueue('sync', 'sync-account', { adAccountId: a.id }, { jobId: `sync-${a.id}-initial` });
  res.status(201).json(a);
}));
