# Integration contracts (Jobs CRM, WayneRing)

Paths live in `backend/src/leads/integrations.js`. If the real endpoints are different, change only that file.

## Ads Manager → Loopdesk AI Jobs (CRM-HCM)
`POST {JOBS_CRM_API_URL}/integrations/ads/leads`, header `x-api-key: JOBS_CRM_API_KEY`
```json
{ "hub_business_ref": "12", "source": "Meta", "name": "Ravi", "phone": "919876543210", "email": null,
  "city": "Ludhiana", "pincode": "141002", "tags": ["out of area"],
  "meta": { "lead_id": "...", "ad_id": "...", "adset_id": "...", "campaign_id": "...", "form_id": "..." },
  "answers": { "kab_shuru": "Is hafte" } }
```
Response: `{ "id": "<crm lead id>" }`. **The CRM upserts by phone** (duplicate phone = same lead). If the CRM is down, the lead stays in our DB and is retried with exponential backoff.

## Jobs CRM → Ads Manager (stage change)
`POST {PUBLIC_BASE_URL}/webhooks/crm/lead-stage`, header `x-wayne-signature: hex(HMAC_SHA256(JOBS_CRM_WEBHOOK_SECRET, raw body))`
```json
{ "crm_lead_id": "123", "stage": "won", "contacted_at": "2026-11-27T10:00:00Z" }
```
Stages: `contacted`, `qualified`, `consultation_booked` (or `booked`), `won`, `lost`, `junk`. Any stage other than `new` also counts as the first contact; this is what drives the 15-minute follow-up alert.

## Ads Manager → WayneRing (AI call within 2 min)
`POST {WAYNERING_API_URL}/api/integrations/ads/call`, header `x-api-key: WAYNERING_API_KEY`
```json
{ "hub_business_ref": "12", "phone": "919876543210", "name": "Ravi", "crm_lead_id": "123",
  "context": { "sector": "ielts", "answers": {...}, "source": "meta_lead_ad" } }
```
Calls go out only when `orgs.ai_call_enabled` is true and the lead is not out of area and not a duplicate. (India outbound needs WayneRing's TRAI 140-series number.)
