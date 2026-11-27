/**
 * Screen 1: business language -> Meta settings (spec table).
 * The user never sees these words. Verify enums against the current API version
 * (OUTCOME_* objectives and destination types change between versions).
 */
export const GOALS = {
  lead_form: {
    label: 'Form se leads (naam, number)',
    objective: 'OUTCOME_LEADS',
    optimizationGoal: 'LEAD_GENERATION',
    destinationType: 'ON_AD',
    cta: 'SIGN_UP',
    needsLeadForm: true,
  },
  whatsapp: {
    label: 'WhatsApp pe messages',
    objective: 'OUTCOME_ENGAGEMENT',
    optimizationGoal: 'CONVERSATIONS',
    destinationType: 'WHATSAPP',
    cta: 'WHATSAPP_MESSAGE',
    needsWhatsapp: true,
  },
  call: {
    label: 'Seedha phone call',
    objective: 'OUTCOME_LEADS',
    optimizationGoal: 'QUALITY_CALL',
    destinationType: 'PHONE_CALL',
    cta: 'CALL_NOW',
    needsPhone: true,
  },
  website: {
    label: 'Website pe booking/sale',
    objective: 'OUTCOME_LEADS', // OUTCOME_SALES when the pixel event is PURCHASE
    optimizationGoal: 'OFFSITE_CONVERSIONS',
    destinationType: 'WEBSITE',
    cta: 'LEARN_MORE',
    needsPixel: true,
    needsWebsite: true,
  },
  store_visit: {
    label: 'Log dukaan pe aayein',
    objective: 'OUTCOME_AWARENESS',
    optimizationGoal: 'REACH',
    destinationType: null,
    cta: 'GET_DIRECTIONS',
  },
};

export function resolveGoal(goalKey, { pixelEvent } = {}) {
  const g = GOALS[goalKey];
  if (!g) throw new Error(`Unknown goal ${goalKey}`);
  if (goalKey === 'website' && pixelEvent === 'PURCHASE') return { ...g, objective: 'OUTCOME_SALES' };
  return g;
}
