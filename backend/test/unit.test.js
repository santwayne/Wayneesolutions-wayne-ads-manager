import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { checkCopy } from '../src/wizard/policy.js';
import { getTemplate } from '../src/wizard/templates/index.js';
import { validateDraft, aspectLabel } from '../src/wizard/validate.js';
import { buildTargeting, buildAdSet, buildCampaign, buildLeadForm, planAds } from '../src/meta/builder.js';
import { resolveGoal } from '../src/wizard/goals.js';
import { evaluate, isInLearning } from '../src/rules/engine.js';
import { checkBudgetChange } from '../src/actions/service.js';
import { verifyMetaSignature, parseSignedRequest } from '../src/lib/crypto.js';
import { assertWriteAllowed, parseUsageHeaders } from '../src/meta/graph.js';
import { countResults } from '../src/meta/results.js';
import { invoiceAmounts } from '../src/wallet/service.js';
import { parseFieldData, isOutOfArea, normalisePhone } from '../src/leads/pipeline.js';
import { heuristicBrief } from '../src/ai/service.js';
import { healthScore } from '../src/reports/metrics.js';
import { moneyLine } from '../src/notify/format.js';

const ivf = getTemplate('ivf');
const ielts = getTemplate('ielts');

test('policy: IVF personal attribute + guarantees blocked, safe copy ok', () => {
  assert.ok(checkCopy('Kya aap infertile hain? Humse milein', ivf).some((i) => i.code === 'personal_attribute'));
  assert.ok(checkCopy('Are you infertile? Call now', ivf).some((i) => i.level === 'block'));
  assert.ok(checkCopy('95% success rate IVF', ivf).some((i) => i.code === 'blocked_phrase'));
  assert.equal(checkCopy('Expert IVF consultation — free first visit', ivf).filter((i) => i.level === 'block').length, 0);
});

test('policy: immigration visa guarantee blocked', () => {
  assert.ok(checkCopy('Visa guarantee ke saath Canada!', ielts).some((i) => i.level === 'block'));
  assert.ok(checkCopy('100% approval study visa', ielts).some((i) => i.level === 'block'));
  assert.ok(checkCopy('Before and after results dekho', getTemplate('salon_gym')).length > 0);
});

const goodDraft = {
  sector: 'ielts', goal: 'lead_form', location: { lat: 30.88, lng: 75.82, label: 'Model Town, Ludhiana' },
  offer: 'Free demo class + band score test', primaryTexts: ['Free demo class! Aaj hi form bharo'], headlines: ['Free IELTS demo'],
  media: [1, 2, 3].map(() => ({ type: 'image', width: 1080, height: 1350, blurScore: 300 })), privacyPolicyUrl: 'https://x.in/privacy',
};
const ctx = { adAccount: { page_id: '1' }, org: {} };

test('validate: good draft has no blockers, defaults filled from template', () => {
  const v = validateDraft(goodDraft, ctx);
  assert.equal(v.blocking, false, JSON.stringify(v.checks));
  assert.equal(v.draft.radiusKm, 12);
  assert.equal(v.meta.objective, 'OUTCOME_LEADS');
  assert.equal(v.estimate.monthlyBudget, Math.round(600 * 30.4));
});

test('validate: low budget warns with fix, missing privacy policy blocks, small audience warns', () => {
  const v = validateDraft({ ...goodDraft, dailyBudget: 100, privacyPolicyUrl: null }, { ...ctx, reachEstimate: { lower: 5000, upper: 9000 } });
  const low = v.checks.find((c) => c.code === 'budget_low');
  assert.equal(low.fixPatch.dailyBudget, 400);
  assert.ok(v.checks.find((c) => c.code === 'no_privacy_policy' && c.level === 'block'));
  assert.ok(v.checks.find((c) => c.code === 'audience_small'));
  assert.equal(v.blocking, true);
});

test('validate: weak offer warns, budget never above client number, real estate forced to SAC rules', () => {
  assert.ok(validateDraft({ ...goodDraft, offer: 'IELTS coaching' }, ctx).checks.find((c) => c.code === 'weak_offer'));
  assert.ok(validateDraft({ ...goodDraft, dailyBudget: 900 }, { ...ctx, maxDailyBudget: 500 }).checks.find((c) => c.code === 'budget_over_client'));
  const re = validateDraft({ ...goodDraft, sector: 'real_estate', ageMin: 30, ageMax: 40, radiusKm: 5 }, ctx);
  assert.deepEqual([re.draft.ageMin, re.draft.ageMax, re.draft.radiusKm], [18, 65, 25]);
});

test('media checks: aspect ratios', () => {
  assert.equal(aspectLabel(1080, 1080), '1:1');
  assert.equal(aspectLabel(1080, 1350), '4:5');
  assert.equal(aspectLabel(1080, 1920), '9:16');
  assert.equal(aspectLabel(1920, 1080), null);
});

test('builder: lead quality fixes on every ad set', () => {
  const v = validateDraft(goodDraft, ctx);
  const t = buildTargeting(v.draft);
  assert.deepEqual(t.geo_locations.location_types, ['home', 'recent']);
  assert.equal(t.geo_locations.custom_locations[0].radius, 12);
  assert.equal(t.targeting_automation.advantage_audience, 1);
  assert.equal(t.targeting_automation.individual_setting.geo, 0); // location expansion OFF
  const sac = buildTargeting(v.draft, { specialAdCategories: ['HOUSING'], excludedAudienceIds: ['99'] });
  assert.equal(sac.targeting_automation.advantage_audience, 0);
  assert.deepEqual(sac.excluded_custom_audiences, [{ id: '99' }]);

  const goal = resolveGoal('lead_form');
  assert.equal(buildCampaign(v.draft, goal, {}).status, 'PAUSED');
  const set = buildAdSet(v.draft, goal, { campaignId: 'c', pageId: 'p', targeting: t });
  assert.equal(set.status, 'PAUSED');
  assert.equal(set.daily_budget, 60000); // paise
  const form = buildLeadForm(v.draft, { privacyPolicyUrl: 'https://x', phone: '919999999999' });
  assert.equal(form.is_optimized_for_quality, true);
  assert.ok(form.questions.some((q) => q.type === 'POST_CODE'));
  assert.ok(form.questions.some((q) => q.key === 'kab_shuru'));
  assert.equal(planAds(v.draft).length, 3);
});

test('graph safety: creates must be PAUSED, billing blocked', () => {
  assert.throws(() => assertWriteAllowed('POST', 'act_1/campaigns', { status: 'ACTIVE' }), /PAUSED/);
  assert.doesNotThrow(() => assertWriteAllowed('POST', 'act_1/campaigns', { status: 'PAUSED' }));
  assert.throws(() => assertWriteAllowed('POST', 'act_1/funding_source', {}), /Billing/);
  assert.throws(() => assertWriteAllowed('POST', '123', { funding_source: 'x' }), /not allowed/);
  const u = parseUsageHeaders({ 'x-business-use-case-usage': JSON.stringify({ 1: [{ call_count: 92, estimated_time_to_regain_access: 2 }] }) });
  assert.equal(u.maxPct, 92); assert.equal(u.waitSeconds, 120);
});

test('results: no double counting of lead action types', () => {
  assert.equal(countResults([{ action_type: 'lead', value: '5' }, { action_type: 'onsite_conversion.lead_grouped', value: '5' }]), 5);
  assert.equal(countResults([{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '7' }]), 7);
});

test('budget: max +20% per change, cap respected, decrease always ok', () => {
  assert.equal(checkBudgetChange({ current: 1000, next: 1200, capTotal: null, otherActiveTotal: 0 }).ok, true);
  assert.equal(checkBudgetChange({ current: 1000, next: 1300, capTotal: null, otherActiveTotal: 0 }).ok, false);
  assert.equal(checkBudgetChange({ current: 1000, next: 1200, capTotal: 2000, otherActiveTotal: 900 }).ok, false);
  assert.equal(checkBudgetChange({ current: 1000, next: 500, capTotal: 100, otherActiveTotal: 900 }).ok, true);
  assert.equal(checkBudgetChange({ current: 500, next: 1000, capTotal: null, otherActiveTotal: 0, isUndo: true }).ok, true);
});

const days = (n, f) => Array.from({ length: n }, (_, i) => ({ date: `2026-11-${String(10 + i).padStart(2, '0')}`, ...f(i) }));
const baseSnap = (over = {}) => ({
  now: new Date('2026-11-20T10:00:00Z'), targetCpl: 200, accountAvgCpl: 200, campaigns: [], adsets: [], ads: [], leadsAwaiting: [], outOfArea: null, wallet: null, ...over,
});

test('rules: money burn fires even in learning; expensive ad blocked during learning', () => {
  const ad = { metaId: 'a1', adsetMetaId: 's1', name: 'Ad 1', status: 'ACTIVE', lifetimeSpend: 700, lifetimeLeads: 0, days: days(3, () => ({ spend: 233, leads: 0 })) };
  const learningSet = { metaId: 's1', name: 'Set', status: 'ACTIVE', dailyBudget: 500, learningStage: 'LEARNING', days: [] };
  const f = evaluate(baseSnap({ adsets: [learningSet], ads: [ad] }));
  assert.deepEqual(f.map((x) => x.ruleType), ['money_burn']);
  assert.equal(f[0].suggestedAction.type, 'pause');

  const pricey = { ...ad, lifetimeLeads: 3, days: days(3, () => ({ spend: 400, leads: 1 })) };
  assert.equal(evaluate(baseSnap({ adsets: [learningSet], ads: [pricey] })).length, 0);
  const done = { ...learningSet, learningStage: 'SUCCESS' };
  assert.ok(evaluate(baseSnap({ adsets: [done], ads: [pricey] })).some((x) => x.ruleType === 'expensive_ad'));
});

test('rules: winner suggests exactly +20%, delivery stopped, follow-up, out-of-area, wallet', () => {
  const set = { metaId: 's1', name: 'Set', status: 'ACTIVE', dailyBudget: 1000, learningStage: 'SUCCESS', days: days(3, () => ({ spend: 500, leads: 5 })) };
  const w = evaluate(baseSnap({ adsets: [set] })).find((x) => x.ruleType === 'winner');
  assert.equal(w.suggestedAction.to, 1200);
  const camp = { metaId: 'c1', name: 'C', status: 'ACTIVE', launchedAt: '2026-11-18T00:00:00Z', todayImpressions: 0, yesterdayImpressions: 0 };
  assert.ok(evaluate(baseSnap({ campaigns: [camp] })).some((x) => x.ruleType === 'delivery_stopped' && x.severity === 'critical'));
  assert.ok(evaluate(baseSnap({ leadsAwaiting: [{ id: 1, name: 'Ravi', minutesWaiting: 16 }] })).some((x) => x.ruleType === 'lead_followup'));
  assert.equal(evaluate(baseSnap({ leadsAwaiting: [{ id: 1, minutesWaiting: 10 }] })).length, 0);
  assert.ok(evaluate(baseSnap({ outOfArea: { total: 20, outOfArea: 4 } })).some((x) => x.ruleType === 'out_of_area'));
  assert.ok(evaluate(baseSnap({ wallet: { balance: 500, threshold: 2000, avgDailySpend: 250 } }))[0].message.includes('~2 din'));
});

test('rules: creative fatigue', () => {
  const ad = { metaId: 'a1', adsetMetaId: 's1', name: 'Ad', status: 'ACTIVE', lifetimeSpend: 100, lifetimeLeads: 5,
    days: days(7, (i) => ({ spend: 100, leads: 1, impressions: 1000, clicks: i < 3 ? 30 : 15, frequency: 3.5 })) };
  const set = { metaId: 's1', status: 'ACTIVE', learningStage: 'SUCCESS', days: [] };
  assert.ok(evaluate(baseSnap({ adsets: [set], ads: [ad], accountAvgCpl: 1000 })).some((x) => x.ruleType === 'creative_fatigue'));
});

test('learning phase heuristic', () => {
  assert.equal(isInLearning({ daysSinceLaunch: 2, results7d: 100 }), true);
  assert.equal(isInLearning({ daysSinceLaunch: 5, results7d: 10 }), true);
  assert.equal(isInLearning({ daysSinceLaunch: 5, results7d: 60 }), false);
  assert.equal(isInLearning({ daysSinceLaunch: 8, results7d: 1 }), false);
});

test('signatures: X-Hub-Signature-256 and signed_request', () => {
  const body = '{"a":1}';
  const sig = `sha256=${crypto.createHmac('sha256', 's3cret').update(body).digest('hex')}`;
  assert.equal(verifyMetaSignature('s3cret', body, sig), true);
  assert.equal(verifyMetaSignature('s3cret', '{"a":2}', sig), false);
  const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '42' })).toString('base64url');
  const s = crypto.createHmac('sha256', 's3cret').update(payload).digest('base64url');
  assert.equal(parseSignedRequest(`${s}.${payload}`, 's3cret').user_id, '42');
  assert.equal(parseSignedRequest(`${s}.${payload}`, 'wrong'), null);
});

test('leads: field parsing, phone normalise, out of area', () => {
  const f = parseFieldData([{ name: 'full_name', values: ['Ravi'] }, { name: 'phone_number', values: ['+91 98765-43210'] }, { name: 'post_code', values: ['141002'] }, { name: 'kab_shuru', values: ['Is hafte'] }]);
  assert.equal(f.phone, '919876543210'); assert.equal(f.pincode, '141002'); assert.equal(f.answers.kab_shuru, 'Is hafte');
  assert.equal(normalisePhone('09876543210'), '919876543210');
  assert.equal(isOutOfArea({ pincode: '800001', phone: '91x' }, ['141002']), true);
  assert.equal(isOutOfArea({ pincode: '141002', phone: '91x' }, ['141002']), false);
  assert.equal(isOutOfArea({ phone: '4479' }, []), true);
});

test('whatsapp brief heuristic: "IELTS coaching, Model Town Ludhiana, ₹15,000 mahina."', () => {
  const b = heuristicBrief('IELTS coaching, Model Town Ludhiana, ₹15,000 mahina.');
  assert.equal(b.sector, 'ielts'); assert.equal(b.area, 'Model Town Ludhiana'); assert.equal(b.dailyBudget, 493); assert.equal(b.maxDailyBudget, 493);
});

test('wallet invoice GST + health score + money line', () => {
  assert.deepEqual(invoiceAmounts({ adSpend: 10000, serviceFee: 5000, gstRate: 0.18, gstOnAdSpend: true }), { adSpend: 10000, serviceFee: 5000, gst: 2700, total: 17700 });
  assert.equal(invoiceAmounts({ adSpend: 10000, serviceFee: 5000, gstRate: 0.18, gstOnAdSpend: false }).gst, 900);
  assert.equal(healthScore({ openCritical: 1, openWarnings: 0 }), 'red');
  assert.equal(healthScore({ openCritical: 0, openWarnings: 0, cpl: 250, targetCpl: 200, outOfAreaPct: 0 }), 'yellow');
  assert.equal(healthScore({ openCritical: 0, openWarnings: 0, cpl: 150, targetCpl: 200, outOfAreaPct: 3 }), 'green');
  assert.equal(moneyLine({ spend: 4000, leads: 20, won: 2 }), '₹4,000 lage, 20 leads, ek lead ₹200 ki, CRM mein 2 customer bane (ek customer ₹2,000 ka)');
});
