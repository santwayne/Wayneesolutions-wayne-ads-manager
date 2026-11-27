# Wayne Ads Manager

Wayne's own ads tool built on the Meta Marketing API. A business owner with no ads experience gets a correct campaign in 10 minutes. The tool then keeps running it and improving it, and the owner just says "Haan" on WhatsApp.

Spec: *Wayne Ads Manager – Developer Spec* (27 Nov 2026). **Phase 1** covers agency mode with a system user token. **Phase 2** adds self-serve Facebook Login, Razorpay billing, Loopdesk hub provisioning and SSO, Conversions API for CRM, the MCP connector and Google Ads reporting. See docs/PHASE2.md.

## What's in it

| Spec part | Where |
|---|---|
| 7-screen guided wizard + smart defaults + checklist with fix buttons | `backend/src/wizard/*`, `frontend/src/wizard/Wizard.jsx` |
| 8 sector templates (IVF, IELTS, restaurant, furniture, salon/gym, car, real estate, other) | `backend/src/wizard/templates/index.js` |
| Policy pre-check (IVF personal attributes, visa guarantee, before/after, special ad categories) | `backend/src/wizard/policy.js` |
| Always PAUSED on create, launch only by a human (app click / WhatsApp "Haan") | `backend/src/meta/graph.js`, `backend/src/actions/service.js` |
| Lead quality fixes (location expansion OFF, higher-intent form, pincode question, qualifying question, exclusion audience) | `backend/src/meta/builder.js`, `backend/src/leads/pipeline.js` |
| Sync worker (structure + insights every 4h, 90-day backfill via async report jobs, BUC-header backoff) | `backend/src/meta/sync.js`, `backend/src/meta/graph.js` |
| Rules engine (8 spec rules + out-of-area % + wallet), learning-phase guard, dry-run, auto-mode | `backend/src/rules/*` |
| Money safety: +20% max budget step, owner daily cap, actions_log, one-click undo, billing never touched | `backend/src/actions/service.js` |
| WhatsApp Mode (3-line brief → max 3 follow-ups → preview → Badlo/Haan) | `backend/src/whatsapp-mode/conversation.js` |
| Alerts/reports on WhatsApp in Hinglish, Haan/Na buttons | `backend/src/notify/*`, `backend/src/webhooks/whatsapp.js` |
| Claude AI: ad copy, rejected-ad rewrite, Monday recommendations (JSON), brief parsing | `backend/src/ai/*` |
| Leads → Jobs CRM → WayneRing, CRM stage → cost per customer, 15-min poll fallback | `backend/src/leads/*`, `backend/src/webhooks/*` |
| Data deletion callback + status page | `backend/src/webhooks/meta.js` |
| Model A + Model B (prepaid wallet, ledger, auto-pause at 0, GST invoice) | `backend/src/wallet/service.js` |
| Agency dashboard with health score, client dashboard, alerts, leads, log, wallet, settings | `frontend/src/pages/*` |
| Roles Owner / Manager / Viewer, per-client access, org_id on every query + Postgres RLS | `backend/src/lib/auth.js`, `backend/src/db/migrations` |

## Run locally

```bash
docker compose -f docker-compose.dev.yml up -d        # or local Postgres 16 + Redis 7
cd backend && cp .env.example .env                    # fill DATABASE_URL, JWT_SECRET, TOKEN_ENC_KEY; WA_MODE=log
npm install && npm run migrate
SEED_EMAIL=you@wayne.in SEED_PASSWORD=... npm run seed
npm run dev            # API on :4100
npm run worker         # BullMQ jobs + schedules (separate process)
cd ../frontend && npm install && npm run dev          # UI on :5173 (proxies /api)
```

Tests (need Postgres): `cd backend && DATABASE_URL=postgres://.../wayne_ads_test npm test`. There are 33 tests. Phase 2 tests cover hub provision/SSO, Razorpay, CAPI, signup, the full MCP OAuth flow and tools, and Google sync. The Phase 1 tests are unit tests plus an end-to-end flow against a fake Meta API (wizard → paused create → launch, budget caps, undo, rules → WhatsApp Haan → pause, signed leadgen webhook → CRM, data deletion, wallet auto-pause, the full WhatsApp Mode chat).

## Before go-live: verify these

See **docs/VERIFY_BEFORE_LIVE.md**. The most important items:

1. The exact API field for "reach more people likely to respond" (location expansion). Run `npm run verify:meta` on the sandbox account and fix `META_GEO_EXPANSION_OFF_PATCH` if needed.
2. Keep `RULES_DRY_RUN=1` for the first 2 weeks, check alert accuracy, then switch it to 0.
3. Submit the WhatsApp templates (docs/WHATSAPP_TEMPLATES.md) and get them approved.
4. The CRM and WayneRing endpoints (docs/INTEGRATIONS.md).
5. Confirm the GST treatment for Model B with the CA (`GST_ON_AD_SPEND`).

Other docs: docs/DEPLOY.md (EC2 + PM2 + nginx, secrets, security).
