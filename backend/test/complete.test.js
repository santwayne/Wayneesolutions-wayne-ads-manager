import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { pool, query } from '../src/lib/db.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { setWizardGraphFactory } from '../src/wizard/service.js';
import { setGraphFactory } from '../src/actions/service.js';
import { outbox } from '../src/notify/email.js';
import { sentLog } from '../src/notify/whatsapp.js';
import { setVideoStudioFetch } from '../src/integrations/videoStudio.js';
import { fatigueScore } from '../src/rules/engine.js';
import { overridesFor } from '../src/rules/runner.js';
import { sendMonthlyReport } from '../src/routes/reports.js';
import { buildCreative } from '../src/meta/builder.js';
import { resolveGoal } from '../src/wizard/goals.js';

const uploads = []; const posts = [];
const fake = async () => ({
  upload: async (path, fields, file) => { uploads.push({ path, fields, size: file.buffer.length }); return { id: 'vid123' }; },
  post: async (path, params) => { posts.push({ path, params }); return path.endsWith('/adimages') ? { images: { x: { hash: `h${posts.length}`, url: 'https://cdn.test/i.jpg' } } } : { id: 'v-url-1' }; },
  get: async () => ({ data: [] }), getAll: async () => [],
});
setWizardGraphFactory(fake); setGraphFactory(fake);

let server; let base; let owner; let orgId; let accId;
const api = async (method, path, body, { token, headers = {}, raw } = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const login = async (email, password) => (await api('POST', '/api/auth/login', { email, password })).body.token;
const linkToken = (text) => decodeURIComponent(/token=([^&\s]+)/.exec(text)[1]);

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  orgId = (await query("INSERT INTO orgs (name, type, whatsapp_number) VALUES ('Sky IELTS','business','919812345678') RETURNING id")).rows[0].id;
  const u = (await query("INSERT INTO users (email, name, password_hash, phone) VALUES ('owner@sky.test','Owner',$1,'919812345678') RETURNING id", [await bcrypt.hash('password123', 4)])).rows[0];
  await query("INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'owner')", [u.id, orgId]);
  accId = (await query("INSERT INTO ad_accounts (org_id, meta_account_id, sector_template, page_id, target_cpl) VALUES ($1,'act_77','ielts','pg77',200) RETURNING id", [orgId])).rows[0].id;
  server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`;
  owner = await login('owner@sky.test', 'password123');
});
test.after(async () => { server.close(); await pool.end(); });

test('forgot password: same answer for unknown email, link by email, single use, old password stops working', async () => {
  outbox.length = 0;
  const unknown = await api('POST', '/api/auth/forgot-password', { email: 'nobody@x.test' });
  const known = await api('POST', '/api/auth/forgot-password', { email: 'OWNER@sky.test' });
  assert.deepEqual(unknown.body, known.body);
  assert.equal(outbox.length, 1); assert.equal(outbox[0].to, 'owner@sky.test');
  const t = linkToken(outbox[0].text);
  assert.equal((await api('GET', `/api/auth/reset-password/check?token=${encodeURIComponent(t)}`)).body.purpose, 'reset');
  assert.equal((await api('POST', '/api/auth/reset-password', { token: t, password: 'short' })).status, 400);
  const r = await api('POST', '/api/auth/reset-password', { token: t, password: 'new-password-9' });
  assert.equal(r.status, 200); assert.ok(r.body.token);
  assert.equal((await api('POST', '/api/auth/reset-password', { token: t, password: 'another-pass-1' })).status, 400);
  assert.equal((await api('POST', '/api/auth/login', { email: 'owner@sky.test', password: 'password123' })).status, 401);
  owner = await login('owner@sky.test', 'new-password-9');
  assert.ok(owner);
});

let managerId;
test('team: invite -> set password via link -> login; role change + remove guarded; last owner protected', async () => {
  outbox.length = 0;
  const inv = await api('POST', `/api/orgs/${orgId}/members`, { email: 'Ravi@sky.test', name: 'Ravi', role: 'manager' }, { token: owner });
  assert.equal(inv.status, 201, JSON.stringify(inv.body)); assert.equal(inv.body.delivered, 'email');
  managerId = inv.body.userId;
  assert.equal((await api('POST', `/api/orgs/${orgId}/members`, { email: 'ravi@sky.test', name: 'Ravi', role: 'viewer' }, { token: owner })).status, 409);
  const t = linkToken(outbox[0].text);
  const chk = await api('GET', `/api/auth/reset-password/check?token=${encodeURIComponent(t)}`);
  assert.equal(chk.body.purpose, 'invite'); assert.equal(chk.body.orgName, 'Sky IELTS');
  const acc = await api('POST', '/api/auth/reset-password', { token: t, password: 'ravi-password-1', name: 'Ravi Kumar' });
  assert.equal(acc.body.orgId, orgId);
  const mgr = await login('ravi@sky.test', 'ravi-password-1');
  const list = await api('GET', `/api/orgs/${orgId}/members`, null, { token: mgr });
  assert.equal(list.body.length, 2); assert.equal(list.body.find((m) => m.email === 'ravi@sky.test').name, 'Ravi Kumar');
  // manager can't manage the team
  assert.equal((await api('PATCH', `/api/orgs/${orgId}/members/${managerId}`, { role: 'owner' }, { token: mgr })).status, 403);
  const ownerId = list.body.find((m) => m.role === 'owner').id;
  assert.equal((await api('PATCH', `/api/orgs/${orgId}/members/${ownerId}`, { role: 'viewer' }, { token: owner })).status, 409);
  assert.equal((await api('DELETE', `/api/orgs/${orgId}/members/${ownerId}`, null, { token: owner })).status, 409);
  assert.equal((await api('PATCH', `/api/orgs/${orgId}/members/${managerId}`, { role: 'viewer' }, { token: owner })).body.role, 'viewer');
  assert.equal((await api('DELETE', `/api/orgs/${orgId}/members/${managerId}`, null, { token: owner })).status, 200);
  assert.equal((await api('GET', `/api/orgs/${orgId}`, null, { token: mgr })).status, 403);
});

test('wizard video: file upload (multipart to Meta), cover photo, link import, Video Studio list, thumbnail required', async () => {
  const d = await api('POST', `/api/orgs/${orgId}/drafts`, { adAccountId: accId, data: {} }, { token: owner });
  const id = d.body.id;
  const video = crypto.randomBytes(200_000);
  const up = await api('POST', `/api/orgs/${orgId}/drafts/${id}/media/video?width=1080&height=1920&duration=18&name=demo`, null, { token: owner, raw: video, headers: { 'content-type': 'video/mp4' } });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.item.videoId, 'vid123'); assert.equal(uploads[0].path, 'act_77/advideos'); assert.equal(uploads[0].size, 200_000);
  let v = await api('GET', `/api/orgs/${orgId}/drafts/${id}/validate?reach=0`, null, { token: owner });
  assert.ok(v.body.checks.some((c) => c.code === 'video_thumb' && c.level === 'block'));
  const cover = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#335' } }).jpeg().toBuffer();
  const th = await api('POST', `/api/orgs/${orgId}/drafts/${id}/media/0/thumbnail`, null, { token: owner, raw: cover, headers: { 'content-type': 'image/jpeg' } });
  assert.equal(th.status, 200, JSON.stringify(th.body)); assert.ok(th.body.item.thumbnailHash);
  v = await api('GET', `/api/orgs/${orgId}/drafts/${id}/validate?reach=0`, null, { token: owner });
  assert.equal(v.body.checks.some((c) => c.code === 'video_thumb'), false);
  // creative uses image_hash for the cover
  const cr = buildCreative({ goal: 'lead_form' }, resolveGoal('lead_form'), { media: th.body.item, primaryText: 'x', headline: 'y', pageId: 'p', leadFormId: 'f' });
  assert.equal(cr.object_story_spec.video_data.image_hash, th.body.item.thumbnailHash);

  // link import (AI Video Studio finished video)
  const li = await api('POST', `/api/orgs/${orgId}/drafts/${id}/media`, { type: 'video', fileUrl: 'https://aivideo.test/static/ads/a1/v916.mp4', aspect: '9:16', durationSec: 15, thumbnailUrl: 'https://aivideo.test/static/ads/a1/s0.jpg', source: 'video_studio' }, { token: owner });
  assert.equal(li.status, 201, JSON.stringify(li.body)); assert.deepEqual([li.body.item.width, li.body.item.height], [1080, 1920]);
  assert.equal(posts.at(-1).params.file_url, 'https://aivideo.test/static/ads/a1/v916.mp4');
  assert.equal((await api('POST', `/api/orgs/${orgId}/drafts/${id}/media`, { type: 'video', fileUrl: 'http://insecure.test/v.mp4' }, { token: owner })).status, 400);

  // Video Studio list: not linked -> clear message; linked hub client -> signed token + items
  assert.equal((await api('GET', `/api/orgs/${orgId}/video-studio/videos`, null, { token: owner })).status, 501);
  process.env.VIDEO_STUDIO_API_URL = 'https://aivideo.test'; process.env.VIDEO_STUDIO_LINK_SECRET = 's'.repeat(40);
  assert.equal((await api('GET', `/api/orgs/${orgId}/video-studio/videos`, null, { token: owner })).status, 409);
  await query("UPDATE orgs SET hub_business_id = 'hub-sky' WHERE id = $1", [orgId]);
  let seen;
  setVideoStudioFetch(async (url, init) => { seen = { url, auth: init.headers.authorization }; return { ok: true, json: async () => ({ items: [{ id: 'a1:9:16', title: 'Demo reel', url: 'https://aivideo.test/v.mp4', thumbnail_url: 'https://aivideo.test/t.jpg', seconds: 15, aspect: '9:16', width: 1080, height: 1920 }] }) }; });
  const vs = await api('GET', `/api/orgs/${orgId}/video-studio/videos`, null, { token: owner });
  assert.equal(vs.status, 200); assert.equal(vs.body[0].title, 'Demo reel');
  assert.equal(seen.url, 'https://aivideo.test/api/v1/hub/videos');
  const claims = jwt.verify(seen.auth.slice(7), 's'.repeat(40), { audience: 'videoStudio', issuer: 'wayne-ads' });
  assert.equal(claims.sub, 'hub-sky'); assert.equal(claims.purpose, 'list_videos');
});

test('AI offer ideas (template fallback) are logged', async () => {
  const d = await api('POST', `/api/orgs/${orgId}/drafts`, { adAccountId: accId, data: { offer: 'IELTS coaching' } }, { token: owner });
  const r = await api('POST', `/api/orgs/${orgId}/drafts/${d.body.id}/offer-ideas`, null, { token: owner });
  assert.equal(r.status, 200); assert.equal(r.body.offers.length, 3);
  assert.ok((await query("SELECT 1 FROM actions_log WHERE what = 'ai_decision' AND after->>'step' = 'offer_ideas'")).rows[0]);
});

test('rules: template thresholds sit between defaults and owner settings; fatigue score', async () => {
  let o = await overridesFor(orgId, 'ivf');
  assert.equal(o.money_burn.cplMultiple, 4); assert.equal(o.lead_followup.minutes, 10);
  await api('PUT', `/api/orgs/${orgId}/rules/money_burn`, { enabled: true, threshold: { cplMultiple: 2 } }, { token: owner });
  o = await overridesFor(orgId, 'ivf');
  assert.equal(o.money_burn.cplMultiple, 2); assert.equal(o.lead_followup.minutes, 10);
  const rules = await api('GET', `/api/orgs/${orgId}/rules`, null, { token: owner });
  assert.equal(rules.body.find((r) => r.ruleType === 'lead_followup').threshold.minutes, 10); // ielts template
  const days = Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-0${i + 1}`, impressions: 1000, clicks: i < 3 ? 30 : 15, frequency: 3.4 }));
  assert.equal(fatigueScore(days), 100);
  assert.equal(fatigueScore(days.map((x) => ({ ...x, clicks: 30, frequency: 1.5 }))), 25);
  assert.equal(fatigueScore([]), 0);
});

test('monthly report: JSON, PDF, public share link (revocable), 1st-of-month send once', async () => {
  const m = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
  for (let i = 0; i < 5; i++) {
    await query(`INSERT INTO insights_daily (org_id, level, object_id, date, spend, leads, impressions, clicks) VALUES ($1,'account','act_77',$2::date + $3::int, 1000, 5, 9000, 150)`, [orgId, `${m}-01`, i]);
  }
  await query("INSERT INTO campaigns (org_id, ad_account_id, meta_id, name, status) VALUES ($1,$2,'c77','Demo class','ACTIVE')", [orgId, accId]);
  await query(`INSERT INTO insights_daily (org_id, level, object_id, date, spend, leads) VALUES ($1,'campaign','c77',$2::date, 5000, 25)`, [orgId, `${m}-01`]);
  await query("INSERT INTO leads (org_id, meta_lead_id, status, created_at) VALUES ($1,'lm1','won',$2::date + 1), ($1,'lm2','new',$2::date + 1)", [orgId, `${m}-01`]);
  const j = await api('GET', `/api/orgs/${orgId}/reports/monthly?month=${m}`, null, { token: owner });
  assert.equal(j.status, 200); assert.equal(j.body.totals.spend, 5000); assert.equal(j.body.totals.cpl, 200); assert.equal(j.body.totals.won, 1); assert.equal(j.body.campaigns[0].name, 'Demo class');
  const pdf = await api('GET', `/api/orgs/${orgId}/reports/monthly.pdf?month=${m}`, null, { token: owner });
  assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf'); assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await api('GET', `/api/orgs/${orgId}/reports/monthly?month=2026-13`, null, { token: owner })).status, 400);

  const link = await api('POST', `/api/orgs/${orgId}/report-links`, { days: 30 }, { token: owner });
  const token = link.body.url.split('/r/')[1];
  const pub = await api('GET', `/api/public/reports/${token}?month=${m}`);
  assert.equal(pub.status, 200); assert.equal(pub.body.business, 'Sky IELTS');
  assert.equal((await api('GET', `/api/public/reports/${token}/pdf?month=${m}`)).body.subarray(0, 5).toString(), '%PDF-');
  const links = await api('GET', `/api/orgs/${orgId}/report-links`, null, { token: owner });
  await api('DELETE', `/api/orgs/${orgId}/report-links/${links.body[0].id}`, null, { token: owner });
  assert.equal((await api('GET', `/api/public/reports/${token}`)).status, 404);
  assert.equal((await api('GET', '/api/public/reports/not-a-real-token')).status, 404);

  sentLog.length = 0; outbox.length = 0;
  const s1 = await sendMonthlyReport(orgId, m);
  assert.equal(s1.sent, true);
  assert.match(sentLog[0].text.body, /report/); assert.match(sentLog[0].text.body, /\/r\//);
  assert.equal(outbox[0].attachments[0].contentType, 'application/pdf');
  assert.equal((await sendMonthlyReport(orgId, m)).skipped, 'already sent');
});
