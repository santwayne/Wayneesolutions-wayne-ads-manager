/**
 * Run on the Meta SANDBOX / test ad account before go-live:
 *   TEST_AD_ACCOUNT=act_123 TEST_PAGE_ID=456 node scripts/verify-meta.js
 * Creates a PAUSED campaign + ad set with our exact targeting, reads it back, prints
 * what Meta stored for location expansion / advantage audience, then deletes both.
 */
import { config } from '../src/config.js';
import { createGraphClient } from '../src/meta/graph.js';
import { buildTargeting, buildCampaign, buildAdSet, buildLeadForm } from '../src/meta/builder.js';
import { resolveGoal } from '../src/wizard/goals.js';
import { validateDraft } from '../src/wizard/validate.js';

const act = process.env.TEST_AD_ACCOUNT; const page = process.env.TEST_PAGE_ID;
if (!act || !page) { console.error('Set TEST_AD_ACCOUNT and TEST_PAGE_ID'); process.exit(1); }
const g = createGraphClient({ token: config.meta.systemUserToken });
const v = validateDraft({ sector: 'ielts', goal: 'lead_form', location: { lat: 30.89, lng: 75.83 }, offer: 'Free demo', primaryTexts: ['x'], headlines: ['x'], media: [] }, { adAccount: { page_id: page } });
const goal = resolveGoal('lead_form');
console.log('API version', config.meta.apiVersion);
const c = await g.post(`${act}/campaigns`, buildCampaign(v.draft, goal, { name: 'VERIFY — delete me' }));
try {
  const targeting = buildTargeting(v.draft);
  const s = await g.post(`${act}/adsets`, buildAdSet(v.draft, goal, { campaignId: c.id, pageId: page, targeting, name: 'VERIFY — delete me' }));
  const back = await g.get(s.id, { fields: 'targeting,status' });
  console.log('Sent targeting_automation:', JSON.stringify(targeting.targeting_automation));
  console.log('Meta stored:', JSON.stringify(back.targeting?.targeting_automation), 'status', back.status);
  console.log('geo_locations:', JSON.stringify(back.targeting?.geo_locations));
  if (process.env.VERIFY_FORM === '1') {
    const f = await g.post(`${page}/leadgen_forms`, buildLeadForm(v.draft, { privacyPolicyUrl: 'https://example.com/privacy', phone: '919999999999' }));
    console.log('lead form', f.id, JSON.stringify(await g.get(f.id, { fields: 'is_optimized_for_quality,status' })));
  }
} finally {
  await g.del(c.id);
  console.log('cleaned up');
}
