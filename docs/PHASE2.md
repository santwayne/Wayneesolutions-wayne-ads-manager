# Phase 2

| Item | Status in this branch | What you need to do |
|---|---|---|
| Self-serve Facebook Login for Business | `/signup`, Settings → "Meta connect karo" → choose ad account + Page (Pages without the ADVERTISE task are disabled), Page subscribed to `leadgen`, long-lived token encrypted with KMS, validity check before calls, owner gets a WhatsApp to reconnect when it expires | Create a Login for Business configuration in the Meta app → `META_LOGIN_CONFIG_ID`. Redirect URI `https://<api>/meta/callback`. Needs App Review (Advanced Access). |
| Billing (Razorpay) | Wallet top-up online, invoice pay, subscription order. Checkout signature verify + `payment.captured`/`order.paid` webhook, credited once (idempotent on payment id) | Razorpay keys + webhook `https://<api>/webhooks/razorpay` (events: payment.captured, order.paid, payment.failed). Confirm GST with the CA. |
| Loopdesk hub integration | `POST /api/hub/provision`, `POST /api/hub/sso/exchange`, `/sso` page; bundle lapse pauses live campaigns; events go back to the hub (`ads.lead_created`, `ads.campaign_launched`, `ads.customer_won`) via an outbox flushed every 2 min | Hub side (regularsplatform), same as for Loyvexa: add tool `wayne-ads` in `lib/hub/plans.ts` with `WAYNE_ADS_API_URL`, `WAYNE_ADS_APP_URL`, `HUB_SECRET_WAYNE_ADS`; set the product to AUTO in `lib/hub/catalog-rules.ts`; issue an `rk_live_` key for events. |
| Conversions API for CRM | CRM stage → `Contacted/Qualified/Consultation Booked/Converted/Lost/Junk` event to the dataset, matched by `lead_id` | Set `ad_accounts.capi_dataset_id` (Events Manager → CRM dataset). The client team must mark leads in the CRM. |
| MCP connector | `https://<api>/mcp` (Streamable HTTP, stateless) + OAuth 2.1 (dynamic client registration, PKCE, consent page in the app, rotating refresh tokens). 5 read-only tools + `create_campaign_draft` + 4 destructive write tools, each with a title and annotations. No AI image/video tool. | Directory submission: test account and screenshots. Scopes are `ads.read` and `ads.write`. |
| Google Ads API | OAuth connect, choose customer, every 4h sync campaign metrics into the same dashboard totals (Meta + Google), pause/enable with actions_log | Developer token (Basic access) + OAuth client. Wizard/campaign creation on Google is **not** built yet. |

## Hub contract (what the hub sends)
`POST /api/hub/provision` with `Authorization: Bearer <HS256 JWT: iss regulars-hub, aud wayne-ads, sub <hub business id>, jti, exp 2m>`
```json
{ "business": { "name": "UJOY Bubble Tea", "whatsapp": "9198..." },
  "owner": { "name": "Owner", "email": "owner@x.in", "phone": "9198..." },
  "status": "active", "plan": "loopdesk_bundle" }
```
`status: "paused"` = bundle lapsed: live campaigns get paused and SSO is refused. Nothing is deleted.

SSO: hub → `https://<app>/sso?ticket=<same JWT>` → the app calls `/api/hub/sso/exchange`.
Quick check, as for the other tools: a provision call with no token should answer "Hub token rejected", and `/sso` with no ticket should show "This sign-in link is incomplete".
