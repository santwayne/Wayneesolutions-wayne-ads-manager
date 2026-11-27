# Verify before go-live

Test everything on Meta's sandbox / test ad account first → then Wayne's own ad account → then 2–3 friendly clients → then everyone.

| # | What | How | Where in code |
|---|---|---|---|
| 1 | API field for location expansion ("reach more people likely to respond") | `TEST_AD_ACCOUNT=act_.. TEST_PAGE_ID=.. npm run verify:meta`. Check what Meta stores in the read-back. If the field name is different, set `META_GEO_EXPANSION_OFF_PATCH` in .env (JSON). No code change needed. | `meta/builder.js` `geoExpansionOffPatch()` |
| 2 | Higher-intent form flag | Docs: `is_optimized_for_quality: true` (confirmed in the current lead ads guide). Check the read-back with `VERIFY_FORM=1 npm run verify:meta`. | `meta/builder.js` `buildLeadForm` |
| 3 | `advantage_audience` must be sent explicitly as 0/1 from v23+ | Already sent on every ad set (0 for special ad categories). | `buildTargeting` |
| 4 | Objective / optimization / destination enums per goal (WhatsApp = OUTCOME_ENGAGEMENT + CONVERSATIONS + WHATSAPP, call = QUALITY_CALL + PHONE_CALL) | Create one draft per goal on the sandbox account | `wizard/goals.js` |
| 5 | Special ad category limits for India (age 18–65, no gender, min radius) | Meta docs + one housing test | `wizard/policy.js` `SAC_RULES` |
| 6 | Lead form thank-you button types (WHATSAPP / CALL_BUSINESS) | sandbox form create | `buildLeadForm` |
| 7 | Rules dry run (2 weeks) | `RULES_DRY_RUN=1`; check accuracy on the Alerts → "Dry run" tab, then set 0 | `rules/runner.js` |
| 8 | WhatsApp templates approved | docs/WHATSAPP_TEMPLATES.md | `notify/whatsapp.js` |
| 9 | Webhook subscriptions: Page `leadgen` field, WhatsApp `messages` | App dashboard → Webhooks: callback `https://<api>/webhooks/meta` and `/webhooks/whatsapp`, verify tokens from .env | `webhooks/*` |
| 10 | Data deletion URL in App settings | `https://<api>/webhooks/meta/data-deletion` (Approvals guide, Step 4) | `webhooks/meta.js` |
| 11 | Permissions for App Review | `ads_management`, `ads_read`, `business_management`, `leads_retrieval`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement`, `pages_manage_ads`, `whatsapp_business_messaging` | — |
| 12 | Budget minimums per template | Team tunes them from past data | `wizard/templates/index.js` |
| 13 | GST on ad spend (Model B) | CA confirm → `GST_ON_AD_SPEND` | `wallet/service.js` |
