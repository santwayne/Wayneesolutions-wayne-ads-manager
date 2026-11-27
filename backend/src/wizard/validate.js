import { getTemplate } from './templates/index.js';
import { resolveGoal } from './goals.js';
import { checkCopy, applySpecialCategoryRules, SAC_RULES } from './policy.js';

const ASPECTS = { '1:1': 1, '4:5': 0.8, '9:16': 0.5625 };
const ASPECT_TOLERANCE = 0.03;

export function aspectLabel(w, h) {
  if (!w || !h) return null;
  const r = w / h;
  for (const [label, v] of Object.entries(ASPECTS)) if (Math.abs(r - v) <= ASPECT_TOLERANCE) return label;
  return null;
}

export function checkMedia(media = []) {
  const issues = [];
  if (media.length < 1) issues.push({ code: 'no_media', level: 'block', message: 'Kam se kam 1 photo/video chahiye (3–5 best)', fix: 'Photo upload karo ya AI Video Studio se import karo' });
  else if (media.length < 3) issues.push({ code: 'few_media', level: 'warn', message: '3–5 creatives se Meta jaldi seekhta hai', fix: '2-3 aur photo/video daalo' });
  media.forEach((m, i) => {
    const n = i + 1;
    const a = aspectLabel(m.width, m.height);
    if (!a) issues.push({ code: 'aspect', level: 'warn', index: i, message: `Creative ${n}: size 1:1, 4:5 ya 9:16 nahi hai`, fix: 'Crop karo (4:5 feed ke liye best)' });
    if (m.type === 'video') {
      if (m.durationSec > 60) issues.push({ code: 'video_long', level: 'warn', index: i, message: `Video ${n}: 60 sec se lamba — 15–30 sec best`, fix: 'Chhota edit karo' });
      if (m.durationSec && m.durationSec < 5) issues.push({ code: 'video_short', level: 'warn', index: i, message: `Video ${n}: bahut chhota`, fix: '6–30 sec ka video daalo' });
    }
    if (m.blurScore != null && m.blurScore < 60) issues.push({ code: 'blurry', level: 'warn', index: i, message: `Creative ${n} dhundhla lag raha hai`, fix: 'Saaf photo daalo' });
    if (m.textHeavy) issues.push({ code: 'text_heavy', level: 'warn', index: i, message: `Creative ${n} pe bahut zyada text hai, reach kam hogi`, fix: 'Image pe text kam karo, baat ad text mein likho' });
    if (m.width && m.width < 600) issues.push({ code: 'low_res', level: 'warn', index: i, message: `Creative ${n} ki quality kam hai (600px se chhota)`, fix: '1080px wali image daalo' });
  });
  return issues;
}

/**
 * Validate the whole draft (all 7 screens). Returns:
 *   { draft (normalised), checks: [...], blocking: bool, estimate }
 * `context` = { adAccount, org, reachEstimate }
 */
export function validateDraft(input, context = {}) {
  const template = getTemplate(input.sector);
  let draft = {
    sector: template.key,
    goal: input.goal || template.defaultGoal,
    location: input.location || null,          // { lat, lng, label }
    radiusKm: input.radiusKm ?? template.radiusKm,
    ageMin: input.ageMin ?? template.ageMin,
    ageMax: input.ageMax ?? template.ageMax,
    dailyBudget: input.dailyBudget ?? template.recommendedDailyBudget,
    offer: input.offer || '',
    language: input.language || template.language,
    primaryTexts: (input.primaryTexts || []).filter(Boolean),
    headlines: (input.headlines || []).filter(Boolean),
    media: input.media || [],
    websiteUrl: input.websiteUrl || null,
    pixelEvent: input.pixelEvent || 'LEAD',
    phone: input.phone || null,
    formQuestions: input.formQuestions || template.formQuestions,
    qualifyingQuestion: input.qualifyingQuestion || template.qualifyingQuestion,
    privacyPolicyUrl: input.privacyPolicyUrl || context.org?.privacy_policy_url || null,
    name: input.name || null,
  };
  const checks = [];
  const add = (c) => checks.push(c);

  // Special ad category: force restricted targeting.
  const sac = applySpecialCategoryRules(draft, template);
  draft = sac.draft;
  if (sac.changed.length) {
    add({ code: 'special_category', level: 'info', message: `${template.label}: Meta ki special ad category — age ${SAC_RULES.ageMin}-${SAC_RULES.ageMax}, gender sab, radius kam se kam ${SAC_RULES.minRadiusKm} km khud set kiya` });
  }

  const goal = resolveGoal(draft.goal, { pixelEvent: draft.pixelEvent });
  if (!template.allowedGoals.includes(draft.goal)) add({ code: 'goal_not_allowed', level: 'block', message: 'Ye goal is business type ke liye available nahi hai' });

  // Screen 3: location & audience
  if (!draft.location?.lat || !draft.location?.lng) add({ code: 'no_location', level: 'block', message: 'Map pe business ka pin lagao', fix: 'Pin lagao' });
  if (draft.radiusKm < 1 || draft.radiusKm > 80) add({ code: 'radius_range', level: 'block', message: 'Radius 1–80 km ke beech rakho' });
  if (draft.ageMin < 18 || draft.ageMax > 65 || draft.ageMin >= draft.ageMax) add({ code: 'age_range', level: 'block', message: 'Age 18–65 ke beech aur min < max honi chahiye' });
  const reach = context.reachEstimate;
  if (reach && reach.upper != null && reach.upper < 20000) {
    add({ code: 'audience_small', level: 'warn', message: `Audience bahut chhoti hai (~${reach.upper.toLocaleString('en-IN')} log) — ad mehnga padega`, fix: `Radius ${Math.min(draft.radiusKm + 5, 80)} km karo`, fixPatch: { radiusKm: Math.min(draft.radiusKm + 5, 80) } });
  }

  // Screen 4: budget
  const monthly = Math.round(draft.dailyBudget * 30.4);
  if (draft.dailyBudget < template.minDailyBudget) {
    add({ code: 'budget_low', level: 'warn', message: 'Itne mein Meta seekh nahi paayega, result kamzor aayenge.', fix: `₹${template.minDailyBudget}/din karo`, fixPatch: { dailyBudget: template.minDailyBudget } });
  }
  if (context.org?.daily_budget_cap && draft.dailyBudget > Number(context.org.daily_budget_cap)) {
    add({ code: 'budget_over_cap', level: 'block', message: `Budget owner ki daily cap ₹${context.org.daily_budget_cap} se zyada hai` });
  }
  if (context.maxDailyBudget && draft.dailyBudget > context.maxDailyBudget) {
    add({ code: 'budget_over_client', level: 'block', message: `Budget client ke bataye ₹${context.maxDailyBudget}/din se upar nahi ja sakta` });
  }

  // Screen 5: offer & creatives
  if (!draft.offer.trim()) add({ code: 'no_offer', level: 'block', message: 'Offer 1 line mein likho', fix: template.offerIdeas[0] ? `Jaise: "${template.offerIdeas[0]}"` : undefined });
  else if (!/(free|off|%|discount|₹|rs\.?|offer|deadline|aaj|today|last|limited|only|sirf|muft|trial|demo)/i.test(draft.offer)) {
    add({ code: 'weak_offer', level: 'warn', message: 'Offer kamzor lag raha hai', fix: 'Offer mein free/discount/deadline jodo' });
  }
  if (!draft.primaryTexts.length) add({ code: 'no_text', level: 'block', message: 'Kam se kam 1 ad text chuno (3 best)', fix: 'AI se 5 text banwao' });
  if (!draft.headlines.length) add({ code: 'no_headline', level: 'block', message: 'Kam se kam 1 headline chuno' });
  [...draft.primaryTexts, ...draft.headlines].forEach((txt, i) => {
    for (const issue of checkCopy(txt, template)) add({ ...issue, textIndex: i, text: txt });
  });
  for (const m of checkMedia(draft.media)) add(m);

  // Destination needs
  if (goal.needsLeadForm && !draft.privacyPolicyUrl) add({ code: 'no_privacy_policy', level: 'block', message: 'Lead form ke liye client ki privacy policy link zaroori hai (Meta rule)', fix: 'Privacy policy URL daalo' });
  if (goal.needsWhatsapp && !context.adAccount?.whatsapp_phone) add({ code: 'no_whatsapp', level: 'block', message: 'Page se WhatsApp Business number juda nahi hai', fix: 'Page settings mein WhatsApp number jodo' });
  if (goal.needsPhone && !draft.phone) add({ code: 'no_phone', level: 'block', message: 'Call ke liye phone number daalo' });
  if (goal.needsWebsite && !/^https:\/\//.test(draft.websiteUrl || '')) add({ code: 'no_website', level: 'block', message: 'Website ka https link daalo' });
  if (goal.needsPixel && !context.adAccount?.pixel_id) add({ code: 'no_pixel', level: 'warn', message: 'Pixel/Conversions API nahi laga — Meta ko pata nahi chalega kaun book kar raha hai', fix: 'Website pe Pixel lagao (developer help)' });
  if (!context.adAccount?.page_id) add({ code: 'no_page', level: 'block', message: 'Facebook Page select nahi hua' });

  const blocking = checks.some((c) => c.level === 'block');
  return {
    draft,
    template: { key: template.key, label: template.label, specialAdCategories: template.specialAdCategories },
    meta: { objective: goal.objective, optimizationGoal: goal.optimizationGoal, destinationType: goal.destinationType },
    checks,
    blocking,
    estimate: { dailyBudget: draft.dailyBudget, monthlyBudget: monthly, reach: reach || null },
  };
}
