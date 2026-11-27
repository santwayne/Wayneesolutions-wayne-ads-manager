# Phase 2

| Item | Status in this branch | What you need to do |
|---|---|---|
| Self-serve Facebook Login for Business | `/signup`, Settings → "Meta connect karo" → choose ad account + Page (Pages without the ADVERTISE task are disabled), Page subscribed to `leadgen`, long-lived token encrypted with KMS, validity check before calls, owner gets a WhatsApp to reconnect when it expires | Create a Login for Business configuration in the Meta app → `META_LOGIN_CONFIG_ID`. Redirect URI `https://<api>/meta/callback`. Needs App Review (Advanced Access). |
| Billing (Razorpay) | Wallet top-up online, invoice pay, subscription order. Checkout signature verify + `payment.captured`/`order.paid` webhook, credited once (idempotent on payment id) | Razorpay keys + webhook `https://<api>/webhooks/razorpay` (events: payment.captured, order.paid, payment.failed). Confirm GST with the CA. |
| Loopdesk hub integration | `POST /api/hub/provision`, `POST /api/hub/sso/exchange`, `/sso` page; bundle lapse pauses live campaigns; events go back to the hub (`ads.lead_created`, `ads.campaign_launched`, `ads.customer_won`) via an outbox flushed every 2 min | Hub side (regularsplatform), same as for Loyvexa: add tool `wayne-ads` in `lib/hub/plans.ts` with `WAYNE_ADS_API_URL`, `WAYNE_ADS_APP_URL`, `HUB_SECRET_WAYNE_ADS`; set the product to AUTO in `lib/hub/catalog-rules.ts`; issue an `rk_live_` key for events. |
| Conversions API for CRM | CRM stage → `Contacted/Qualified/Consultation Booked/Converted/Lost/Junk` event to the dataset, matched by `lead_id` | Set `ad_accounts.capi_dataset_id` (Events Manager → CRM dataset). The client team must mark leads in the CRM. |
| MCP connector | `https://<api>/mcp` (Streamable HTTP, stateless) + OAuth 2.1 (dynamic client registration, PKCE, consent page in the app, rotating refresh tokens). 5 read-only tools + `create_campaign_draft` + 4 destructive write tools, each with a title and annotations. No AI image/video tool. | Directory submission: test account and screenshots. Scopes are `ads.read` and `ads.write`. |
| Google Ads API | OAuth connect, choose customer, every 4h sync campaign metrics into the same dashboard totals (Meta + Google), pause/enable with actions_log | Developer token (Basic access) + OAuth client. Wizard/campaign creation on Google is **not** built yet. |

## Hub contract (verified against regularsplatform's tool side, PR #23)
The hub is **santwayne/loopdeskai-software**. Wayne Ads uses the same protocol as Regulars, Loyvexa and the other tools:

Token: HS256 signed with `HUB_SECRET` (hub side: `HUB_SECRET_WAYNE_ADS`), `iss "regulars-hub"`, `aud "wayne-ads"`, `sub <Loopdesk business id>`, `purpose "provision" | "sso"`, `jti` single use, `exp` <= 2 minutes.

`POST /api/hub/provision`, header `Authorization: Bearer <purpose provision>`
```json
{ "hubBusinessId": "b_123", "active": true,
  "business": { "name": "UJOY Bubble Tea", "sector": "RESTAURANT", "country": "IN", "phone": "9198..." },
  "owner": { "name": "Owner", "email": "owner@x.in", "phone": "9198..." } }
```
Returns `{ accountId, status: "ACTIVE" | "PAUSED", data: { ownerEmail, sectorTemplate } }`. `active: false` pauses live campaigns and refuses SSO; nothing is deleted. A token for a different `hubBusinessId` gets 403.

SSO: the hub opens `https://<app>/sso?token=<purpose sso JWT, optional acct, next>`. The page posts `{ token }` to `/api/hub/sso/exchange` and lands on `next` (in-app paths only).

Quick check, as for the other tools: a provision call with no token answers 401 "Missing token", and `/sso` with no token shows "This sign-in link is incomplete".

### Hub side changes still needed (santwayne/loopdeskai-software)
Add tool `wayne-ads` next to the others in `lib/hub/` (plans/tools list: `WAYNE_ADS_API_URL`, `WAYNE_ADS_APP_URL`, `HUB_SECRET_WAYNE_ADS`), mark the catalog product AUTO, and issue an `rk_live_` events key. These changes are not made yet: this session does not have access to that repo.
