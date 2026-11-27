import { checkCopy } from '../wizard/policy.js';
import { getTemplate } from '../wizard/templates/index.js';
import { SEED_KEYWORDS } from './keywords.js';

/**
 * Pure builders for a Google Search campaign from a wizard draft (unit tested).
 * Same principles as Meta: always PAUSED, one campaign / one ad group, smart defaults,
 * people IN the area only (PRESENCE = Google's version of "location expansion OFF").
 */
export const LIMITS = { headline: 30, description: 90, headlinesMin: 3, headlinesMax: 15, descriptionsMin: 2, descriptionsMax: 4, keywordsMax: 20 };
const LANGUAGE_CONSTANTS = { english: 'languageConstants/1000', hinglish: 'languageConstants/1000', hindi: 'languageConstants/1023', punjabi: 'languageConstants/1060' };

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Google editorial: no "!" in headlines, no excessive caps/symbols, length limits. */
export function checkGoogleText(text, kind, template) {
  const issues = [];
  const max = kind === 'headline' ? LIMITS.headline : LIMITS.description;
  if (!text) issues.push({ code: 'empty', level: 'block', message: `${kind} khaali hai` });
  if (text.length > max) issues.push({ code: 'too_long', level: 'block', message: `"${text}" ${max} characters se lamba hai` });
  if (kind === 'headline' && text.includes('!')) issues.push({ code: 'exclamation', level: 'block', message: `Google headline mein "!" allowed nahi: "${text}"` });
  if (/[A-Z]{5,}/.test(text.replace(/IELTS|PTE|IVF|IUI|BHK|EMI/g, ''))) issues.push({ code: 'caps', level: 'block', message: `Zyada CAPITAL letters: "${text}"` });
  if (/(.)\1{2,}/.test(text.replace(/\d/g, '')) || /[!?]{2,}/.test(text)) issues.push({ code: 'gimmicky', level: 'block', message: `Repeated characters/symbols: "${text}"` });
  for (const i of checkCopy(text, template)) if (i.level === 'block' && i.code !== 'empty_text') issues.push(i);
  return issues;
}

export function prepareGoogleCopy({ headlines = [], descriptions = [], keywords = [] }, sector) {
  const t = getTemplate(sector);
  const h = [...new Set(headlines.map(clean))].filter((x) => !checkGoogleText(x, 'headline', t).length).slice(0, LIMITS.headlinesMax);
  const d = [...new Set(descriptions.map(clean))].filter((x) => !checkGoogleText(x, 'description', t).length).slice(0, LIMITS.descriptionsMax);
  const k = [...new Set([...(SEED_KEYWORDS[t.key] || []), ...keywords].map((x) => clean(x).toLowerCase()))]
    .filter((x) => x && x.length <= 80 && x.split(' ').length <= 10).slice(0, LIMITS.keywordsMax);
  return { headlines: h, descriptions: d, keywords: k };
}

export function validateGoogleDraft(d, copy) {
  const checks = [];
  if (!/^https:\/\//.test(d.websiteUrl || '')) checks.push({ code: 'no_website', level: 'block', message: 'Google Search ad ke liye website/landing page ka https link chahiye' });
  if (!d.location?.lat) checks.push({ code: 'no_location', level: 'block', message: 'Location pin chahiye' });
  if (copy.headlines.length < LIMITS.headlinesMin) checks.push({ code: 'few_headlines', level: 'block', message: `Kam se kam ${LIMITS.headlinesMin} sahi headlines chahiye (30 characters tak, "!" nahi)` });
  if (copy.descriptions.length < LIMITS.descriptionsMin) checks.push({ code: 'few_descriptions', level: 'block', message: `Kam se kam ${LIMITS.descriptionsMin} descriptions chahiye (90 characters tak)` });
  if (copy.keywords.length < 3) checks.push({ code: 'few_keywords', level: 'block', message: 'Kam se kam 3 keywords chahiye' });
  if (!(d.googleDailyBudget > 0)) checks.push({ code: 'no_budget', level: 'block', message: 'Google ka daily budget daalo' });
  else if (d.googleDailyBudget < 300) checks.push({ code: 'budget_low', level: 'warn', message: 'Google Search pe ₹300/din se kam mein clicks bahut kam aayenge' });
  return { checks, blocking: checks.some((c) => c.level === 'block') };
}

const micros = (rupees) => String(Math.round(Number(rupees) * 1e6));

/** One googleAds:mutate request (temp ids -1..-3) creating everything PAUSED. */
export function buildSearchCampaignOps(customerId, d, copy, { name } = {}) {
  const c = `customers/${customerId}`;
  const budget = `${c}/campaignBudgets/-1`;
  const campaign = `${c}/campaigns/-2`;
  const adGroup = `${c}/adGroups/-3`;
  const label = name || `Wayne | ${d.sector} | ${new Date().toISOString().slice(0, 10)}`;
  const ops = [
    { campaignBudgetOperation: { create: { resourceName: budget, name: `${label} budget ${Date.now()}`, amountMicros: micros(d.googleDailyBudget), deliveryMethod: 'STANDARD', explicitlyShared: false } } },
    { campaignOperation: { create: {
      resourceName: campaign, name: label, status: 'PAUSED', advertisingChannelType: 'SEARCH', campaignBudget: budget,
      maximizeConversions: {},
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
      // Only people IN the area (not "interested in") — Google's version of location expansion OFF.
      geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' },
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    } } },
    { campaignCriterionOperation: { create: { campaign, proximity: { geoPoint: { latitudeInMicroDegrees: Math.round(d.location.lat * 1e6), longitudeInMicroDegrees: Math.round(d.location.lng * 1e6) }, radius: d.radiusKm, radiusUnits: 'KILOMETERS' } } } },
    { campaignCriterionOperation: { create: { campaign, language: { languageConstant: LANGUAGE_CONSTANTS[d.language] || LANGUAGE_CONSTANTS.english } } } },
    { adGroupOperation: { create: { resourceName: adGroup, campaign, name: `${label} | ad group`, status: 'ENABLED', type: 'SEARCH_STANDARD' } } },
    ...copy.keywords.map((k) => ({ adGroupCriterionOperation: { create: { adGroup, status: 'ENABLED', keyword: { text: k, matchType: 'PHRASE' } } } })),
    { adGroupAdOperation: { create: { adGroup, status: 'ENABLED', ad: { finalUrls: [d.websiteUrl], responsiveSearchAd: {
      headlines: copy.headlines.map((text) => ({ text })), descriptions: copy.descriptions.map((text) => ({ text })),
    } } } } },
  ];
  if (d.phone) {
    // Call button on the ad (call asset) for "seedha call" goals.
    ops.push({ assetOperation: { create: { resourceName: `${c}/assets/-4`, callAsset: { countryCode: 'IN', phoneNumber: d.phone.replace(/^\+?91/, '') } } } });
    ops.push({ campaignAssetOperation: { create: { campaign, asset: `${c}/assets/-4`, fieldType: 'CALL' } } });
  }
  return { mutateOperations: ops };
}

/** Safety net like meta/graph.js: Google creates must be PAUSED; billing never touched. */
export function assertGoogleMutateAllowed(path, body) {
  if (/billingSetups|accountBudgetProposals|paymentsAccounts|invoices/i.test(path)) throw new Error('Billing endpoints are never touched by this tool');
  for (const op of body?.mutateOperations || []) {
    const camp = op.campaignOperation?.create;
    if (camp && camp.status !== 'PAUSED') throw new Error('New Google campaigns must be created PAUSED');
  }
}
