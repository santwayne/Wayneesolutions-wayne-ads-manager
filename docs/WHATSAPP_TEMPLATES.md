# WhatsApp templates (Loopdesk number, prefix `loopdesk`)

Within the 24h window we send interactive buttons. Outside it, Meta only allows approved templates. Submit these (category: UTILITY, language: English):

| Name | Body | Buttons |
|---|---|---|
| `loopdesk_ads_alert` | `Wayne Ads alert: {{1}}` | Quick reply: `Haan`, `Na` |
| `loopdesk_ads_preview` | `Aapka naya ad ready hai: {{1}}` | Quick reply: `Haan, launch karo`, `Badlo` |
| `loopdesk_ads_report` | `Weekly report: {{1}}` | — |

The quick-reply payloads are set at send time (`alert:<id>:yes` and so on), so a single template covers every alert.
