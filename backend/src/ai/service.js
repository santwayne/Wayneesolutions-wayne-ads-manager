import { askJson, aiAvailable } from './claude.js';
import { checkCopy } from '../wizard/policy.js';
import { getTemplate, TEMPLATES } from '../wizard/templates/index.js';

const LANG = { hinglish: 'Hinglish (Hindi in Roman script mixed with English)', english: 'simple Indian English', punjabi: 'Punjabi in Roman script mixed with English' };

function policyBrief(t) {
  return [
    'Meta ad policy rules you MUST follow:',
    '- Never assert or imply the reader has a personal attribute or condition (health, finances, etc). Bad: "Kya aap infertile hain?" Good: "Expert IVF consultation".',
    '- No guarantees, success-rate claims, "100%", before/after or misleading claims.',
    t.blockedPhrases?.length ? `- Never use: ${t.blockedPhrases.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

const clean = (arr, t) => (arr || []).map((s) => String(s).trim()).filter((s) => s && !checkCopy(s, t).some((i) => i.level === 'block'));

/** Screen 5: 5 primary texts + 3 headlines, policy-checked. */
export async function generateCopy({ sector, offer, language = 'hinglish', businessName, area, goal }) {
  const t = getTemplate(sector);
  if (!aiAvailable()) return fallbackCopy(t, offer, businessName, area);
  const system = `You write Facebook/Instagram ad copy for small Indian local businesses. Tone: ${t.tone}. ${policyBrief(t)}`;
  const prompt = `Business: ${businessName || t.label} (${t.label}) in ${area || 'their city'}.
Offer: ${offer}
Goal: ${goal || t.defaultGoal}
Language: ${LANG[language] || LANG.hinglish}
Write 5 different primary texts (2-4 short lines each, offer in the first line, clear call to action, 1-2 emojis max) and 3 headlines (max 40 chars).
JSON: {"primaryTexts": [5 strings], "headlines": [3 strings]}`;
  let out = await askJson({ system, prompt });
  let texts = clean(out.primaryTexts, t); let heads = clean(out.headlines, t);
  if (texts.length < 5 || heads.length < 3) {
    out = await askJson({ system, prompt: `${prompt}\nSome earlier lines broke policy. Write fresh, fully policy-safe ones.` });
    texts = [...texts, ...clean(out.primaryTexts, t)].slice(0, 5);
    heads = [...heads, ...clean(out.headlines, t)].slice(0, 3);
  }
  return { primaryTexts: texts, headlines: heads };
}

function fallbackCopy(t, offer, name, area) {
  const n = name || t.label; const a = area ? ` ${area} mein` : '';
  return {
    primaryTexts: [
      `${offer}! ✨\n${n}${a} — abhi apni details bhejein, hum aapko call karenge.`,
      `${n}${a}: ${offer}.\nLimited time offer — aaj hi book karein.`,
      `Soch rahe ho? ${offer}.\nNeeche button dabao, hamari team aapse baat karegi.`,
      `${offer} 👉 ${n}${a}.\nHazaron customers ka bharosa. Abhi contact karein.`,
      `Is mahine ka special: ${offer}.\n${n} — details ke liye form bharein.`,
    ].filter((s) => !checkCopy(s, t).some((i) => i.level === 'block')),
    headlines: [offer.slice(0, 40), `${n}${a}`.slice(0, 40), 'Aaj hi book karein'],
  };
}

/** Ad rejected -> policy-safe rewrite. */
export async function rewriteRejected({ sector, text, reason }) {
  const t = getTemplate(sector);
  if (!aiAvailable()) return { primaryText: fallbackCopy(t, 'Special offer', null, null).primaryTexts[0] };
  const out = await askJson({
    system: `You fix Facebook ads rejected by Meta. ${policyBrief(t)}`,
    prompt: `Rejected text:\n${text}\nMeta reason: ${reason}\nRewrite it in the same language and tone so it is policy-safe. JSON: {"primaryText": string}`,
  });
  const ok = clean([out.primaryText], t);
  return { primaryText: ok[0] || null };
}

/**
 * Monday recommendations: 7/30 day data + template benchmarks -> 3 actions + 5 copies.
 * Structured JSON. AI never changes Meta directly — these are suggestions only.
 */
export async function weeklyRecommendations({ sector, businessName, targetCpl, last7, last30, objects }) {
  const t = getTemplate(sector);
  if (!aiAvailable()) return fallbackRecommendations({ last7, objects, targetCpl });
  const system = `You are a senior Meta ads strategist for small Indian businesses. You give exactly 3 clear actions in simple Hinglish. Be conservative: no big changes to ad sets still in learning. Budget increases max 20%. ${policyBrief(t)}`;
  const prompt = `Business: ${businessName} (${t.label}). Target cost per lead: ₹${targetCpl || t.targetCpl}.
Last 7 days totals: ${JSON.stringify(last7)}
Last 30 days totals: ${JSON.stringify(last30)}
Per campaign/adset/ad last 7 days: ${JSON.stringify(objects).slice(0, 12000)}
Return JSON: {"summary": "2 lines Hinglish", "actions": [{"type": "pause"|"scale"|"test", "title": "short Hinglish", "why": "1 line with numbers", "level": "ad"|"adset"|"campaign"|null, "objectId": "meta id or null"}] (exactly 3), "copies": [5 new primary texts]}`;
  const out = await askJson({ system, prompt, maxTokens: 3000 });
  return {
    summary: String(out.summary || ''),
    actions: (out.actions || []).slice(0, 3).map((a) => ({ type: ['pause', 'scale', 'test'].includes(a.type) ? a.type : 'test', title: String(a.title || ''), why: String(a.why || ''), level: a.level || null, objectId: a.objectId || null })),
    copies: clean(out.copies, t).slice(0, 5),
  };
}

function fallbackRecommendations({ last7, objects = [], targetCpl }) {
  const ads = objects.filter((o) => o.level === 'ad' && o.spend > 0);
  const worst = [...ads].sort((a, b) => (b.cpl ?? Infinity) - (a.cpl ?? Infinity))[0];
  const best = [...objects.filter((o) => o.level === 'adset' && o.cpl)].sort((a, b) => a.cpl - b.cpl)[0];
  const actions = [];
  if (worst) actions.push({ type: 'pause', title: `"${worst.name}" band karo`, why: worst.cpl ? `Lead ₹${Math.round(worst.cpl)} ki` : 'Kharcha hua, lead nahi', level: 'ad', objectId: worst.objectId });
  if (best && targetCpl && best.cpl < targetCpl) actions.push({ type: 'scale', title: `"${best.name}" ka budget 20% badhao`, why: `Lead ₹${Math.round(best.cpl)} ki, target se sasti`, level: 'adset', objectId: best.objectId });
  actions.push({ type: 'test', title: '2 naye video creatives test karo', why: 'Naye creatives se CPL kam hota hai', level: null, objectId: null });
  return { summary: `Pichle hafte ₹${Math.round(last7?.spend || 0)} lage, ${last7?.leads || 0} leads.`, actions: actions.slice(0, 3), copies: [] };
}

/**
 * WhatsApp Mode step 2: pull sector, location, budget (and anything else) out of free text.
 * e.g. "IELTS coaching, Model Town Ludhiana, ₹15,000 mahina."
 */
export async function parseBrief(message) {
  if (!aiAvailable()) return heuristicBrief(message);
  const out = await askJson({
    system: 'You extract ad campaign details from WhatsApp messages written by Indian small business owners in Hinglish/English/Punjabi.',
    prompt: `Message: """${message}"""
Sectors allowed: ${Object.keys(TEMPLATES).join(', ')}.
Return JSON: {"sector": one of allowed or null, "businessDescription": string|null, "area": "locality, city" or null, "budgetAmount": number|null, "budgetPeriod": "day"|"month"|null, "offer": string|null, "goal": "lead_form"|"whatsapp"|"call"|"website"|"store_visit"|null, "language": "hinglish"|"english"|"punjabi"|null}`,
  });
  return normaliseBrief(out);
}

export function heuristicBrief(message) {
  const m = message.toLowerCase();
  const sectorWords = { ielts: ['ielts', 'pte', 'immigration', 'visa', 'study abroad'], ivf: ['ivf', 'fertility', 'hospital', 'clinic'], restaurant: ['restaurant', 'cafe', 'dhaba', 'food', 'pizza'], furniture: ['furniture', 'sofa'], salon_gym: ['salon', 'gym', 'parlour', 'spa'], car_dealer: ['car', 'showroom'], real_estate: ['property', 'flat', 'plot', 'real estate'] };
  const sector = Object.entries(sectorWords).find(([, ws]) => ws.some((w) => m.includes(w)))?.[0] || null;
  const money = message.match(/(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|hazaar|hazar|thousand)?\b/i);
  let budgetAmount = null;
  if (money) { budgetAmount = Number(money[1].replace(/,/g, '')); if (money[2]) budgetAmount *= 1000; if (budgetAmount < 50) budgetAmount = null; }
  const budgetPeriod = /(din|day|daily|roz)/i.test(m) ? 'day' : budgetAmount ? 'month' : null;
  const parts = message.split(/[,.\n]/).map((s) => s.trim()).filter(Boolean);
  const area = parts.find((p) => !/[\d₹]/.test(p) && parts.indexOf(p) > 0) || null;
  return normaliseBrief({ sector, businessDescription: parts[0] || null, area, budgetAmount, budgetPeriod });
}

function normaliseBrief(b) {
  const dailyBudget = b.budgetAmount ? Math.round(b.budgetPeriod === 'day' ? b.budgetAmount : b.budgetAmount / 30.4) : null;
  return { ...b, sector: TEMPLATES[b.sector] ? b.sector : b.sector ? 'other' : null, dailyBudget, maxDailyBudget: dailyBudget };
}

/**
 * WhatsApp "Badlo": free-text change request -> patch, limited to fields the template allows.
 * e.g. "area 5 km karo", "Punjabi mein likho"
 */
export async function changeRequestToPatch({ text, draft, allowedFields }) {
  let patch;
  if (!aiAvailable()) {
    patch = {};
    const km = text.match(/(\d+)\s*km/i); if (km) patch.radiusKm = Number(km[1]);
    if (/punjabi/i.test(text)) patch.language = 'punjabi';
    if (/english/i.test(text)) patch.language = 'english';
    if (/hinglish|hindi/i.test(text)) patch.language = 'hinglish';
    const age = text.match(/(\d{2})\s*(?:-|se|to)\s*(\d{2})/); if (age) { patch.ageMin = Number(age[1]); patch.ageMax = Number(age[2]); }
    const bud = text.match(/(?:₹|rs\.?)\s*([\d,]+)/i); if (bud && /din|day|roz/i.test(text)) patch.dailyBudget = Number(bud[1].replace(/,/g, ''));
  } else {
    patch = await askJson({
      system: 'You convert a business owner\'s change request about their ad into a JSON patch.',
      prompt: `Current ad settings: ${JSON.stringify({ radiusKm: draft.radiusKm, ageMin: draft.ageMin, ageMax: draft.ageMax, dailyBudget: draft.dailyBudget, language: draft.language, offer: draft.offer, goal: draft.goal })}
Request: """${text}"""
Allowed fields: ${allowedFields.join(', ')}. If the request changes language or offer, also set "regenerateCopy": true.
Return JSON patch with only changed allowed fields (+ optional regenerateCopy).`,
    });
  }
  const safe = {};
  for (const [k, v] of Object.entries(patch || {})) if (allowedFields.includes(k) || k === 'regenerateCopy') safe[k] = v;
  if (safe.language || safe.offer) safe.regenerateCopy = true;
  return safe;
}

/** Optional vision check: too much text on the image? */
export async function imageTextHeavy({ base64, mediaType }) {
  if (!aiAvailable()) return null;
  try {
    const out = await askJson({ system: 'You review ad images.', prompt: 'Estimate what fraction of this image is covered by text. JSON: {"textCoverage": 0-1}', images: [{ base64, mediaType }], maxTokens: 100 });
    return Number(out.textCoverage) > 0.25;
  } catch { return null; }
}


/** Google Search copy: 10 headlines (<=30 chars, no "!"), 4 descriptions (<=90), 15 keywords. */
export async function generateGoogleCopy({ sector, offer, businessName, area }) {
  const t = getTemplate(sector);
  const n = businessName || t.label;
  if (!aiAvailable()) {
    return {
      headlines: [offer, n, `${t.label} in ${area || 'Your City'}`, 'Book Your Visit Today', 'Call Now For Details', 'Trusted Local Experts', `${n} Near You`, 'Limited Time Offer'].map((h) => String(h || '').slice(0, 30)),
      descriptions: [`${offer}. Book today with ${n}.`, `${n}${area ? ` in ${area}` : ''} — friendly team, clear pricing. Call or visit now.`, 'Limited slots this month. Enquire now and our team will call you back.'].map((x) => x.slice(0, 90)),
      keywords: [],
    };
  }
  const out = await askJson({
    system: `You write Google Search ads for small Indian local businesses. ${policyBrief(t)}\nGoogle rules: headlines max 30 characters, no exclamation marks in headlines, no ALL CAPS words, no repeated punctuation; descriptions max 90 characters.`,
    prompt: `Business: ${n} (${t.label}) in ${area || 'their city'}. Offer: ${offer}.
JSON: {"headlines": [10 strings <=30 chars], "descriptions": [4 strings <=90 chars], "keywords": [15 short search phrases people in India type for this, lowercase]}`,
  });
  return { headlines: out.headlines || [], descriptions: out.descriptions || [], keywords: out.keywords || [] };
}


/** Screen 5: weak offer -> 3 stronger versions (free / discount / deadline), policy-checked. */
export async function strengthenOffer({ sector, offer, businessName }) {
  const t = getTemplate(sector);
  if (!aiAvailable()) return { offers: t.offerIdeas.slice(0, 3) };
  const out = await askJson({
    system: `You improve offers for Facebook ads of small Indian local businesses. A strong offer has something free, a discount, or a deadline, in one short line. ${policyBrief(t)}`,
    prompt: `Business: ${businessName || t.label} (${t.label}). Current offer: "${offer || '(none)'}".
Ideas that work in this sector: ${t.offerIdeas.join(' | ')}
Write 3 stronger one-line offers (max 70 characters each) the business could realistically give. JSON: {"offers": [3 strings]}`,
  });
  const ok = clean(out.offers, t).map((x) => x.slice(0, 90));
  return { offers: ok.length ? ok.slice(0, 3) : t.offerIdeas.slice(0, 3) };
}
