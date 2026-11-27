/**
 * Sector templates (spec Screen 2). Numbers here are STARTING defaults —
 * the team should tune min/recommended budgets and target CPL from past data.
 * Policy rules per sector feed wizard/policy.js.
 */

const base = {
  language: 'hinglish',
  ageMin: 21, ageMax: 55,
  radiusKm: 10,
  minDailyBudget: 300,
  recommendedDailyBudget: 500,
  targetCpl: 250,
  specialAdCategories: [],
  defaultGoal: 'lead_form',
  allowedGoals: ['lead_form', 'whatsapp', 'call', 'website', 'store_visit'],
  formQuestions: [],
  qualifyingQuestion: { key: 'kab_shuru', label: 'Aap kab tak shuru karna chahte hain?', options: ['Is hafte', 'Is mahine', '1-3 mahine mein', 'Abhi sirf jaankari'] },
  blockedPhrases: [],
  offerIdeas: [],
  tone: 'friendly, clear, local',
  // Per-sector rule thresholds (layer between engine DEFAULTS and the owner's own settings).
  rules: {},
  // Fields the WhatsApp-mode AI may fill/change. Anything else stays template default.
  aiEditableFields: ['offer', 'goal', 'radiusKm', 'ageMin', 'ageMax', 'dailyBudget', 'language', 'primaryTexts', 'headlines'],
};

export const TEMPLATES = {
  ivf: {
    ...base,
    key: 'ivf',
    label: 'IVF / Hospital',
    ageMin: 25, ageMax: 45,
    radiusKm: 15,
    minDailyBudget: 700, recommendedDailyBudget: 1200, targetCpl: 450,
    tone: 'warm, respectful, reassuring, no medical claims',
    offerIdeas: ['Free first consultation with senior IVF specialist', 'Fertility check-up package at special price', 'Free AMH test with consultation'],
    formQuestions: [
      { key: 'consult_type', label: 'Aap kis cheez ke liye consult karna chahte hain?', options: ['IVF', 'IUI', 'Fertility check-up', 'Other'] },
    ],
    healthSensitive: true,
    // High-value leads: give an ad more room before calling it a money burn; callbacks fast.
    rules: { money_burn: { cplMultiple: 4 }, lead_followup: { minutes: 10 } },
    blockedPhrases: [
      'guarantee', 'guaranteed', '100%', 'success rate', 'pakka result', 'sure shot',
      'kya aap infertile', 'are you infertile', 'aap baanjh', 'your infertility', 'kya aap maa nahi ban',
      'cure', 'miracle',
    ],
  },
  ielts: {
    ...base,
    key: 'ielts',
    label: 'IELTS / Immigration',
    ageMin: 18, ageMax: 35,
    radiusKm: 12,
    minDailyBudget: 400, recommendedDailyBudget: 600, targetCpl: 150,
    offerIdeas: ['Free demo class + band score test', '7-din free trial batch', 'Free profile evaluation for study visa'],
    formQuestions: [
      { key: 'service', label: 'Aapko kya chahiye?', options: ['IELTS/PTE coaching', 'Study visa', 'Tourist visa', 'Spouse visa'] },
      { key: 'education', label: 'Aapki last education?', options: ['12th', 'Graduation', 'Post-graduation'] },
    ],
    rules: { lead_followup: { minutes: 10 } },
    blockedPhrases: ['visa guarantee', 'guaranteed visa', '100% approval', '100% visa', 'pakka visa', 'visa pakka', 'no refusal', 'guarantee'],
  },
  restaurant: {
    ...base,
    key: 'restaurant',
    label: 'Restaurant / Cafe',
    ageMin: 18, ageMax: 45,
    radiusKm: 6,
    minDailyBudget: 250, recommendedDailyBudget: 400, targetCpl: 60,
    defaultGoal: 'whatsapp',
    tone: 'fun, tasty, local, punchy',
    // Cheap, fast-moving leads: creatives tire quickly, out-of-area matters less (delivery radius).
    rules: { creative_fatigue: { frequency: 2.5 }, out_of_area: { maxPct: 25 } },
    offerIdeas: ['Flat 20% off on first order', 'Free dessert with every family meal', 'Weekend combo at special price'],
    formQuestions: [{ key: 'occasion', label: 'Kis cheez ke liye?', options: ['Dine-in', 'Home delivery', 'Party/Event booking'] }],
    qualifyingQuestion: { key: 'kab', label: 'Kab aana chahenge?', options: ['Aaj', 'Is weekend', 'Agle hafte'] },
  },
  furniture: {
    ...base,
    key: 'furniture',
    label: 'Furniture',
    ageMin: 25, ageMax: 60,
    radiusKm: 15,
    minDailyBudget: 400, recommendedDailyBudget: 700, targetCpl: 200,
    offerIdeas: ['Free home measurement + design consultation', 'Flat 15% off this month', 'Free delivery & installation'],
    formQuestions: [{ key: 'product', label: 'Aap kya lena chahte hain?', options: ['Sofa', 'Bed', 'Dining', 'Modular kitchen/wardrobe', 'Office furniture'] }],
    qualifyingQuestion: { key: 'kab_lena', label: 'Kab tak lena hai?', options: ['Is hafte', 'Is mahine', '1-3 mahine mein', 'Abhi sirf dekh rahe hain'] },
  },
  salon_gym: {
    ...base, key: 'salon_gym', label: 'Salon / Gym', ageMin: 18, ageMax: 45, radiusKm: 6,
    minDailyBudget: 250, recommendedDailyBudget: 400, targetCpl: 100, defaultGoal: 'whatsapp',
    offerIdeas: ['First visit 30% off', 'Free trial session', 'Free skin/hair consultation'],
    blockedPhrases: ['lose 10 kg', 'guaranteed results', 'before/after', 'before and after'],
  },
  car_dealer: {
    ...base, key: 'car_dealer', label: 'Car dealer', ageMin: 25, ageMax: 55, radiusKm: 25,
    minDailyBudget: 500, recommendedDailyBudget: 900, targetCpl: 300,
    offerIdeas: ['Free test drive at home', 'Exchange bonus this month', 'Low down payment offer'],
    // Car loans / financing ads fall under financial products special ad category.
    blockedPhrases: ['guaranteed loan', 'zero documents', 'no cibil check'],
  },
  real_estate: {
    ...base, key: 'real_estate', label: 'Real estate', ageMin: 18, ageMax: 65, radiusKm: 25,
    minDailyBudget: 700, recommendedDailyBudget: 1200, targetCpl: 350,
    specialAdCategories: ['HOUSING'],
    // Long sales cycle, expensive leads; wide 25 km radius makes out-of-area noisier.
    rules: { money_burn: { cplMultiple: 4 }, expensive_ad: { overAvgPct: 75 }, out_of_area: { maxPct: 25 } },
    offerIdeas: ['Free site visit with pick & drop', 'Booking at ₹51,000 only', 'Festive offer: free modular kitchen'],
    formQuestions: [{ key: 'budget', label: 'Aapka budget?', options: ['50 lakh tak', '50 lakh - 1 crore', '1 crore se upar'] }],
    blockedPhrases: ['guaranteed returns', 'double your money', 'assured return'],
  },
  other: { ...base, key: 'other', label: 'Other' },
};

export function getTemplate(key) {
  return TEMPLATES[key] || TEMPLATES.other;
}

export function listTemplates() {
  return Object.values(TEMPLATES).map((t) => ({
    key: t.key, label: t.label, radiusKm: t.radiusKm, ageMin: t.ageMin, ageMax: t.ageMax,
    minDailyBudget: t.minDailyBudget, recommendedDailyBudget: t.recommendedDailyBudget,
    defaultGoal: t.defaultGoal, offerIdeas: t.offerIdeas, specialAdCategories: t.specialAdCategories,
  }));
}
