# MCP connector: directory submission pack

**Server URL:** `https://<api domain>/mcp` (Streamable HTTP, stateless)
**Auth:** OAuth 2.1 with dynamic client registration and PKCE. Metadata lives at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp`. Users sign in with their Wayne Ads account on the consent page (`/oauth/consent`). Scopes are `ads.read` and `ads.write`. Access tokens last 1h; refresh tokens last 30 days and rotate.
**Where to submit:** Claude developer portal → "MCP connector". You need a paid Claude plan and an admin of the Wayne org.

## Checklist (Anthropic review criteria → status)

| Criterion | Status |
|---|---|
| Read and write tools separate, no catch-all request tool | ✅ 5 read-only, 1 draft, 4 write tools |
| Every tool has `title` + `readOnlyHint` / `destructiveHint` | ✅ test `phase2.test.js` checks this |
| Tool names ≤ 64 chars, narrow descriptions that match behaviour | ✅ |
| No prompt-injection patterns (descriptions don't instruct Claude) | ✅ descriptions only say what the tool does |
| Valid calls succeed; errors are specific (no bare "Bad Request") | ✅ e.g. "No access to business 1. Use list_accounts…", "Increases are limited to 20%…" |
| Reasonable response size | ✅ max 50 alerts / 200 objects, summaries only |
| No memory / chat history access, no extra conversation data | ✅ |
| First-party API, MCP domain = our service | ✅ host on `ads-api.wayneesolutions.com` (same as the app) |
| No money transfer, no AI image/video/audio generation | ✅ no payment or media generation tools. **Note:** `launch_campaign` and `change_budget` change how much ad budget Meta spends. They move no funds, but reviewers may ask. See "Decision" below. |
| Test credentials for a fully populated account | ✅ `npm run seed:review` (below) |
| Public documentation by publish date | ⏳ publish `docs/MCP_HELP_ARTICLE.md` on the website |
| Privacy policy URL | ⏳ Wayne needs a public privacy policy covering the connector (draft points below; legal review needed) |
| Tested in MCP Inspector and as a custom connector in Claude | ⏳ do this on the deployed HTTPS server (all 10 tools already pass an end-to-end script locally) |

### Decision before submitting
Option 1: submit all 10 tools. Option 2 (safer for first approval): the listing exposes the read tools, `create_campaign_draft` and `pause_ad`, while `resume_ad`, `change_budget` and `launch_campaign` stay available to Wayne's own team as a custom connector. Switching is a one-line env flag if needed (not built: ask).

## Test account for reviewers
```bash
REVIEW_EMAIL=review@wayneesolutions.com REVIEW_PASSWORD='<12+ chars>' npm run seed:review
```
This creates 2 businesses: "Demo IELTS Academy" (prepaid wallet, 3 campaigns including a paused one, 30 days of data, open alerts, leads, weekly recommendations) and "Demo Bubble Tea Cafe". Their ad accounts are `act_demo…`, so **no tool ever calls Meta**. Writes still go through every safety check (PAUSED creates, 20% budget limit, owner cap, activity log) and return success. Re-running the script resets the data. Share the credentials only in the submission form.

## Listing copy

**Name:** Wayne Ads Manager
**Tagline:** See and safely manage your Meta ads from Claude.
**Description:** Wayne Ads Manager runs Facebook and Instagram ads for local businesses. With this connector you can ask Claude how your ads are doing (spend, leads, cost per lead, real customers from your CRM), review alerts and weekly recommendations, prepare new campaign drafts, and pause ads or adjust budgets. Every change is logged and can be undone in the app. Budget increases are capped at 20% per change and never exceed the owner's daily limit.

**Examples** (the directory asks for at least 3):
1. "How did my ads do this week? Which ad has the worst cost per lead?" → `list_accounts`, `get_performance`, `get_campaign`
2. "Any alerts I should act on? Pause the ad that's burning money." → `list_alerts`, `pause_ad` (Claude asks for confirmation)
3. "Draft a lead campaign for our free demo class, ₹600 a day, 10 km around Model Town." → `create_campaign_draft` (nothing goes live)
4. "The demo class ad set is cheap, increase its budget by 20%." → `get_campaign`, `change_budget`

## Tools
| Tool | Title | Annotations |
|---|---|---|
| list_accounts | List businesses and ad accounts | readOnly |
| get_performance | Get ad performance | readOnly |
| get_campaign | Get one campaign | readOnly |
| list_alerts | List alerts | readOnly |
| get_recommendations | Get weekly AI recommendations | readOnly |
| create_campaign_draft | Create campaign draft (always paused) | write, not destructive (nothing sent to Meta) |
| pause_ad | Pause an ad | destructive |
| resume_ad | Resume an ad | destructive |
| change_budget | Change ad set daily budget | destructive |
| launch_campaign | Launch a paused campaign | destructive |

## Privacy policy: points it must cover
What the connector accesses (ad performance, alerts, recommendations, campaign settings); that it does not read Claude chats; storage location (India, ap-south-1) and retention; OAuth tokens stored hashed and revocable; how to disconnect (Claude settings) and how to request deletion (link to the data-deletion status flow); contact email.
