import { toMinor } from './sync.js';

/**
 * Pure builders for Meta object payloads (no I/O) — unit tested.
 * Lead-quality fixes from the spec are applied here on EVERY ad set.
 */

/**
 * "Reach more people likely to respond" (location expansion) — must be explicitly OFF.
 * The exact Marketing API field must be verified against the current docs for the
 * configured META_API_VERSION (run `npm run verify:meta` on the sandbox account).
 * It is kept as a JSON patch in env so it can be corrected without a code change.
 */
export function geoExpansionOffPatch() {
  const raw = process.env.META_GEO_EXPANSION_OFF_PATCH;
  if (raw === undefined) return { targeting_automation: { individual_setting: { geo: 0 } } };
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('META_GEO_EXPANSION_OFF_PATCH is not valid JSON'); }
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a?.[k] || {}, v) : v;
  }
  return out;
}

export function buildTargeting(draft, { specialAdCategories = [], excludedAudienceIds = [] } = {}) {
  const isSac = specialAdCategories.length > 0;
  let t = {
    geo_locations: {
      custom_locations: [{
        latitude: draft.location.lat,
        longitude: draft.location.lng,
        radius: draft.radiusKm,
        distance_unit: 'kilometer',
      }],
      // Only option Meta accepts now: people living in or recently in the location.
      location_types: ['home', 'recent'],
    },
    age_min: draft.ageMin,
    age_max: draft.ageMax,
    // Broad / Advantage+ audience by default (newbies make interest mistakes).
    // Must be sent explicitly (0/1) on v23+. Not supported with special ad categories.
    targeting_automation: { advantage_audience: isSac ? 0 : 1 },
  };
  if (excludedAudienceIds.length) t.excluded_custom_audiences = excludedAudienceIds.map((id) => ({ id }));
  t = deepMerge(t, geoExpansionOffPatch());
  return t;
}

export function buildCampaign(draft, goal, { specialAdCategories = [], name }) {
  const c = {
    name: name || `Wayne | ${draft.sector} | ${new Date().toISOString().slice(0, 10)}`,
    objective: goal.objective,
    status: 'PAUSED',
    special_ad_categories: specialAdCategories,
    // One campaign, one ad set (spec rule 5); budget lives on the ad set.
    is_adset_budget_sharing_enabled: false,
  };
  // Catalog sales: the catalog is set on the campaign, the product set on the ad set.
  if (goal.promoted === 'catalog') c.promoted_object = { product_catalog_id: draft.catalogId };
  return c;
}

/** Ad set promoted_object for each template's `promoted` shape. */
export function buildPromotedObject(draft, goal, { pageId, whatsappPhone, pixelId }) {
  const event = draft.pixelEvent || goal.pixelEvent || 'LEAD';
  switch (goal.promoted) {
    case 'page_whatsapp': return { page_id: pageId, whatsapp_phone_number: whatsappPhone };
    case 'pixel': return { pixel_id: pixelId, custom_event_type: event };
    case 'app': {
      const o = { application_id: draft.appId, object_store_url: draft.appStoreUrl };
      if (['APP_EVENTS', 'VALUE'].includes(goal.optimizationGoal)) o.custom_event_type = event;
      return o;
    }
    case 'catalog': return { product_set_id: draft.productSetId, pixel_id: pixelId, custom_event_type: event };
    case 'event': return { page_id: pageId, event_id: draft.eventId };
    default: return { page_id: pageId };
  }
}

export function buildAdSet(draft, goal, { campaignId, pageId, whatsappPhone, pixelId, targeting, name }) {
  const p = {
    name: name || `Wayne | ${draft.sector} | ${draft.radiusKm}km`,
    campaign_id: campaignId,
    status: 'PAUSED',
    daily_budget: toMinor(draft.dailyBudget),
    billing_event: 'IMPRESSIONS',
    optimization_goal: goal.optimizationGoal,
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    targeting,
  };
  if (goal.destinationType) p.destination_type = goal.destinationType;
  p.promoted_object = buildPromotedObject(draft, goal, { pageId, whatsappPhone, pixelId });
  return p;
}

export function buildLeadForm(draft, { privacyPolicyUrl, phone, whatsappPhone, name }) {
  const questions = [
    { type: 'FULL_NAME' },
    { type: 'PHONE' },
    { type: 'CITY' },
    { type: 'POST_CODE' }, // used for "out of area" tagging
  ];
  for (const q of [...(draft.formQuestions || []), draft.qualifyingQuestion].filter(Boolean)) {
    questions.push({
      type: 'CUSTOM',
      key: q.key,
      label: q.label,
      ...(q.options?.length ? { options: q.options.map((o, i) => ({ value: o, key: `${q.key}_${i}` })) } : {}),
    });
  }
  const thankYou = whatsappPhone
    ? { title: 'Shukriya! Hum jaldi contact karenge', body: 'Abhi baat karni hai? WhatsApp karein.', button_type: 'WHATSAPP', button_text: 'WhatsApp karein', business_phone_number: whatsappPhone }
    : { title: 'Shukriya! Hum jaldi contact karenge', body: 'Abhi baat karni hai? Call karein.', button_type: 'CALL_BUSINESS', button_text: 'Call karein', business_phone_number: phone };
  return {
    name: name || `Wayne ${draft.sector} ${Date.now()}`,
    locale: 'en_US',
    questions,
    privacy_policy: { url: privacyPolicyUrl, link_text: 'Privacy Policy' },
    // Higher intent form (review step before submit) — docs: is_optimized_for_quality
    is_optimized_for_quality: true,
    // Filter organic (non-targeted) leads
    block_display_for_non_targeted_viewer: true,
    thank_you_page: thankYou,
    question_page_custom_headline: draft.offer?.slice(0, 60) || undefined,
  };
}

export function buildCreative(draft, goal, { media, primaryText, headline, pageId, instagramId, leadFormId, phone, name }) {
  const creativeName = name || `Wayne creative ${Date.now()}`;
  // Boost an existing Page post: the creative is just the post.
  if (goal.creative === 'post') return { name: creativeName, object_story_id: `${pageId}_${draft.postId}` };

  const story = { page_id: pageId };
  if (instagramId) story.instagram_user_id = instagramId;

  const cta = { type: goal.cta };
  let link = draft.websiteUrl || `https://facebook.com/${pageId}`;
  switch (goal.creative) {
    case 'lead_form': cta.value = { lead_gen_form_id: leadFormId }; break;
    case 'whatsapp': cta.value = { app_destination: 'WHATSAPP' }; link = 'https://api.whatsapp.com/send'; break;
    case 'messenger': cta.value = { app_destination: 'MESSENGER' }; link = `https://facebook.com/${pageId}`; break;
    case 'instagram_dm': cta.value = { app_destination: 'INSTAGRAM_DIRECT' }; link = 'https://www.instagram.com/'; break;
    case 'call': cta.value = { link: `tel:${phone}` }; break;
    case 'app': link = draft.appStoreUrl; cta.value = { application: draft.appId, link }; break;
    case 'page_like': link = `https://facebook.com/${pageId}`; cta.value = { page: pageId }; break;
    case 'event': link = `https://www.facebook.com/events/${draft.eventId}`; cta.value = { link }; break;
    case 'ig_profile': link = 'https://www.instagram.com/'; break;
    case 'catalog':
      // Dynamic (catalog) ad: Meta fills image/name/price per product.
      story.template_data = { message: primaryText, name: headline || '{{product.name}}', link, call_to_action: { type: goal.cta } };
      return { name: creativeName, object_story_spec: story, product_set_id: draft.productSetId };
    default: cta.value = { link };
  }

  if (media.type === 'video') {
    const v = { ...(cta.value || {}) };
    if (!v.link && !['lead_form', 'whatsapp', 'messenger', 'instagram_dm'].includes(goal.creative)) v.link = link;
    story.video_data = {
      video_id: media.videoId,
      ...(media.thumbnailHash ? { image_hash: media.thumbnailHash } : { image_url: media.thumbnailUrl }),
      message: primaryText,
      title: headline,
      call_to_action: { ...cta, value: v },
    };
  } else {
    story.link_data = { image_hash: media.imageHash, message: primaryText, name: headline, link, call_to_action: cta };
  }
  return { name: creativeName, object_story_spec: story };
}

/** 3–5 ads: pair each media with a text/headline (round robin). */
export function planAds(draft, goal) {
  // Post boost / catalog ads: a single ad, no uploaded media.
  if (goal && ['post', 'catalog'].includes(goal.creative)) {
    return [{ media: null, primaryText: draft.primaryTexts?.[0] || null, headline: draft.headlines?.[0] || null }];
  }
  // Video-optimised goals only run the videos.
  const pool = goal?.needsVideo ? draft.media.filter((m) => m.type === 'video') : draft.media;
  const media = pool.slice(0, 5);
  const texts = draft.primaryTexts.slice(0, 3);
  const heads = draft.headlines.slice(0, 3);
  const n = Math.min(5, Math.max(media.length, Math.min(3, texts.length)));
  return Array.from({ length: n }, (_, i) => ({
    media: media[i % media.length],
    primaryText: texts[i % texts.length],
    headline: heads[i % heads.length],
  }));
}
