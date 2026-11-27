import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../src/config.js';
import { pool, query } from '../src/lib/db.js';
import { migrate } from '../src/db/migrate.js';
import { encryptSecret } from '../src/lib/crypto.js';
import { createApp } from '../src/app.js';
import { setGraphFactory } from '../src/actions/service.js';
import { setWizardGraphFactory } from '../src/wizard/service.js';
import { setCapiGraphFactory, buildCrmEvent, sendCrmStage } from '../src/leads/capi.js';
import { setRazorpayFetch } from '../src/billing/razorpay.js';
import { setGoogleFetch, mapGoogleRows, syncGoogleAccount } from '../src/google/ads.js';
import { flushHubEvents } from '../src/hub/events.js';
import { enqueued } from '../src/jobs/queues.js';

const calls = [];
const fake = async () => ({
  post: async (path, params) => { calls.push({ path, params }); return path.endsWith('/events') ? { events_received: 1 } : { success: true }; },
  get: async () => ({ data: [] }), getAll: async () => [],
});
setGraphFactory(fake); setWizardGraphFactory(fake); setCapiGraphFactory(fake);

config.hub.secret = 'hub-secret';
config.tokenEncKey = crypto.randomBytes(32).toString('base64');
config.razorpay = { keyId: 'rzp_test_x', keySecret: 'rzp-secret', webhookSecret: 'rzp-wh' };
config.mcp = { accessTtlSec: 3600, refreshTtlSec: 86400 };

let server; let base; let token; let agencyId;
const api = async (method, path, body, { headers = {}, raw, auth = true } = {}) => {
  const res = await fetch(`${base}${path}`, { method, redirect: 'manual',
    headers: { ...(auth && token ? { authorization: `Bearer ${token}` } : {}), ...(body || raw ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j, headers: res.headers };
};
const hubToken = (sub, purpose = 'provision', extra = {}) => jwt.sign({ jti: crypto.randomUUID(), purpose, ...extra }, 'hub-secret', { algorithm: 'HS256', issuer: 'regulars-hub', audience: 'wayne-ads', subject: sub, expiresIn: '2m' });

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  agencyId = (await query("INSERT INTO orgs (name, type) VALUES ('Wayne','agency') RETURNING id")).rows[0].id;
  const u = (await query('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id', ['staff@wayne.test', 'Staff', await bcrypt.hash('password123', 4)])).rows[0];
  await query("INSERT INTO memberships VALUES ($1,$2,'owner')", [u.id, agencyId]);
  config.hub.agencyOrgId = agencyId;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await api('POST', '/api/auth/login', { email: 'staff@wayne.test', password: 'password123' })).body.token;
});
test.after(async () => { server.close(); await pool.end(); });

let hubOrgId;
test('Loopdesk hub: provision (create/update), single-use token, SSO exchange, pause on lapse, events outbox', async () => {
  const body = { hubBusinessId: 'hub-biz-42', active: true, business: { name: 'UJOY Bubble Tea', sector: 'RESTAURANT', country: 'IN', phone: '919800000001' }, owner: { name: 'Owner', email: 'owner@ujoy.test' }, paidUntil: '2026-12-31', tools: ['wayne-ads'] };
  const bad = await api('POST', '/api/hub/provision', body, { auth: false, headers: { authorization: 'Bearer nope' } });
  assert.equal(bad.status, 401); assert.equal(bad.body.error, 'Hub token rejected');
  // an SSO-purpose token can't provision, and a token for another business is refused
  assert.equal((await api('POST', '/api/hub/provision', body, { auth: false, headers: { authorization: `Bearer ${hubToken('hub-biz-42', 'sso')}` } })).status, 401);
  assert.equal((await api('POST', '/api/hub/provision', body, { auth: false, headers: { authorization: `Bearer ${hubToken('other')}` } })).status, 403);
  const t1 = hubToken('hub-biz-42');
  const r = await api('POST', '/api/hub/provision', body, { auth: false, headers: { authorization: `Bearer ${t1}` } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); hubOrgId = Number(r.body.accountId);
  assert.equal(r.body.status, 'ACTIVE'); assert.equal(r.body.data.sectorTemplate, 'restaurant');
  const reuse = await api('POST', '/api/hub/provision', body, { auth: false, headers: { authorization: `Bearer ${t1}` } });
  assert.equal(reuse.status, 401);
  // staff got access automatically
  const me = await api('GET', '/api/auth/me');
  assert.ok(me.body.orgs.some((o) => o.id === hubOrgId));

  assert.equal((await api('POST', '/api/hub/sso/exchange', { token: hubToken('hub-biz-42', 'provision') }, { auth: false })).status, 401);
  const sso = await api('POST', '/api/hub/sso/exchange', { token: hubToken('hub-biz-42', 'sso', { next: '/orgs/1/alerts' }) }, { auth: false });
  assert.equal(sso.status, 200); assert.equal(sso.body.orgId, hubOrgId); assert.equal(sso.body.next, '/orgs/1/alerts');
  const ownerMe = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${sso.body.token}` } }).then((x) => x.json());
  assert.equal(ownerMe.user.email, 'owner@ujoy.test');

  // a live campaign gets paused when the bundle lapses
  const acc = (await query("INSERT INTO ad_accounts (org_id, meta_account_id, sector_template, page_id) VALUES ($1,'act_9','restaurant','pg9') RETURNING id", [hubOrgId])).rows[0];
  await query("INSERT INTO campaigns (org_id, ad_account_id, meta_id, name, status, launched_at) VALUES ($1,$2,'cmp9','C','ACTIVE',now())", [hubOrgId, acc.id]);
  const lapse = await api('POST', '/api/hub/provision', { ...body, active: false }, { auth: false, headers: { authorization: `Bearer ${hubToken('hub-biz-42')}` } });
  assert.equal(lapse.status, 200); assert.equal(lapse.body.status, 'PAUSED');
  assert.equal((await query("SELECT status FROM campaigns WHERE meta_id = 'cmp9'")).rows[0].status, 'PAUSED');
  const blocked = await api('POST', '/api/hub/sso/exchange', { token: hubToken('hub-biz-42', 'sso') }, { auth: false });
  assert.equal(blocked.status, 403);

  await query("INSERT INTO hub_events_outbox (org_id, type, payload) VALUES ($1,'ads.lead_created','{\"hub_business_id\":\"hub-biz-42\"}')", [hubOrgId]);
  config.hub.eventsUrl = 'https://hub.test/api/v1/events'; config.hub.eventsKey = 'rk_live_x';
  const sent = [];
  const out = await flushHubEvents(async (url, init) => { sent.push({ url, init }); return { ok: true }; });
  assert.equal(out.sent, 1);
  assert.equal(sent[0].init.headers.authorization, 'Bearer rk_live_x');
  assert.equal(JSON.parse(sent[0].init.body).business_id, 'hub-biz-42');
});

test('Razorpay: order -> checkout signature verify credits wallet once; webhook replay does not double credit', async () => {
  const org = (await query("INSERT INTO orgs (name, type, payment_model, parent_agency_id) VALUES ('Model B Co','business','B',$1) RETURNING id", [agencyId])).rows[0].id;
  await query("INSERT INTO memberships SELECT user_id, $1, role FROM memberships WHERE org_id = $2", [org, agencyId]);
  setRazorpayFetch(async (_u, init) => ({ ok: true, json: async () => ({ id: 'order_ABC', amount: JSON.parse(init.body).amount }) }));
  const o = await api('POST', `/api/orgs/${org}/billing/orders`, { purpose: 'wallet_topup', amount: 10000 });
  assert.equal(o.status, 201, JSON.stringify(o.body)); assert.equal(o.body.orderId, 'order_ABC');
  const sig = crypto.createHmac('sha256', 'rzp-secret').update('order_ABC|pay_1').digest('hex');
  const badV = await api('POST', `/api/orgs/${org}/billing/verify`, { razorpay_order_id: 'order_ABC', razorpay_payment_id: 'pay_1', razorpay_signature: 'x'.repeat(64) });
  assert.equal(badV.status, 400);
  const v = await api('POST', `/api/orgs/${org}/billing/verify`, { razorpay_order_id: 'order_ABC', razorpay_payment_id: 'pay_1', razorpay_signature: sig });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const wh = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_ABC' } } } });
  const whSig = crypto.createHmac('sha256', 'rzp-wh').update(wh).digest('hex');
  assert.equal((await api('POST', '/webhooks/razorpay', null, { raw: wh, auth: false, headers: { 'x-razorpay-signature': whSig } })).status, 200);
  assert.equal((await api('POST', '/webhooks/razorpay', null, { raw: wh, auth: false, headers: { 'x-razorpay-signature': 'bad' } })).status, 401);
  assert.equal(Number((await query('SELECT balance FROM wallets WHERE org_id = $1', [org])).rows[0].balance), 10000);
});

test('Conversions API for CRM: stage change -> CAPI job -> event with lead_id', async () => {
  await query("UPDATE ad_accounts SET capi_dataset_id = 'ds77' WHERE meta_account_id = 'act_9'");
  await query("INSERT INTO leads (org_id, meta_lead_id, page_id, crm_lead_id, phone) VALUES ($1,'1234567890123456','pg9','crm-1','919800000002')", [hubOrgId]);
  const secretBefore = config.crm.webhookSecret; config.crm.webhookSecret = 'crm';
  const body = JSON.stringify({ crm_lead_id: 'crm-1', stage: 'won' });
  enqueued.length = 0;
  const r = await api('POST', '/webhooks/crm/lead-stage', null, { raw: body, auth: false, headers: { 'x-wayne-signature': crypto.createHmac('sha256', 'crm').update(body).digest('hex') } });
  config.crm.webhookSecret = secretBefore;
  assert.equal(r.body.updated, 1, JSON.stringify(r));
  const job = enqueued.find((j) => j.jobName === 'capi');
  calls.length = 0;
  assert.equal((await sendCrmStage(job.data.leadId)).sent, 1);
  const ev = calls[0].params.data[0];
  assert.equal(calls[0].path, 'ds77/events');
  assert.equal(ev.event_name, 'Converted'); assert.equal(ev.action_source, 'system_generated'); assert.equal(ev.user_data.lead_id, 1234567890123456);
  assert.equal(buildCrmEvent({ meta_lead_id: '1' }, 'qualified').custom_data.event_source, 'crm');
  assert.ok((await query("SELECT 1 FROM hub_events_outbox WHERE type = 'ads.customer_won'")).rows[0]);
});

test('Self-serve signup creates business + owner', async () => {
  const r = await api('POST', '/api/auth/signup', { businessName: 'Gill Salon', name: 'Gill', email: 'gill@salon.test', password: 'password123', whatsappNumber: '919811111111' }, { auth: false });
  assert.equal(r.status, 201);
  const me = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${r.body.token}` } }).then((x) => x.json());
  assert.equal(me.orgs[0].role, 'owner');
  const dup = await api('POST', '/api/auth/signup', { businessName: 'X', name: 'X', email: 'gill@salon.test', password: 'password123', whatsappNumber: '919811111111' }, { auth: false });
  assert.equal(dup.status, 400);
});

test('MCP connector: OAuth (register, PKCE, consent, token) -> tools/list -> read + destructive write', async () => {
  // metadata
  const meta = await api('GET', '/.well-known/oauth-authorization-server', null, { auth: false });
  assert.equal(meta.status, 200); assert.ok(meta.body.registration_endpoint);
  // unauthenticated MCP call -> 401 with resource metadata pointer
  const unauth = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { auth: false, headers: { accept: 'application/json, text/event-stream' } });
  assert.equal(unauth.status, 401); assert.match(unauth.headers.get('www-authenticate') || '', /resource_metadata/);

  const reg = await api('POST', '/register', { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, { auth: false });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const clientId = reg.body.client_id;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authz = await api('GET', `/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'ads.read ads.write' })}`, null, { auth: false });
  assert.equal(authz.status, 302);
  const consent = new URL(authz.headers.get('location'));
  assert.equal(consent.pathname, '/oauth/consent');
  const reqToken = consent.searchParams.get('req');
  const info = await api('GET', `/api/oauth/request?req=${encodeURIComponent(reqToken)}`);
  assert.equal(info.body.clientName, 'Claude');
  const appr = await api('POST', '/api/oauth/approve', { req: reqToken, approve: true });
  const cb = new URL(appr.body.redirect);
  assert.equal(cb.searchParams.get('state'), 'xyz');
  const tok = await api('POST', '/token', null, { auth: false, headers: { 'content-type': 'application/x-www-form-urlencoded' },
    raw: new URLSearchParams({ grant_type: 'authorization_code', code: cb.searchParams.get('code'), code_verifier: verifier, client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }).toString() });
  assert.equal(tok.status, 200, JSON.stringify(tok.body));
  const at = tok.body.access_token;
  // code is single use
  const again = await api('POST', '/token', null, { auth: false, headers: { 'content-type': 'application/x-www-form-urlencoded' },
    raw: new URLSearchParams({ grant_type: 'authorization_code', code: cb.searchParams.get('code'), code_verifier: verifier, client_id: clientId }).toString() });
  assert.equal(again.status, 400);

  const rpc = (method, params, id = 1, bearer = at) => api('POST', '/mcp', { jsonrpc: '2.0', id, method, params }, { auth: false, headers: { authorization: `Bearer ${bearer}`, accept: 'application/json, text/event-stream' } });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const list = await rpc('tools/list', {}, 2);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const tools = Object.fromEntries(list.body.result.tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(tools).sort(), ['change_budget', 'create_campaign_draft', 'get_campaign', 'get_performance', 'get_recommendations', 'launch_campaign', 'list_accounts', 'list_alerts', 'pause_ad', 'resume_ad']);
  assert.equal(tools.get_performance.annotations.readOnlyHint, true);
  assert.equal(tools.pause_ad.annotations.destructiveHint, true);
  assert.ok(Object.values(tools).every((t) => t.title));

  const accs = await rpc('tools/call', { name: 'list_accounts', arguments: {} }, 3);
  assert.ok(accs.body.result.structuredContent.businesses.some((b) => b.id === hubOrgId));

  // Pause an ad through MCP -> logged with source mcp
  const acc = (await query("SELECT id FROM ad_accounts WHERE meta_account_id = 'act_9'")).rows[0];
  const camp = (await query("SELECT id FROM campaigns WHERE meta_id = 'cmp9'")).rows[0];
  const set = (await query("INSERT INTO adsets (org_id, campaign_id, meta_id, name, status, daily_budget) VALUES ($1,$2,'set9','S','ACTIVE',500) RETURNING id", [hubOrgId, camp.id])).rows[0];
  await query("INSERT INTO ads (org_id, adset_id, meta_id, name, status) VALUES ($1,$2,'ad9','A','ACTIVE')", [hubOrgId, set.id]);
  const p = await rpc('tools/call', { name: 'pause_ad', arguments: { orgId: hubOrgId, adId: 'ad9' } }, 4);
  assert.equal(p.body.result.isError, undefined, JSON.stringify(p.body));
  assert.ok((await query("SELECT 1 FROM actions_log WHERE source = 'mcp' AND what = 'pause' AND object_id = 'ad9'")).rows[0]);
  // money safety still applies through MCP
  const b = await rpc('tools/call', { name: 'change_budget', arguments: { orgId: hubOrgId, adsetId: 'set9', dailyBudget: 900 } }, 5);
  assert.equal(b.body.result.isError, true); assert.match(b.body.result.content[0].text, /20%/);
  // no access to other businesses
  const other = await rpc('tools/call', { name: 'get_performance', arguments: { orgId: 999999 } }, 6);
  assert.equal(other.body.result.isError, true);
  // draft tool never touches Meta
  calls.length = 0;
  const d = await rpc('tools/call', { name: 'create_campaign_draft', arguments: { orgId: hubOrgId, adAccountId: acc.id, goal: 'whatsapp', latitude: 30.9, longitude: 75.85, dailyBudget: 400, offer: 'Flat 20% off on first order' } }, 7);
  assert.equal(d.body.result.isError, undefined, JSON.stringify(d.body));
  assert.ok(d.body.result.structuredContent.checklist.some((c) => /photo|creative|media/i.test(c.message)));
  assert.equal(calls.length, 0);

  // refresh token rotation
  const rt = await api('POST', '/token', null, { auth: false, headers: { 'content-type': 'application/x-www-form-urlencoded' }, raw: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token, client_id: clientId }).toString() });
  assert.equal(rt.status, 200);
  const reuse = await api('POST', '/token', null, { auth: false, headers: { 'content-type': 'application/x-www-form-urlencoded' }, raw: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token, client_id: clientId }).toString() });
  assert.equal(reuse.status, 400);
});

test('Google Ads: GAQL rows -> insights (micros -> INR, account roll-up), sync via fake API', async () => {
  const rows = [
    { campaign: { id: '11', name: 'Search', status: 'ENABLED', advertisingChannelType: 'SEARCH' }, segments: { date: '2026-11-25' }, metrics: { costMicros: '1500000000', impressions: '1000', clicks: '50', conversions: 5 } },
    { campaign: { id: '12', name: 'PMax', status: 'ENABLED', advertisingChannelType: 'PERFORMANCE_MAX' }, segments: { date: '2026-11-25' }, metrics: { costMicros: '500000000', impressions: '2000', clicks: '20', conversions: 1 } },
  ];
  const m = mapGoogleRows(rows, '1234567890');
  const acct = m.find((x) => x.level === 'account');
  assert.equal(acct.spend, 2000); assert.equal(acct.leads, 6); assert.equal(acct.objectId, 'g:customers/1234567890');

  const conn = (await query('INSERT INTO google_connections (org_id, refresh_token_enc) VALUES ($1,$2) RETURNING id', [hubOrgId, await encryptSecret('rt')])).rows[0];
  const ga = (await query("INSERT INTO google_accounts (org_id, connection_id, customer_id) VALUES ($1,$2,'1234567890') RETURNING id", [hubOrgId, conn.id])).rows[0];
  config.google.developerToken = 'dev';
  setGoogleFetch(async (url) => ({ ok: true, json: async () => (String(url).includes('oauth2') ? { access_token: 'at' } : { results: rows }) }));
  const r = await syncGoogleAccount(ga.id);
  assert.equal(r.rows, 2);
  const { rows: [i] } = await query("SELECT spend, platform FROM insights_daily WHERE object_id = 'g:customers/1234567890'");
  assert.equal(i.spend, 2000); assert.equal(i.platform, 'google');
});
