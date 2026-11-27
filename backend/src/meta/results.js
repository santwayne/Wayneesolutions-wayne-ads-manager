// What counts as a "result" (lead) for our CPL math, per Meta action type.
// Order matters: the first non-zero group wins so we never double count
// (e.g. "lead" and "onsite_conversion.lead_grouped" both report form leads).
export const RESULT_ACTION_GROUPS = [
  ['onsite_conversion.lead_grouped', 'leadgen_grouped', 'lead'],                 // instant forms
  ['onsite_conversion.messaging_conversation_started_7d'],                         // WhatsApp/messages
  ['click_to_call_native_call_placed', 'click_to_call_call_confirm'],             // calls
  ['offsite_conversion.fb_pixel_lead', 'offsite_conversion.fb_pixel_purchase',
    'offsite_conversion.fb_pixel_complete_registration', 'offsite_conversion.fb_pixel_schedule'], // website
];

export function countResults(actions = []) {
  const byType = Object.fromEntries((actions || []).map((a) => [a.action_type, Number(a.value) || 0]));
  for (const group of RESULT_ACTION_GROUPS) {
    const first = group.find((t) => byType[t] > 0);
    if (first) return byType[first];
  }
  return 0;
}

export function insightRow(r) {
  const spend = Number(r.spend) || 0;
  const leads = countResults(r.actions);
  return {
    date: r.date_start,
    spend,
    impressions: Number(r.impressions) || 0,
    reach: Number(r.reach) || 0,
    frequency: Number(r.frequency) || 0,
    clicks: Number(r.clicks) || 0,
    ctr: Number(r.ctr) || 0,
    cpc: r.cpc != null ? Number(r.cpc) : null,
    leads,
    cpl: leads > 0 ? Math.round((spend / leads) * 100) / 100 : null,
    raw_actions: r.actions || null,
  };
}
