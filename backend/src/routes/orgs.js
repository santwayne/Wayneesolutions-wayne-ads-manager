import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, tx } from '../lib/db.js';
import { forbidden, conflict, badRequest } from '../lib/errors.js';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { issueUserToken, resetLink, deliverLink } from './password.js';
import { requireOrg } from '../lib/auth.js';
import { ah, parse, actorOf } from './util.js';
import { logAction } from '../actions/service.js';
import { agencyOverview, totals, objectPerformance } from '../reports/metrics.js';
import { listBusinessAdAccounts } from '../meta/sync.js';
import { enqueue } from '../jobs/queues.js';

export const orgs = Router();

// Agency dashboard: all clients, health score, who needs attention today.
orgs.get('/agency/overview', ah(async (req, res) => res.json({ clients: await agencyOverview(req.user.id) })));

// Create a client business under an agency (agency owner/manager only).
orgs.post('/orgs/:orgId/clients', requireOrg('manager'), ah(async (req, res) => {
  const { rows: [agency] } = await query('SELECT * FROM orgs WHERE id = $1', [req.org.id]);
  if (agency.type !== 'agency') throw forbidden('Sirf agency client bana sakti hai');
  const b = parse(z.object({
    name: z.string().min(2), whatsappNumber: z.string().regex(/^\d{10,15}$/).optional(), paymentModel: z.enum(['A', 'B']).default('A'),
    serviceFeeMonthly: z.number().nonnegative().default(0), privacyPolicyUrl: z.string().url().optional(), gstin: z.string().optional(),
  }), req.body);
  const org = await tx(async (c) => {
    const { rows: [o] } = await c.query(
      `INSERT INTO orgs (name, type, parent_agency_id, payment_model, whatsapp_number, service_fee_monthly, privacy_policy_url, gstin)
       VALUES ($1,'business',$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.name, agency.id, b.paymentModel, b.whatsappNumber || null, b.serviceFeeMonthly, b.privacyPolicyUrl || null, b.gstin || null]);
    // Every agency member gets access to the new client with their agency role.
    await c.query('INSERT INTO memberships (user_id, org_id, role) SELECT user_id, $1, role FROM memberships WHERE org_id = $2', [o.id, agency.id]);
    if (b.paymentModel === 'B') await c.query('INSERT INTO wallets (org_id) VALUES ($1)', [o.id]);
    return o;
  });
  res.status(201).json(org);
}));

orgs.get('/orgs/:orgId', requireOrg('viewer'), ah(async (req, res) => {
  const { rows: [o] } = await query('SELECT * FROM orgs WHERE id = $1', [req.org.id]);
  res.json({ ...o, role: req.org.role });
}));

// Owner-only settings: caps, auto-mode, AI call, WhatsApp.
orgs.patch('/orgs/:orgId/settings', requireOrg('owner'), ah(async (req, res) => {
  const b = parse(z.object({
    autoMode: z.boolean().optional(), autoDailyActionLimit: z.number().int().min(0).max(50).optional(),
    dailyBudgetCap: z.number().positive().nullable().optional(), aiCallEnabled: z.boolean().optional(),
    whatsappNumber: z.string().regex(/^\d{10,15}$/).optional(), privacyPolicyUrl: z.string().url().optional(),
    serviceFeeMonthly: z.number().nonnegative().optional(),
  }), req.body);
  const map = { autoMode: 'auto_mode', autoDailyActionLimit: 'auto_daily_action_limit', dailyBudgetCap: 'daily_budget_cap', aiCallEnabled: 'ai_call_enabled', whatsappNumber: 'whatsapp_number', privacyPolicyUrl: 'privacy_policy_url', serviceFeeMonthly: 'service_fee_monthly' };
  const { rows: [before] } = await query('SELECT * FROM orgs WHERE id = $1', [req.org.id]);
  const keys = Object.keys(b);
  if (!keys.length) return res.json(before);
  const sets = keys.map((k, i) => `${map[k]} = $${i + 2}`).join(', ');
  const { rows: [after] } = await query(`UPDATE orgs SET ${sets} WHERE id = $1 RETURNING *`, [req.org.id, ...keys.map((k) => b[k])]);
  await logAction({ orgId: req.org.id, ...actorOf(req), what: 'settings', before: Object.fromEntries(keys.map((k) => [k, before[map[k]]])), after: b });
  res.json(after);
}));

// ---- Team: list, invite, change role, remove (owner only for changes) ----
orgs.get('/orgs/:orgId/members', requireOrg('viewer'), ah(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, m.role, u.password_set AS "passwordSet", m.created_at AS "addedAt"
     FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY (m.role = 'owner') DESC, u.name`, [req.org.id]);
  res.json(rows);
}));

orgs.post('/orgs/:orgId/members', requireOrg('owner'), ah(async (req, res) => {
  const b = parse(z.object({ email: z.string().email(), name: z.string().min(1), role: z.enum(['owner', 'manager', 'viewer']), phone: z.string().regex(/^\d{10,15}$/).optional() }), req.body);
  const out = await tx(async (c) => {
    const { rows: [existing] } = await c.query('SELECT * FROM users WHERE lower(email) = lower($1)', [b.email]);
    let user = existing;
    if (!user) {
      ({ rows: [user] } = await c.query(
        'INSERT INTO users (email, name, password_hash, phone, password_set) VALUES (lower($1),$2,$3,$4,false) RETURNING *',
        [b.email, b.name, await bcrypt.hash(crypto.randomUUID(), 10), b.phone || null]));
    }
    const { rows: [m] } = await c.query('SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2', [user.id, req.org.id]);
    if (m) throw conflict('Ye insaan pehle se team mein hai');
    await c.query('INSERT INTO memberships (user_id, org_id, role, invited_by) VALUES ($1,$2,$3,$4)', [user.id, req.org.id, b.role, req.user.id]);
    // New login -> set-password link; existing login -> just a heads-up with the app link.
    const token = user.password_set ? null : await issueUserToken(c, { userId: user.id, purpose: 'invite', orgId: req.org.id });
    return { user, token };
  });
  const { rows: [org] } = await query('SELECT name FROM orgs WHERE id = $1', [req.org.id]);
  const link = out.token ? resetLink(out.token, 'invite') : `${config.appUrl}/orgs/${req.org.id}`;
  const channel = await deliverLink(out.user, {
    subject: `Wayne Ads — ${org.name} team mein aapka invite`,
    line: out.token ? `Aapko ${org.name} ke Wayne Ads mein ${b.role} banaya gaya hai. Password set karke shuru karein (7 din tak valid):` : `Aapko ${org.name} ke Wayne Ads mein ${b.role} access mila hai. Login karke dekhiye:`,
    link,
  });
  await logAction({ orgId: req.org.id, ...actorOf(req), what: 'member_add', after: { email: b.email.toLowerCase(), role: b.role } });
  // If nothing could deliver it, the owner gets the link to share by hand.
  res.status(201).json({ userId: out.user.id, role: b.role, delivered: channel, inviteLink: channel ? undefined : link });
}));

async function ownersCount(orgId) {
  const { rows: [r] } = await query("SELECT COUNT(*) AS n FROM memberships WHERE org_id = $1 AND role = 'owner'", [orgId]);
  return Number(r.n);
}

orgs.patch('/orgs/:orgId/members/:userId', requireOrg('owner'), ah(async (req, res) => {
  const { role } = parse(z.object({ role: z.enum(['owner', 'manager', 'viewer']) }), req.body);
  const { rows: [m] } = await query('SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2', [req.params.userId, req.org.id]);
  if (!m) throw badRequest('Ye insaan team mein nahi hai');
  if (m.role === 'owner' && role !== 'owner' && (await ownersCount(req.org.id)) <= 1) throw conflict('Kam se kam ek Owner hona zaroori hai');
  await query('UPDATE memberships SET role = $3 WHERE user_id = $1 AND org_id = $2', [req.params.userId, req.org.id, role]);
  await logAction({ orgId: req.org.id, ...actorOf(req), what: 'member_role', before: { userId: Number(req.params.userId), role: m.role }, after: { role } });
  res.json({ userId: Number(req.params.userId), role });
}));

orgs.delete('/orgs/:orgId/members/:userId', requireOrg('owner'), ah(async (req, res) => {
  const { rows: [m] } = await query('SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2', [req.params.userId, req.org.id]);
  if (!m) throw badRequest('Ye insaan team mein nahi hai');
  if (m.role === 'owner' && (await ownersCount(req.org.id)) <= 1) throw conflict('Aakhri Owner ko hata nahi sakte');
  await query('DELETE FROM memberships WHERE user_id = $1 AND org_id = $2', [req.params.userId, req.org.id]);
  await logAction({ orgId: req.org.id, ...actorOf(req), what: 'member_remove', before: { userId: Number(req.params.userId), role: m.role } });
  res.json({ removed: true });
}));

// ---- Ad accounts ----
orgs.get('/orgs/:orgId/ad-accounts', requireOrg('viewer'), ah(async (req, res) => {
  const { rows } = await query('SELECT * FROM ad_accounts WHERE org_id = $1 ORDER BY id', [req.org.id]);
  res.json(rows);
}));

// Agency mode: list what Wayne's BM can see (to attach to a client).
orgs.get('/orgs/:orgId/meta/available-accounts', requireOrg('manager'), ah(async (_req, res) => res.json(await listBusinessAdAccounts())));

orgs.post('/orgs/:orgId/ad-accounts', requireOrg('manager'), ah(async (req, res) => {
  const b = parse(z.object({
    metaAccountId: z.string().regex(/^act_\d+$/), name: z.string().optional(), currency: z.string().default('INR'), timezone: z.string().optional(),
    sectorTemplate: z.string(), pageId: z.string(), instagramId: z.string().optional(), whatsappPhone: z.string().optional(), pixelId: z.string().optional(),
    targetCpl: z.number().positive().optional(), serviceAreaPincodes: z.array(z.string().regex(/^\d{6}$/)).default([]),
  }), req.body);
  const { rows: [a] } = await query(
    `INSERT INTO ad_accounts (org_id, meta_account_id, name, currency, timezone, sector_template, page_id, instagram_id, whatsapp_phone, pixel_id, target_cpl, service_area_pincodes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [req.org.id, b.metaAccountId, b.name || null, b.currency, b.timezone || null, b.sectorTemplate, b.pageId, b.instagramId || null, b.whatsappPhone || null, b.pixelId || null, b.targetCpl || null, b.serviceAreaPincodes]);
  await enqueue('sync', 'sync-account', { adAccountId: a.id }, { jobId: `sync-${a.id}-initial` });
  res.status(201).json(a);
}));

orgs.patch('/orgs/:orgId/ad-accounts/:id', requireOrg('manager'), ah(async (req, res) => {
  const b = parse(z.object({
    sectorTemplate: z.string().optional(), pageId: z.string().optional(), instagramId: z.string().nullable().optional(), whatsappPhone: z.string().nullable().optional(),
    pixelId: z.string().nullable().optional(), targetCpl: z.number().positive().nullable().optional(), serviceAreaPincodes: z.array(z.string().regex(/^\d{6}$/)).optional(),
  }), req.body);
  const map = { sectorTemplate: 'sector_template', pageId: 'page_id', instagramId: 'instagram_id', whatsappPhone: 'whatsapp_phone', pixelId: 'pixel_id', targetCpl: 'target_cpl', serviceAreaPincodes: 'service_area_pincodes' };
  const keys = Object.keys(b);
  if (!keys.length) return res.json({});
  const { rows: [a] } = await query(`UPDATE ad_accounts SET ${keys.map((k, i) => `${map[k]} = $${i + 3}`).join(', ')} WHERE id = $1 AND org_id = $2 RETURNING *`,
    [req.params.id, req.org.id, ...keys.map((k) => b[k])]);
  res.json(a);
}));

orgs.post('/orgs/:orgId/ad-accounts/:id/sync', requireOrg('manager'), ah(async (req, res) => {
  await enqueue('sync', 'sync-account', { adAccountId: Number(req.params.id) }, { jobId: `sync-${req.params.id}-${Date.now()}` });
  res.json({ queued: true });
}));

// ---- Dashboard ----
orgs.get('/orgs/:orgId/dashboard', requireOrg('viewer'), ah(async (req, res) => {
  const days = Math.min(Number(req.query.days) || 7, 90);
  const [now, prev, campaigns, adsets, ads] = await Promise.all([
    totals(req.org.id, { days }), totals(req.org.id, { days, offsetDays: days }),
    objectPerformance(req.org.id, 'campaign', days), objectPerformance(req.org.id, 'adset', days), objectPerformance(req.org.id, 'ad', days),
  ]);
  const { rows: daily } = await query(
    "SELECT date, SUM(spend) AS spend, SUM(leads) AS leads FROM insights_daily WHERE org_id = $1 AND level = 'account' AND date > CURRENT_DATE - $2::int GROUP BY date ORDER BY date",
    [req.org.id, days]);
  const { rows: alerts } = await query("SELECT * FROM alerts WHERE org_id = $1 AND status IN ('open','dry_run') ORDER BY severity = 'critical' DESC, created_at DESC LIMIT 20", [req.org.id]);
  const { rows: [rec] } = await query('SELECT payload, week_start FROM recommendations WHERE org_id = $1 ORDER BY week_start DESC LIMIT 1', [req.org.id]);
  res.json({ days, totals: now, previous: prev, daily: daily.map((d) => ({ ...d, spend: Number(d.spend), leads: Number(d.leads) })), campaigns, adsets, ads, alerts, recommendations: rec || null });
}));

orgs.get('/orgs/:orgId/leads', requireOrg('viewer'), ah(async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, phone, city, pincode, status, out_of_area, campaign_id, ad_id, crm_lead_id, created_at FROM leads
     WHERE org_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT 200`, [req.org.id, req.query.status || null]);
  res.json(rows);
}));
