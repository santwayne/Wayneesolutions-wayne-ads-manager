import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../lib/db.js';
import { AppError, badRequest, notFound, conflict } from '../lib/errors.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { requireAuth, requireOrg } from '../lib/auth.js';
import { ah, parse, actorOf } from '../routes/util.js';
import { logAction } from '../actions/service.js';

/**
 * Google Ads API (Phase 2): connect via Google OAuth, pick customer accounts, daily
 * metrics into insights_daily (platform='google', ids prefixed "g:") so dashboards and
 * weekly reports show Meta + Google spend together. Pause/resume campaigns goes through
 * actions_log like Meta. No campaign creation here yet (wizard is Meta-only).
 * Version from GOOGLE_ADS_API_VERSION (REST: googleads.googleapis.com/<version>/...).
 */
let gfetch = (u, i) => fetch(u, i);
export function setGoogleFetch(fn) { gfetch = fn; }

const SCOPE = 'https://www.googleapis.com/auth/adwords';
const base = () => `https://googleads.googleapis.com/${config.google.apiVersion}`;

async function accessToken(refreshToken) {
  const r = await gfetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const j = await r.json();
  if (!r.ok) throw new AppError(502, 'google_auth', j.error_description || 'Google token refresh failed');
  return j.access_token;
}

async function gads(conn, method, path, body) {
  const at = await accessToken(await decryptSecret(conn.refresh_token_enc));
  const headers = { authorization: `Bearer ${at}`, 'developer-token': config.google.developerToken, 'content-type': 'application/json' };
  if (conn.login_customer_id) headers['login-customer-id'] = conn.login_customer_id;
  const r = await gfetch(`${base()}/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new AppError(502, 'google_ads_error', j.error?.message || `Google Ads ${r.status}`);
  return j;
}

export async function searchAll(conn, customerId, gaql) {
  const rows = []; let pageToken;
  do {
    const j = await gads(conn, 'POST', `customers/${customerId}/googleAds:search`, { query: gaql, ...(pageToken ? { pageToken } : {}) });
    rows.push(...(j.results || []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return rows;
}

/** GAQL rows -> insights_daily rows (cost_micros -> rupees; conversions = leads). */
export function mapGoogleRows(rows, customerId) {
  const out = [];
  const acct = new Map();
  for (const r of rows) {
    const date = r.segments.date;
    const spend = Number(r.metrics.costMicros || 0) / 1e6;
    const m = { date, spend, impressions: Number(r.metrics.impressions || 0), clicks: Number(r.metrics.clicks || 0), leads: Math.round(Number(r.metrics.conversions || 0)) };
    out.push({ level: 'campaign', objectId: `g:${r.campaign.id}`, ...m });
    const a = acct.get(date) || { level: 'account', objectId: `g:customers/${customerId}`, date, spend: 0, impressions: 0, clicks: 0, leads: 0 };
    a.spend += m.spend; a.impressions += m.impressions; a.clicks += m.clicks; a.leads += m.leads;
    acct.set(date, a);
  }
  return [...out, ...acct.values()];
}

export async function syncGoogleAccount(googleAccountId, { days = 3 } = {}) {
  const { rows: [ga] } = await query('SELECT g.*, row_to_json(c.*) AS conn FROM google_accounts g JOIN google_connections c ON c.id = g.connection_id WHERE g.id = $1', [googleAccountId]);
  if (!ga) throw notFound('Google account nahi mila');
  const gaql = `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, segments.date,
    metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
    FROM campaign WHERE segments.date DURING ${days <= 7 ? 'LAST_7_DAYS' : 'LAST_30_DAYS'}`;
  const rows = await searchAll(ga.conn, ga.customer_id, gaql);
  await tx(async (c) => {
    for (const r of rows) {
      await c.query(`INSERT INTO google_campaigns (org_id, google_account_id, campaign_id, name, status, channel) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (google_account_id, campaign_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, channel = EXCLUDED.channel`,
      [ga.org_id, ga.id, String(r.campaign.id), r.campaign.name, r.campaign.status, r.campaign.advertisingChannelType]);
    }
    for (const m of mapGoogleRows(rows, ga.customer_id)) {
      await c.query(`INSERT INTO insights_daily (org_id, platform, level, object_id, date, spend, impressions, clicks, leads, cpl)
        VALUES ($1,'google',$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (level, object_id, date) DO UPDATE SET spend = EXCLUDED.spend, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, leads = EXCLUDED.leads, cpl = EXCLUDED.cpl`,
      [ga.org_id, m.level, m.objectId, m.date, m.spend, m.impressions, m.clicks, m.leads, m.leads ? Math.round((m.spend / m.leads) * 100) / 100 : null]);
    }
  });
  await query('UPDATE google_accounts SET last_synced_at = now() WHERE id = $1', [ga.id]);
  return { rows: rows.length };
}

export async function setGoogleCampaignStatus({ orgId, campaignId, status, actor }) {
  if (!['PAUSED', 'ENABLED'].includes(status)) throw badRequest('status PAUSED ya ENABLED');
  const { rows: [gc] } = await query(
    `SELECT gc.*, ga.customer_id, row_to_json(c.*) AS conn FROM google_campaigns gc JOIN google_accounts ga ON ga.id = gc.google_account_id
     JOIN google_connections c ON c.id = ga.connection_id WHERE gc.org_id = $1 AND gc.campaign_id = $2`, [orgId, campaignId]);
  if (!gc) throw notFound('Google campaign nahi mila');
  if (gc.status === status) return { unchanged: true };
  if (status === 'ENABLED' && !['user', 'whatsapp', 'mcp'].includes(actor.source)) throw conflict('Enable sirf insaan kar sakta hai');
  await gads(gc.conn, 'POST', `customers/${gc.customer_id}/campaigns:mutate`, {
    operations: [{ update: { resourceName: `customers/${gc.customer_id}/campaigns/${campaignId}`, status }, updateMask: 'status' }],
  });
  await query('UPDATE google_campaigns SET status = $2 WHERE id = $1', [gc.id, status]);
  return { log: await logAction({ orgId, who: actor.who, source: actor.source, what: status === 'PAUSED' ? 'pause' : 'resume', level: 'google_campaign', objectId: `g:${campaignId}`, before: { status: gc.status }, after: { status } }) };
}

// ---- Routes ----
export const google = Router();

google.get('/orgs/:orgId/google/login-url', requireOrg('owner'), (req, res) => {
  const state = jwt.sign({ org: req.org.id, u: req.user.id, k: 'google' }, config.jwtSecret, { expiresIn: '10m' });
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({ client_id: config.google.clientId, redirect_uri: `${config.publicBaseUrl}/google/callback`, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', state }).toString();
  res.json({ url: u.toString() });
});

export const googleCallback = ah(async (req, res) => {
  let st; try { st = jwt.verify(String(req.query.state || ''), config.jwtSecret); } catch { throw badRequest('Link expire ho gaya'); }
  const r = await gfetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: String(req.query.code || ''), client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: `${config.publicBaseUrl}/google/callback`, grant_type: 'authorization_code' }),
  });
  const j = await r.json();
  if (!j.refresh_token) throw badRequest('Google ne refresh token nahi diya — dobara connect karein');
  await query('INSERT INTO google_connections (org_id, refresh_token_enc) VALUES ($1,$2)', [st.org, await encryptSecret(j.refresh_token)]);
  res.redirect(`${config.appUrl}/orgs/${st.org}/settings?google=connected`);
});

async function latestConn(orgId) {
  const { rows: [c] } = await query("SELECT * FROM google_connections WHERE org_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 1", [orgId]);
  if (!c) throw notFound('Pehle Google Ads connect karein');
  return c;
}

google.get('/orgs/:orgId/google/customers', requireOrg('owner'), ah(async (req, res) => {
  const conn = await latestConn(req.org.id);
  const j = await gads(conn, 'GET', 'customers:listAccessibleCustomers');
  res.json((j.resourceNames || []).map((r) => r.split('/')[1]));
}));

google.post('/orgs/:orgId/google/accounts', requireOrg('owner'), ah(async (req, res) => {
  const b = parse(z.object({ customerId: z.string().regex(/^\d{10}$/), loginCustomerId: z.string().regex(/^\d{10}$/).optional() }), req.body);
  const conn = await latestConn(req.org.id);
  if (b.loginCustomerId) await query('UPDATE google_connections SET login_customer_id = $2 WHERE id = $1', [conn.id, b.loginCustomerId]);
  const info = await searchAll({ ...conn, login_customer_id: b.loginCustomerId || conn.login_customer_id }, b.customerId, 'SELECT customer.descriptive_name, customer.currency_code FROM customer');
  const { rows: [ga] } = await query(
    `INSERT INTO google_accounts (org_id, connection_id, customer_id, name, currency) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (customer_id) DO UPDATE SET connection_id = EXCLUDED.connection_id RETURNING *`,
    [req.org.id, conn.id, b.customerId, info[0]?.customer?.descriptiveName || null, info[0]?.customer?.currencyCode || null]);
  if (ga.org_id !== req.org.id) throw badRequest('Ye Google account kisi aur business se juda hai');
  res.status(201).json(ga);
}));

google.get('/orgs/:orgId/google/campaigns', requireOrg('viewer'), ah(async (req, res) => {
  const { rows } = await query(
    `SELECT gc.campaign_id, gc.name, gc.status, gc.channel, COALESCE(SUM(i.spend),0) AS spend, COALESCE(SUM(i.leads),0) AS leads
     FROM google_campaigns gc LEFT JOIN insights_daily i ON i.object_id = 'g:' || gc.campaign_id AND i.date > CURRENT_DATE - 7
     WHERE gc.org_id = $1 GROUP BY gc.id ORDER BY spend DESC`, [req.org.id]);
  res.json(rows);
}));

google.post('/orgs/:orgId/google/campaigns/:campaignId/status', requireOrg('manager'), ah(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['PAUSED', 'ENABLED']) }), req.body);
  res.json(await setGoogleCampaignStatus({ orgId: req.org.id, campaignId: req.params.campaignId, status, actor: actorOf(req) }));
}));
