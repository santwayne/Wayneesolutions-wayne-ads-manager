import test from 'node:test';
import assert from 'node:assert/strict';
import { GOALS, OBJECTIVE_GROUPS, listGoals, resolveGoal } from '../src/wizard/goals.js';
import { validateDraft } from '../src/wizard/validate.js';
import { buildAdSet, buildCampaign, buildCreative, planAds } from '../src/meta/builder.js';

const OBJECTIVES = ['OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_APP_PROMOTION', 'OUTCOME_SALES'];
const PROMOTED = ['page', 'page_whatsapp', 'pixel', 'app', 'catalog', 'event'];
const CREATIVE = ['link', 'lead_form', 'whatsapp', 'messenger', 'instagram_dm', 'call', 'app', 'post', 'page_like', 'event', 'ig_profile', 'catalog'];

test('templates: all 6 Meta objectives covered, every template well formed', () => {
  assert.deepEqual(OBJECTIVE_GROUPS.map((g) => g.objective), OBJECTIVES);
  for (const gr of OBJECTIVE_GROUPS) assert.ok(Object.values(GOALS).filter((g) => g.group === gr.key).length >= 4, gr.key);
  for (const [k, g] of Object.entries(GOALS)) {
    assert.ok(OBJECTIVES.includes(g.objective), k);
    assert.ok(g.label && g.help && g.optimizationGoal && g.cta && g.result, k);
    assert.ok(PROMOTED.includes(g.promoted), `${k} promoted`);
    assert.ok(CREATIVE.includes(g.creative), `${k} creative`);
  }
  assert.ok(Object.keys(GOALS).length >= 45);
  for (const k of ['lead_form', 'whatsapp', 'call', 'website', 'store_visit']) assert.ok(GOALS[k], `legacy ${k}`);
  assert.equal(listGoals().find((g) => g.key === 'ap_installs').needs.app, true);
});

const base = {
  sector: 'restaurant', location: { lat: 30.9, lng: 75.85 }, offer: 'Flat 20% off today',
  primaryTexts: ['Flat 20% off aaj!'], headlines: ['20% off'], privacyPolicyUrl: 'https://x.in/p',
  websiteUrl: 'https://x.in', phone: '+919999999999', appId: '123', appStoreUrl: 'https://play.google.com/store/apps/details?id=x',
  postId: '555', eventId: '777', catalogId: '888', productSetId: '999',
  media: [
    { type: 'image', width: 1080, height: 1350, blurScore: 300, imageHash: 'h1' },
    { type: 'video', width: 1080, height: 1920, durationSec: 20, videoId: 'v1', thumbnailUrl: 'https://x.in/t.jpg' },
    { type: 'image', width: 1080, height: 1080, blurScore: 300, imageHash: 'h2' },
  ],
};
const ctx = { adAccount: { page_id: 'P', whatsapp_phone: '+919', instagram_id: 'IG', pixel_id: 'PX' }, org: {} };

test('templates: every template validates with full inputs and builds Meta payloads', () => {
  for (const key of Object.keys(GOALS)) {
    const v = validateDraft({ ...base, goal: key }, ctx);
    assert.equal(v.blocking, false, `${key}: ${JSON.stringify(v.checks.filter((c) => c.level === 'block'))}`);
    const goal = resolveGoal(key, { pixelEvent: v.draft.pixelEvent });
    const c = buildCampaign(v.draft, goal, {});
    assert.equal(c.status, 'PAUSED');
    assert.equal(c.objective, goal.objective);
    const set = buildAdSet(v.draft, goal, { campaignId: 'c', pageId: 'P', whatsappPhone: '+919', pixelId: 'PX', targeting: {} });
    assert.equal(set.status, 'PAUSED');
    assert.equal(set.optimization_goal, goal.optimizationGoal);
    const plan = planAds(v.draft, goal);
    assert.ok(plan.length >= 1);
    if (goal.needsVideo) assert.ok(plan.every((p) => p.media.type === 'video'), key);
    const cr = buildCreative(v.draft, goal, { media: plan[0].media || {}, primaryText: plan[0].primaryText, headline: plan[0].headline, pageId: 'P', leadFormId: 'F', phone: v.draft.phone });
    assert.ok(cr.object_story_id || cr.object_story_spec, key);
  }
});

test('templates: missing inputs block with clear checks', () => {
  const codes = (goal, extra = {}) => validateDraft({ ...base, appId: null, appStoreUrl: null, postId: null, eventId: null, catalogId: null, productSetId: null, media: [base.media[0]], goal, ...extra }, { ...ctx, adAccount: { page_id: 'P' } }).checks.filter((c) => c.level === 'block').map((c) => c.code);
  assert.ok(codes('ap_installs').includes('no_app'));
  assert.ok(codes('ap_installs').includes('no_app_store_url'));
  assert.ok(codes('en_post_engagement').includes('no_post'));
  assert.ok(codes('en_event_responses').includes('no_event'));
  assert.ok(codes('sl_catalog').includes('no_product_set'));
  assert.ok(codes('aw_thruplay').includes('no_video'));
  assert.ok(codes('en_instagram_dm').includes('no_instagram'));
  assert.ok(codes('nope').includes('unknown_goal'));
  // Post boost does not need offer/text/media.
  const post = validateDraft({ goal: 'en_post_engagement', sector: 'other', location: base.location, postId: '5' }, ctx);
  assert.equal(post.blocking, false, JSON.stringify(post.checks));
});

test('templates: promoted objects and creatives match Meta shapes', () => {
  const d = validateDraft({ ...base, goal: 'ap_events' }, ctx).draft;
  const set = buildAdSet(d, GOALS.ap_events, { campaignId: 'c', pageId: 'P', targeting: {} });
  assert.deepEqual(set.promoted_object, { application_id: '123', object_store_url: base.appStoreUrl, custom_event_type: 'PURCHASE' });
  assert.equal(set.destination_type, undefined);
  const cat = validateDraft({ ...base, goal: 'sl_catalog' }, ctx).draft;
  assert.deepEqual(buildCampaign(cat, GOALS.sl_catalog, {}).promoted_object, { product_catalog_id: '888' });
  const cr = buildCreative(cat, GOALS.sl_catalog, { media: {}, primaryText: 't', headline: 'h', pageId: 'P' });
  assert.equal(cr.product_set_id, '999');
  assert.ok(cr.object_story_spec.template_data);
  assert.equal(buildCreative({ postId: '5' }, GOALS.en_post_engagement, { pageId: 'P' }).object_story_id, 'P_5');
  const sale = validateDraft({ ...base, goal: 'sl_website_purchase' }, ctx).draft;
  assert.equal(buildAdSet(sale, GOALS.sl_website_purchase, { pixelId: 'PX', targeting: {} }).promoted_object.custom_event_type, 'PURCHASE');
  // Legacy goals unchanged.
  const lf = validateDraft({ ...base, goal: 'whatsapp' }, ctx).draft;
  assert.deepEqual(buildAdSet(lf, GOALS.whatsapp, { pageId: 'P', whatsappPhone: '+919', targeting: {} }).promoted_object, { page_id: 'P', whatsapp_phone_number: '+919' });
});
