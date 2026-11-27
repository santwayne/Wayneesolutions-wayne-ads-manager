/**
 * Policy pre-check (before Meta can reject). Pure functions — easy to unit test.
 * Returns issues: { code, level: 'block'|'warn', message, fix }
 */

const GLOBAL_WARN_PATTERNS = [
  { re: /before\s*(\/|and|&)?\s*after/i, code: 'before_after', message: 'Before/after wali baat Meta reject kar sakta hai', fix: 'Before/after hata ke result ki jagah process/experience batao' },
  { re: /\b(lowest|cheapest|no\.?\s*1|number\s*1|best in (india|punjab|ludhiana))\b/i, code: 'superlative', message: 'Bina saboot ke "No.1/sabse sasta" jaise claims misleading maane ja sakte hain', fix: 'Claim hatao ya saboot wala fact likho' },
  { re: /\b(click here|share this|tag a friend)\b/i, code: 'engagement_bait', message: 'Engagement bait se delivery kam hoti hai', fix: 'Seedha offer aur CTA likho' },
];

// Personal attributes: ad text must not assert/imply the reader has a condition.
const PERSONAL_ATTRIBUTE_PATTERNS = [
  /\b(are|r)\s+you\s+(infertile|depressed|diabetic|overweight|fat|sick|in debt|broke)\b/i,
  /\bkya\s+aap(ko)?\s+.{0,25}(infertile|baanjh|beemar|diabetes|motape|karz|depression|santaan nahi|bachcha nahi|maa nahi)/i,
  /\b(your|aapki|aapka)\s+(infertility|depression|diabetes|obesity|disease|debt|bimari)\b/i,
];

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ');

export function checkCopy(text, template) {
  const issues = [];
  const t = norm(text);
  if (!t.trim()) return [{ code: 'empty_text', level: 'block', message: 'Ad mein text nahi hai', fix: 'AI se text banwao' }];

  for (const phrase of template.blockedPhrases || []) {
    if (t.includes(norm(phrase))) {
      issues.push({ code: 'blocked_phrase', level: 'block', phrase, message: `"${phrase}" jaisa claim Meta policy ke khilaf hai`, fix: 'Ye shabd hatao — AI policy-safe version bana dega' });
    }
  }
  // Personal attributes apply to every sector (health, finance, etc.).
  if (PERSONAL_ATTRIBUTE_PATTERNS.some((re) => re.test(text))) {
    issues.push({ code: 'personal_attribute', level: 'block', message: 'Ad padhne wale ki personal condition assume nahi kar sakte ("Kya aap infertile hain?" galat)', fix: 'Service ke baare mein likho, jaise "Expert IVF consultation"' });
  }
  for (const w of GLOBAL_WARN_PATTERNS) {
    if (w.re.test(text)) issues.push({ code: w.code, level: 'warn', message: w.message, fix: w.fix });
  }
  if (text.length > 600) issues.push({ code: 'too_long', level: 'warn', message: 'Text bahut lamba hai, pehli 2 line mein offer aana chahiye', fix: 'Chhota karo' });
  return issues;
}

/** Targeting rules for special ad categories (housing / credit / employment). */
export const SAC_RULES = {
  // Verify current Meta limits for India; these are conservative defaults.
  ageMin: 18, ageMax: 65, minRadiusKm: 25, allowGender: false, allowDetailedTargeting: false,
};

export function applySpecialCategoryRules(draft, template) {
  const cats = template.specialAdCategories || [];
  if (!cats.length) return { draft, changed: [] };
  const changed = [];
  const d = { ...draft };
  if (d.ageMin !== SAC_RULES.ageMin) { d.ageMin = SAC_RULES.ageMin; changed.push('ageMin'); }
  if (d.ageMax !== SAC_RULES.ageMax) { d.ageMax = SAC_RULES.ageMax; changed.push('ageMax'); }
  if ((d.radiusKm || 0) < SAC_RULES.minRadiusKm) { d.radiusKm = SAC_RULES.minRadiusKm; changed.push('radiusKm'); }
  if (d.genders) { delete d.genders; changed.push('genders'); }
  return { draft: d, changed };
}
