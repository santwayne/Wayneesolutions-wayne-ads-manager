/**
 * Campaign templates = every setup Meta Ads Manager offers today:
 * 6 objectives (Awareness, Traffic, Engagement, Leads, App promotion, Sales)
 * x conversion location x performance goal.
 *
 * The owner only sees the Hinglish label/help. Each template maps to the
 * Marketing API fields we send (objective, optimization_goal, destination_type,
 * promoted_object, CTA).
 *
 * `verify: true` = this enum combination is new/rare in the API; confirm it on the
 * sandbox account (`npm run verify:meta`) before giving it to clients. Enums
 * change between API versions.
 *
 * The first five keys (lead_form, whatsapp, call, website, store_visit) are the
 * original goals. Keep their keys: drafts, sector templates, WhatsApp mode and
 * the MCP connector use them.
 *
 * Fields:
 *   promoted  -> ad set promoted_object shape (see meta/builder.js)
 *   creative  -> how the ad creative / CTA is built
 *   needs*    -> extra inputs the wizard asks for + checklist rules
 *   pixelEvent-> default pixel / app event
 */

export const OBJECTIVE_GROUPS = [
  { key: 'awareness', label: 'Awareness', help: 'Zyada log aapka brand dekhein aur yaad rakhein', objective: 'OUTCOME_AWARENESS' },
  { key: 'traffic', label: 'Traffic', help: 'Log website, app, Instagram ya chat pe aayein', objective: 'OUTCOME_TRAFFIC' },
  { key: 'engagement', label: 'Engagement', help: 'Messages, video views, likes, event response', objective: 'OUTCOME_ENGAGEMENT' },
  { key: 'leads', label: 'Leads', help: 'Naam-number, call ya message se pakki leads', objective: 'OUTCOME_LEADS' },
  { key: 'app', label: 'App promotion', help: 'App install aur app ke andar action', objective: 'OUTCOME_APP_PROMOTION' },
  { key: 'sales', label: 'Sales', help: 'Website, app, WhatsApp ya catalog se sale', objective: 'OUTCOME_SALES' },
];

const T = (group, extra) => ({
  group,
  objective: OBJECTIVE_GROUPS.find((g) => g.key === group).objective,
  promoted: 'page',
  creative: 'link',
  cta: 'LEARN_MORE',
  ...extra,
});

export const GOALS = {
  // ---------- original 5 (keys must stay) ----------
  lead_form: T('leads', {
    label: 'Form se leads (naam, number)', help: 'Log form mein naam aur number bharenge', location: 'Instant form',
    optimizationGoal: 'LEAD_GENERATION', destinationType: 'ON_AD', cta: 'SIGN_UP', creative: 'lead_form', needsLeadForm: true, result: 'Lead',
  }),
  whatsapp: T('engagement', {
    label: 'WhatsApp pe messages', help: 'Log seedha aapko WhatsApp karenge', location: 'WhatsApp',
    optimizationGoal: 'CONVERSATIONS', destinationType: 'WHATSAPP', cta: 'WHATSAPP_MESSAGE', promoted: 'page_whatsapp', creative: 'whatsapp', needsWhatsapp: true, result: 'Conversation',
  }),
  call: T('leads', {
    label: 'Seedha phone call', help: 'Log ad se seedha call karenge', location: 'Calls',
    optimizationGoal: 'QUALITY_CALL', destinationType: 'PHONE_CALL', cta: 'CALL_NOW', creative: 'call', needsPhone: true, result: 'Call',
  }),
  website: T('leads', {
    label: 'Website pe booking/lead', help: 'Log website pe form/booking karenge (Pixel)', location: 'Website',
    optimizationGoal: 'OFFSITE_CONVERSIONS', destinationType: 'WEBSITE', promoted: 'pixel', needsPixel: true, needsWebsite: true, pixelEvent: 'LEAD', result: 'Website lead',
  }),
  store_visit: T('awareness', {
    label: 'Log dukaan pe aayein', help: 'Aas paas ke log dukaan dekhein, direction lein', location: 'Local reach',
    optimizationGoal: 'REACH', destinationType: null, cta: 'GET_DIRECTIONS', result: 'Reach',
  }),

  // ---------- Awareness ----------
  aw_reach: T('awareness', { label: 'Zyada se zyada log (Reach)', help: 'Har din zyada alag-alag log ad dekhein', location: 'Reach', optimizationGoal: 'REACH', destinationType: null, result: 'Reach' }),
  aw_impressions: T('awareness', { label: 'Baar baar dikhe (Impressions)', help: 'Ad zyada baar dikhe — offer yaad rahe', location: 'Impressions', optimizationGoal: 'IMPRESSIONS', destinationType: null, result: 'Impression' }),
  aw_ad_recall: T('awareness', { label: 'Brand yaad rahe (Ad recall lift)', help: 'Meta un logon ko dikhata hai jo ad yaad rakhenge', location: 'Ad recall lift', optimizationGoal: 'AD_RECALL_LIFT', destinationType: null, result: 'Ad recall lift' }),
  aw_thruplay: T('awareness', { label: 'Video poora dekhein (ThruPlay)', help: 'Log video 15 sec ya poora dekhein', location: 'Video views', optimizationGoal: 'THRUPLAY', destinationType: null, needsVideo: true, result: 'ThruPlay' }),
  aw_2sec_video: T('awareness', { label: 'Video views (2 sec)', help: 'Sasta, zyada video views', location: 'Video views', optimizationGoal: 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS', destinationType: null, needsVideo: true, result: '2-sec video view' }),

  // ---------- Traffic ----------
  tr_website_lpv: T('traffic', { label: 'Website visit (page khule)', help: 'Woh log jo click karke page load hone tak rukte hain', location: 'Website', optimizationGoal: 'LANDING_PAGE_VIEWS', destinationType: 'WEBSITE', needsWebsite: true, result: 'Landing page view' }),
  tr_website_clicks: T('traffic', { label: 'Website clicks', help: 'Zyada se zyada link clicks', location: 'Website', optimizationGoal: 'LINK_CLICKS', destinationType: 'WEBSITE', needsWebsite: true, result: 'Link click' }),
  tr_website_reach: T('traffic', { label: 'Website — daily unique reach', help: 'Website link wala ad zyada alag logon tak', location: 'Website', optimizationGoal: 'REACH', destinationType: 'WEBSITE', needsWebsite: true, result: 'Reach' }),
  tr_website_impressions: T('traffic', { label: 'Website — impressions', help: 'Website link wala ad zyada baar dikhe', location: 'Website', optimizationGoal: 'IMPRESSIONS', destinationType: 'WEBSITE', needsWebsite: true, result: 'Impression' }),
  tr_app: T('traffic', { label: 'App pe traffic', help: 'Log Play Store / App Store page pe jaayein', location: 'App', optimizationGoal: 'LINK_CLICKS', destinationType: 'APP', promoted: 'app', creative: 'app', cta: 'USE_MOBILE_APP', needsApp: true, result: 'Link click' }),
  tr_messenger: T('traffic', { label: 'Messenger pe traffic', help: 'Log Messenger chat kholein', location: 'Messenger', optimizationGoal: 'LINK_CLICKS', destinationType: 'MESSENGER', creative: 'messenger', cta: 'MESSAGE_PAGE', result: 'Link click' }),
  tr_whatsapp: T('traffic', { label: 'WhatsApp pe traffic', help: 'Log WhatsApp chat kholein (clicks pe optimise)', location: 'WhatsApp', optimizationGoal: 'LINK_CLICKS', destinationType: 'WHATSAPP', promoted: 'page_whatsapp', creative: 'whatsapp', cta: 'WHATSAPP_MESSAGE', needsWhatsapp: true, result: 'Link click' }),
  tr_instagram_profile: T('traffic', { label: 'Instagram profile visit', help: 'Log aapki Instagram profile pe aayein', location: 'Instagram profile', optimizationGoal: 'VISIT_INSTAGRAM_PROFILE', destinationType: 'INSTAGRAM_PROFILE', creative: 'ig_profile', cta: 'VIEW_INSTAGRAM_PROFILE', needsInstagram: true, verify: true, result: 'Profile visit' }),
  tr_calls: T('traffic', { label: 'Calls (traffic)', help: 'Call button pe clicks', location: 'Calls', optimizationGoal: 'LINK_CLICKS', destinationType: 'PHONE_CALL', creative: 'call', cta: 'CALL_NOW', needsPhone: true, verify: true, result: 'Link click' }),

  // ---------- Engagement ----------
  en_messenger: T('engagement', { label: 'Messenger pe messages', help: 'Log Facebook Messenger pe baat karein', location: 'Messenger', optimizationGoal: 'CONVERSATIONS', destinationType: 'MESSENGER', creative: 'messenger', cta: 'MESSAGE_PAGE', result: 'Conversation' }),
  en_instagram_dm: T('engagement', { label: 'Instagram DM', help: 'Log Instagram pe DM karein', location: 'Instagram Direct', optimizationGoal: 'CONVERSATIONS', destinationType: 'INSTAGRAM_DIRECT', creative: 'instagram_dm', cta: 'INSTAGRAM_MESSAGE', needsInstagram: true, result: 'Conversation' }),
  en_all_messaging: T('engagement', { label: 'Messenger + Instagram + WhatsApp', help: 'Meta khud chunega log kahan message karein', location: 'Message destinations', optimizationGoal: 'CONVERSATIONS', destinationType: 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP', promoted: 'page_whatsapp', creative: 'messenger', cta: 'MESSAGE_PAGE', needsWhatsapp: true, needsInstagram: true, verify: true, result: 'Conversation' }),
  en_thruplay: T('engagement', { label: 'Video engagement (ThruPlay)', help: 'Video poora dekhne wale log', location: 'On your ad', optimizationGoal: 'THRUPLAY', destinationType: 'ON_VIDEO', needsVideo: true, result: 'ThruPlay' }),
  en_2sec_video: T('engagement', { label: 'Video engagement (2 sec)', help: 'Sasta video views', location: 'On your ad', optimizationGoal: 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS', destinationType: 'ON_VIDEO', needsVideo: true, result: '2-sec video view' }),
  en_post_engagement: T('engagement', { label: 'Post boost (likes, comments, shares)', help: 'Page ki purani post ko zyada engagement', location: 'On your ad', optimizationGoal: 'POST_ENGAGEMENT', destinationType: 'ON_POST', creative: 'post', needsPost: true, result: 'Post engagement' }),
  en_page_likes: T('engagement', { label: 'Page likes / followers', help: 'Facebook Page pe naye followers', location: 'On your Page', optimizationGoal: 'PAGE_LIKES', destinationType: 'ON_PAGE', creative: 'page_like', cta: 'LIKE_PAGE', result: 'Page like' }),
  en_event_responses: T('engagement', { label: 'Event responses', help: 'Log aapke Facebook event pe "Going/Interested" karein', location: 'On your ad', optimizationGoal: 'EVENT_RESPONSES', destinationType: 'ON_EVENT', promoted: 'event', creative: 'event', cta: 'EVENT_RSVP', needsEvent: true, verify: true, result: 'Event response' }),
  en_calls: T('engagement', { label: 'Calls (engagement)', help: 'Log ad se call karein', location: 'Calls', optimizationGoal: 'QUALITY_CALL', destinationType: 'PHONE_CALL', creative: 'call', cta: 'CALL_NOW', needsPhone: true, result: 'Call' }),
  en_website: T('engagement', { label: 'Website engagement', help: 'Website pe page dekhein / time bitayein (Pixel)', location: 'Website', optimizationGoal: 'OFFSITE_CONVERSIONS', destinationType: 'WEBSITE', promoted: 'pixel', needsWebsite: true, needsPixel: true, pixelEvent: 'CONTENT_VIEW', result: 'Content view' }),
  en_app: T('engagement', { label: 'App engagement', help: 'App ke andar log action karein', location: 'App', optimizationGoal: 'APP_EVENTS', destinationType: 'APP', promoted: 'app', creative: 'app', cta: 'USE_MOBILE_APP', needsApp: true, pixelEvent: 'CONTENT_VIEW', result: 'App event' }),

  // ---------- Leads ----------
  ld_form_quality: T('leads', { label: 'Form leads — sirf pakki (Conversion leads)', help: 'Meta un logon ko dhoondhe jo CRM mein customer bante hain', location: 'Instant form', optimizationGoal: 'QUALITY_LEAD', destinationType: 'ON_AD', cta: 'SIGN_UP', creative: 'lead_form', needsLeadForm: true, needsCrmSignal: true, verify: true, result: 'Conversion lead' }),
  ld_whatsapp: T('leads', { label: 'WhatsApp leads', help: 'WhatsApp chat se leads (Leads objective)', location: 'WhatsApp', optimizationGoal: 'CONVERSATIONS', destinationType: 'WHATSAPP', promoted: 'page_whatsapp', creative: 'whatsapp', cta: 'WHATSAPP_MESSAGE', needsWhatsapp: true, result: 'Conversation' }),
  ld_messenger: T('leads', { label: 'Messenger leads (chat form)', help: 'Messenger chat mein sawaal-jawab se lead', location: 'Messenger', optimizationGoal: 'LEAD_GENERATION', destinationType: 'MESSENGER', creative: 'messenger', cta: 'MESSAGE_PAGE', verify: true, result: 'Lead' }),
  ld_instagram_dm: T('leads', { label: 'Instagram DM leads', help: 'Instagram DM mein sawaal-jawab se lead', location: 'Instagram Direct', optimizationGoal: 'LEAD_GENERATION', destinationType: 'INSTAGRAM_DIRECT', creative: 'instagram_dm', cta: 'INSTAGRAM_MESSAGE', needsInstagram: true, verify: true, result: 'Lead' }),
  ld_website_registration: T('leads', { label: 'Website registration', help: 'Website pe sign-up / registration (Pixel)', location: 'Website', optimizationGoal: 'OFFSITE_CONVERSIONS', destinationType: 'WEBSITE', promoted: 'pixel', cta: 'SIGN_UP', needsWebsite: true, needsPixel: true, pixelEvent: 'COMPLETE_REGISTRATION', result: 'Registration' }),
  ld_app: T('leads', { label: 'App leads', help: 'App ke andar registration / lead', location: 'App', optimizationGoal: 'APP_EVENTS', destinationType: 'APP', promoted: 'app', creative: 'app', cta: 'SIGN_UP', needsApp: true, pixelEvent: 'COMPLETE_REGISTRATION', result: 'App lead' }),

  // ---------- App promotion ----------
  ap_installs: T('app', { label: 'App installs', help: 'Zyada se zyada log app install karein', location: 'App', optimizationGoal: 'APP_INSTALLS', destinationType: null, promoted: 'app', creative: 'app', cta: 'INSTALL_MOBILE_APP', needsApp: true, result: 'Install' }),
  ap_events: T('app', { label: 'App events (install ke baad action)', help: 'Aise log jo app mein khareedein / register karein', location: 'App', optimizationGoal: 'APP_EVENTS', destinationType: null, promoted: 'app', creative: 'app', cta: 'INSTALL_MOBILE_APP', needsApp: true, pixelEvent: 'PURCHASE', result: 'App event' }),
  ap_value: T('app', { label: 'App value (zyada kharch karne wale)', help: 'App mein zyada value wali purchase', location: 'App', optimizationGoal: 'VALUE', destinationType: null, promoted: 'app', creative: 'app', cta: 'INSTALL_MOBILE_APP', needsApp: true, pixelEvent: 'PURCHASE', result: 'Purchase value' }),
  ap_link_clicks: T('app', { label: 'App store clicks', help: 'Store page pe sasta traffic', location: 'App', optimizationGoal: 'LINK_CLICKS', destinationType: null, promoted: 'app', creative: 'app', cta: 'INSTALL_MOBILE_APP', needsApp: true, result: 'Link click' }),

  // ---------- Sales ----------
  sl_website_purchase: T('sales', { label: 'Website sale (purchase)', help: 'Website pe kharidne wale log (Pixel)', location: 'Website', optimizationGoal: 'OFFSITE_CONVERSIONS', destinationType: 'WEBSITE', promoted: 'pixel', cta: 'SHOP_NOW', needsWebsite: true, needsPixel: true, pixelEvent: 'PURCHASE', result: 'Purchase' }),
  sl_website_value: T('sales', { label: 'Website — zyada value wali sale', help: 'Bade order wale kharidaar (Pixel value chahiye)', location: 'Website', optimizationGoal: 'VALUE', destinationType: 'WEBSITE', promoted: 'pixel', cta: 'SHOP_NOW', needsWebsite: true, needsPixel: true, pixelEvent: 'PURCHASE', result: 'Purchase value' }),
  sl_website_add_to_cart: T('sales', { label: 'Website add to cart', help: 'Cart mein daalne wale log (kam data pe bhi chalega)', location: 'Website', optimizationGoal: 'OFFSITE_CONVERSIONS', destinationType: 'WEBSITE', promoted: 'pixel', cta: 'SHOP_NOW', needsWebsite: true, needsPixel: true, pixelEvent: 'ADD_TO_CART', result: 'Add to cart' }),
  sl_website_lpv: T('sales', { label: 'Sales — website visit', help: 'Sales campaign, page view pe optimise (naya pixel)', location: 'Website', optimizationGoal: 'LANDING_PAGE_VIEWS', destinationType: 'WEBSITE', cta: 'SHOP_NOW', needsWebsite: true, result: 'Landing page view' }),
  sl_whatsapp: T('sales', { label: 'WhatsApp se sale', help: 'Chat karke kharidne wale log', location: 'WhatsApp', optimizationGoal: 'CONVERSATIONS', destinationType: 'WHATSAPP', promoted: 'page_whatsapp', creative: 'whatsapp', cta: 'WHATSAPP_MESSAGE', needsWhatsapp: true, result: 'Conversation' }),
  sl_messenger: T('sales', { label: 'Messenger se sale', help: 'Messenger chat se sale', location: 'Messenger', optimizationGoal: 'CONVERSATIONS', destinationType: 'MESSENGER', creative: 'messenger', cta: 'MESSAGE_PAGE', result: 'Conversation' }),
  sl_calls: T('sales', { label: 'Call se sale', help: 'Call karke order karne wale', location: 'Calls', optimizationGoal: 'QUALITY_CALL', destinationType: 'PHONE_CALL', creative: 'call', cta: 'CALL_NOW', needsPhone: true, result: 'Call' }),
  sl_app: T('sales', { label: 'App mein sale', help: 'App ke andar purchase (SDK chahiye)', location: 'App', optimizationGoal: 'APP_EVENTS', destinationType: 'APP', promoted: 'app', creative: 'app', cta: 'SHOP_NOW', needsApp: true, pixelEvent: 'PURCHASE', result: 'App purchase' }),
  sl_catalog: T('sales', { label: 'Catalog ads (products khud dikhein)', help: 'Catalog se har bande ko uska product dikhe', location: 'Website (catalog)', optimizationGoal: 'OFFSITE_CONVERSIONS', destinationType: 'WEBSITE', promoted: 'catalog', creative: 'catalog', cta: 'SHOP_NOW', needsWebsite: true, needsPixel: true, needsCatalog: true, pixelEvent: 'PURCHASE', verify: true, result: 'Purchase' }),
};

export const GOAL_KEYS = Object.keys(GOALS);

export function resolveGoal(goalKey, { pixelEvent } = {}) {
  const g = GOALS[goalKey];
  if (!g) throw new Error(`Unknown goal ${goalKey}`);
  if (goalKey === 'website' && pixelEvent === 'PURCHASE') return { ...g, objective: 'OUTCOME_SALES' };
  return g;
}

/** Public list for the wizard / MCP (no internal-only fields hidden — none are secret). */
export function listGoals() {
  return Object.entries(GOALS).map(([key, g]) => ({
    key, label: g.label, help: g.help, group: g.group, location: g.location, result: g.result,
    objective: g.objective, optimizationGoal: g.optimizationGoal, destinationType: g.destinationType, cta: g.cta,
    pixelEvent: g.pixelEvent || null, verify: !!g.verify,
    needs: Object.fromEntries(Object.entries(g).filter(([k, v]) => k.startsWith('needs') && v).map(([k]) => [k.slice(5, 6).toLowerCase() + k.slice(6), true])),
  }));
}
