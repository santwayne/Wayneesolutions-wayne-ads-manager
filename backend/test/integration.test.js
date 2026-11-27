import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { pool, query } from '../src/lib/db.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { setGraphFactory } from '../src/actions/service.js';
import { setWizardGraphFactory } from '../src/wizard/service.js';
import { setLeadsGraphFactory, processLead } from '../src/leads/pipeline.js';
import { setIntegrationsOverride } from '../src/leads/integrations.js';
import { sentLog } from '../src/notify/whatsapp.js';
import { enqueued } from '../src/jobs/queues.js';
import { runRulesForAccount } from '../src/rules/runner.js';
import { checkWallet } from '../src/wallet/service.js';
import { handleInbound, setMediaDownloader } from '../src/whatsapp-mode/conversation.js';

// ---- Fake Meta Graph API: records every call, never talks to Meta ----
const calls = [];
let seq = 1000;
function fakeGraph() {
  const post = async (path, params) => {
    calls.push({ method: 'POST', path, params });
    if (path.endsWith('/adimages')) return { images: { x: { hash: `hash${seq++}`, url: 'https://cdn.example/img.jpg' } } };
    if (/\/(campaigns|adsets|ads|adcreatives|leadgen_forms|customaudiences|advideos)$/.test(path)) return { id: String(seq++) };
    return { success: true };
  };
  const get = async (path, params) => {
    calls.push({ method: 'GET', path, params });
    if (path.endsWith('/delivery_estimate')) return { data: [{ estimate_mau_lower_bound: 80000, estimate_mau_upper_bound: 120000 }] };
    if (path.startsWith('lead')) {
      return { id: path, created_time: new Date().toISOString(), ad_id: 'ad1', adset_id: 'set1', campaign_id: 'camp1', form_id: 'form1',
        field_data: [{ name: 'full_name', values: ['Ravi Kumar'] }, { name: 'phone_number', values: ['9876543210'] }, { name: 'post_code', values: [path.endsWith('bihar') ? '800001' : '141002'] }] };
    }
    return {};
  };
  return { post, get, getAll: async () => [], batch: async () => [] };
}
const gf = async () => fakeGraph();
setGraphFactory(gf); setWizardGraphFactory(gf); setLeadsGraphFactory(gf);
const crmCalls = []; const ringCalls = [];
setIntegrationsOverride({
  crmUpsertLead: async (orgId, lead) => { crmCalls.push(lead); return { crmLeadId: `crm-${lead.phone}` }; },
  wayneRingCall: async (orgId, lead) => { ringCalls.push(lead); return { ok: true }; },
});
config.meta.appSecret = 'test-app-secret';
config.whatsapp.appSecret = 'test-app-secret';
config.rules.dryRun = false;

let server; let base; let token;
const api = async (method, path, body, { raw, headers = {} } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
};
const sign = (s) => `sha256=${crypto.createHmac('sha256', 'test-app-secret').update(s).digest('hex')}`;

const OWNER_WA = '919812345678';
let agencyId; let clientId; let accountId;

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  const { rows: [a] } = await query("INSERT INTO orgs (name, type) VALUES ('Wayne E Solutions','agency') RETURNING id");
  agencyId = a.id;
  const { rows: [u] } = await query('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id', ['admin@wayne.test', 'Admin', await bcrypt.hash('password123', 4)]);
  await query("INSERT INTO memberships VALUES ($1,$2,'owner')", [u.id, agencyId]);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

test('login, create Model B client + ad account', async () => {
  const r = await api('POST', '/api/auth/login', { email: 'admin@wayne.test', password: 'password123' });
  assert.equal(r.status, 200); token = r.body.token;
  const c = await api('POST', `/api/orgs/${agencyId}/clients`, { name: 'Sky IELTS', whatsappNumber: OWNER_WA, paymentModel: 'B', serviceFeeMonthly: 5000, privacyPolicyUrl: 'https://skyielts.in/privacy' });
  assert.equal(c.status, 201); clientId = c.body.id;
  const acc = await api('POST', `/api/orgs/${clientId}/ad-accounts`, { metaAccountId: 'act_123', sectorTemplate: 'ielts', pageId: 'page1', targetCpl: 200, serviceAreaPincodes: ['141002', '141001'] });
  assert.equal(acc.status, 201); accountId = acc.body.id;
  const denied = await api('GET', '/api/orgs/999999');
  assert.equal(denied.status, 403);
});

let metaCampaignId; let adsetMetaId; let adMetaIds;
test('wizard: draft -> validate -> AI copy -> media -> create (PAUSED) -> launch', async () => {
  const d = await api('POST', `/api/orgs/${clientId}/drafts`, { adAccountId: accountId, data: {} });
  assert.equal(d.status, 201);
  const id = d.body.id;
  assert.equal(d.body.data.sector, 'ielts');
  await api('PATCH', `/api/orgs/${clientId}/drafts/${id}`, { goal: 'lead_form', location: { lat: 30.89, lng: 75.83, label: 'Model Town, Ludhiana' }, dailyBudget: 600, offer: 'Free demo class + band score test' });
  let v = await api('GET', `/api/orgs/${clientId}/drafts/${id}/validate`);
  assert.equal(v.body.blocking, true);
  assert.ok(v.body.checks.some((c) => c.code === 'no_text'));
  assert.equal(v.body.estimate.reach.upper, 120000);

  const copy = await api('POST', `/api/orgs/${clientId}/drafts/${id}/copy`);
  assert.equal(copy.status, 200);
  assert.ok(copy.body.primaryTexts.length >= 3);
  await api('PATCH', `/api/orgs/${clientId}/drafts/${id}`, { primaryTexts: copy.body.primaryTexts.slice(0, 3), headlines: copy.body.headlines.slice(0, 2) });

  const img = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: '#3355aa' } }).composite([{ input: Buffer.from('<svg width="1080" height="1350"><rect x="100" y="100" width="400" height="400" fill="white"/><circle cx="700" cy="900" r="200" fill="yellow"/></svg>') }]).jpeg().toBuffer();
  for (let i = 0; i < 3; i++) {
    const m = await api('POST', `/api/orgs/${clientId}/drafts/${id}/media`, null, { raw: img, headers: { 'content-type': 'image/jpeg' } });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    assert.equal(m.body.item.width, 1080);
  }
  v = await api('GET', `/api/orgs/${clientId}/drafts/${id}/validate?reach=0`);
  assert.equal(v.body.blocking, false, JSON.stringify(v.body.checks));

  calls.length = 0;
  const cr = await api('POST', `/api/orgs/${clientId}/drafts/${id}/create`);
  assert.equal(cr.status, 201, JSON.stringify(cr.body));
  assert.equal(cr.body.status, 'PAUSED');
  assert.equal(cr.body.ads.length, 3);
  const creates = calls.filter((c) => /\/(campaigns|adsets|ads)$/.test(c.path));
  assert.ok(creates.every((c) => c.params.status === 'PAUSED'));
  const form = calls.find((c) => c.path.endsWith('/leadgen_forms'));
  assert.equal(form.params.is_optimized_for_quality, true);
  const adset = calls.find((c) => c.path.endsWith('/adsets'));
  assert.equal(adset.params.targeting.targeting_automation.individual_setting.geo, 0);
  metaCampaignId = cr.body.metaCampaignId; adsetMetaId = cr.body.adsetId; adMetaIds = cr.body.ads;

  const again = await api('POST', `/api/orgs/${clientId}/drafts/${id}/create`);
  assert.equal(again.status, 409);

  // Model B: wallet empty -> no launch
  const noMoney = await api('POST', `/api/orgs/${clientId}/campaigns/${metaCampaignId}/launch`);
  assert.equal(noMoney.status, 409);
  const top = await api('POST', `/api/orgs/${clientId}/wallet/topup`, { amount: 20000, ref: 'UPI-TEST-1' });
  assert.equal(top.body.balance, 20000);
  const l = await api('POST', `/api/orgs/${clientId}/campaigns/${metaCampaignId}/launch`);
  assert.equal(l.status, 200, JSON.stringify(l.body));
  const { rows: [camp] } = await query('SELECT status, launched_at FROM campaigns WHERE meta_id = $1', [metaCampaignId]);
  assert.equal(camp.status, 'ACTIVE'); assert.ok(camp.launched_at);
});

test('budget safety: +30% refused, +20% ok, owner cap enforced, undo restores', async () => {
  const r1 = await api('POST', `/api/orgs/${clientId}/adsets/${adsetMetaId}/budget`, { dailyBudget: 780 });
  assert.equal(r1.status, 409);
  const r2 = await api('POST', `/api/orgs/${clientId}/adsets/${adsetMetaId}/budget`, { dailyBudget: 720 });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  await api('PATCH', `/api/orgs/${clientId}/settings`, { dailyBudgetCap: 750 });
  const r3 = await api('POST', `/api/orgs/${clientId}/adsets/${adsetMetaId}/budget`, { dailyBudget: 860 });
  assert.equal(r3.status, 409);
  const u = await api('POST', `/api/orgs/${clientId}/undo`);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  const { rows: [s] } = await query('SELECT daily_budget FROM adsets WHERE meta_id = $1', [adsetMetaId]);
  assert.equal(s.daily_budget, 600);
});

test('rules: money-burn alert -> WhatsApp Haan/Na -> owner taps Haan -> ad paused -> undo', async () => {
  const ad = adMetaIds[0];
  for (let i = 0; i < 3; i++) {
    await query(`INSERT INTO insights_daily (org_id, level, object_id, date, spend, impressions, leads) VALUES ($1,'ad',$2,CURRENT_DATE - $3::int, 250, 3000, 0)`, [clientId, ad, i]);
  }
  sentLog.length = 0;
  const { rows: [acc] } = await query('SELECT * FROM ad_accounts WHERE id = $1', [accountId]);
  const alerts = await runRulesForAccount(acc);
  const burn = alerts.find((a) => a.rule_type === 'money_burn');
  assert.ok(burn, JSON.stringify(alerts));
  const wa = sentLog.find((m) => m.type === 'interactive');
  assert.equal(wa.to, OWNER_WA);
  assert.deepEqual(wa.interactive.action.buttons.map((b) => b.reply.title), ['Haan', 'Na']);
  // dedupe: running again does not create a second open alert
  assert.equal((await runRulesForAccount(acc)).filter((a) => a.rule_type === 'money_burn').length, 0);

  // Owner taps "Haan" on WhatsApp (signed webhook -> queue -> handler)
  const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ id: 'wamid.1', from: OWNER_WA, type: 'interactive', interactive: { button_reply: { id: `alert:${burn.id}:yes`, title: 'Haan' } } }] } }] }] });
  const bad = await api('POST', '/webhooks/whatsapp', null, { raw: payload, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=bad' } });
  assert.equal(bad.status, 401);
  enqueued.length = 0;
  const ok = await api('POST', '/webhooks/whatsapp', null, { raw: payload, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload) } });
  assert.equal(ok.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  const job = enqueued.find((j) => j.jobName === 'inbound');
  await handleInbound(job.data);
  const { rows: [a1] } = await query('SELECT status FROM ads WHERE meta_id = $1', [ad]);
  assert.equal(a1.status, 'PAUSED');
  const { rows: [al] } = await query('SELECT status, approved_by FROM alerts WHERE id = $1', [burn.id]);
  assert.equal(al.status, 'approved'); assert.equal(al.approved_by, `whatsapp:${OWNER_WA}`);
  const log = await api('GET', `/api/orgs/${clientId}/actions-log`);
  assert.ok(log.body.some((l) => l.what === 'pause' && l.source === 'whatsapp'));
  await api('POST', `/api/orgs/${clientId}/undo`);
  const { rows: [a2] } = await query('SELECT status FROM ads WHERE meta_id = $1', [ad]);
  assert.equal(a2.status, 'ACTIVE');
});

test('leads: signed leadgen webhook -> CRM (dup phone = same lead) -> out-of-area tagged, no AI call', async () => {
  await api('PATCH', `/api/orgs/${clientId}/settings`, { aiCallEnabled: true });
  const body = JSON.stringify({ object: 'page', entry: [{ id: 'page1', changes: [{ field: 'leadgen', value: { leadgen_id: 'lead-local', page_id: 'page1', form_id: 'form1' } }] }] });
  assert.equal((await api('POST', '/webhooks/meta', null, { raw: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' } })).status, 401);
  enqueued.length = 0;
  assert.equal((await api('POST', '/webhooks/meta', null, { raw: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) } })).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  const job = enqueued.find((j) => j.jobName === 'process-lead');
  assert.ok(job);
  const r1 = await processLead(job.data);
  assert.equal(r1.lead.crm_lead_id, 'crm-919876543210');
  assert.equal(r1.lead.out_of_area, false);
  assert.ok(enqueued.some((j) => j.jobName === 'wayne-ring'));

  enqueued.length = 0;
  const r2 = await processLead({ leadgenId: 'lead-bihar', pageId: 'page1' });
  assert.equal(r2.lead.out_of_area, true);
  assert.equal(r2.lead.crm_lead_id, 'crm-919876543210'); // same phone -> same CRM lead
  assert.equal(enqueued.some((j) => j.jobName === 'wayne-ring'), false);
  assert.ok(enqueued.some((j) => j.jobName === 'audience-sync'));

  // CRM stage webhook -> won -> cost per customer
  config.crm.webhookSecret = 'crm-secret';
  const stage = JSON.stringify({ crm_lead_id: 'crm-919876543210', stage: 'won' });
  const sig = crypto.createHmac('sha256', 'crm-secret').update(stage).digest('hex');
  const s = await api('POST', '/webhooks/crm/lead-stage', null, { raw: stage, headers: { 'content-type': 'application/json', 'x-wayne-signature': sig } });
  assert.equal(s.body.updated, 2);
});

test('data deletion callback returns url + confirmation code, status page works', async () => {
  const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '555' })).toString('base64url');
  const sr = `${crypto.createHmac('sha256', 'test-app-secret').update(payload).digest('base64url')}.${payload}`;
  const r = await api('POST', '/webhooks/meta/data-deletion', null, { raw: `signed_request=${sr}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.confirmation_code);
  const page = await fetch(`${base}/deletion-status?code=${r.body.confirmation_code}`);
  assert.match(await page.text(), /request is received/);
});

test('wallet: running spend beyond balance auto-pauses all ads + WhatsApp', async () => {
  await query("INSERT INTO insights_daily (org_id, level, object_id, date, spend) VALUES ($1,'account','act_123',CURRENT_DATE, 25000) ON CONFLICT (level, object_id, date) DO UPDATE SET spend = 25000", [clientId]);
  sentLog.length = 0;
  const r = await checkWallet(clientId);
  assert.equal(r.paused, 1);
  const { rows: [c] } = await query('SELECT status FROM campaigns WHERE meta_id = $1', [metaCampaignId]);
  assert.equal(c.status, 'PAUSED');
  assert.match(sentLog[0].text.body, /Wallet khatam/);
});

test('dashboard + agency overview', async () => {
  const d = await api('GET', `/api/orgs/${clientId}/dashboard?days=7`);
  assert.equal(d.status, 200);
  assert.equal(d.body.totals.spend, 25000);
  const o = await api('GET', '/api/agency/overview');
  assert.equal(o.body.clients[0].name, 'Sky IELTS');
  assert.ok(['red', 'yellow', 'green'].includes(o.body.clients[0].health));
});

test('WhatsApp Mode: brief -> 3 follow-ups -> preview -> Badlo -> Haan -> launched', async () => {
  await query("UPDATE wallets SET balance = 50000, auto_paused = false WHERE org_id = $1", [clientId]);
  await query("UPDATE orgs SET daily_budget_cap = NULL WHERE id = $1", [clientId]);
  const img = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: '#aa3355' } }).composite([{ input: Buffer.from('<svg width="1080" height="1080"><rect x="200" y="200" width="300" height="500" fill="white"/></svg>') }]).jpeg().toBuffer();
  setMediaDownloader(async () => ({ buffer: img, mimeType: 'image/jpeg' }));
  sentLog.length = 0;
  const say = (m) => handleInbound({ from: OWNER_WA, type: 'text', ...m });
  const last = () => sentLog[sentLog.length - 1];

  let r = await say({ text: 'IELTS coaching, Model Town Ludhiana, ₹15,000 mahina.' });
  assert.equal(r.asked, 'offer');
  assert.match(last().text.body, /offer/);
  assert.match(last().text.body, /location pin/); // no geocoder in tests
  await say({ text: 'Free demo class + band score test' });
  assert.match(last().text.body, /Leads kaise chahiye/);
  await say({ text: '1' });
  assert.match(last().text.body, /photos/);
  for (let i = 0; i < 3; i++) await handleInbound({ from: OWNER_WA, type: 'image', image: { id: `m${i}` } });
  r = await handleInbound({ from: OWNER_WA, type: 'location', location: { latitude: 30.89, longitude: 75.83, name: 'Model Town' } });
  assert.equal(r.preview, true);
  assert.equal(r.blocking, false);
  const preview = last();
  assert.equal(preview.type, 'interactive');
  assert.match(preview.interactive.body.text, /₹493\/din/);
  assert.deepEqual(preview.interactive.action.buttons.map((b) => b.reply.title), ['Haan, launch karo', 'Badlo']);
  const draftId = preview.interactive.action.buttons[0].reply.id.split(':')[1];

  await handleInbound({ from: OWNER_WA, type: 'interactive', buttonId: `draft:${draftId}:change` });
  r = await say({ text: 'area 5 km karo' });
  assert.match(last().interactive.body.text, /5 km/);
  r = await say({ text: 'budget ₹900 din karo' });
  assert.match(sentLog.find((m) => m.text?.body?.includes('upar nahi'))?.text.body || '', /upar nahi/);

  calls.length = 0;
  r = await handleInbound({ from: OWNER_WA, type: 'interactive', buttonId: `draft:${draftId}:launch` });
  assert.ok(r.launched, JSON.stringify(r));
  assert.match(last().text.body, /live/);
  const { rows: [camp] } = await query('SELECT status FROM campaigns WHERE meta_id = $1', [r.launched.metaCampaignId]);
  assert.equal(camp.status, 'ACTIVE');
  const { rows: aiLogs } = await query("SELECT * FROM actions_log WHERE org_id = $1 AND what = 'ai_decision'", [clientId]);
  assert.ok(aiLogs.length >= 3);
});
