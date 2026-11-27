-- Wayne Ads Manager: initial schema (spec "Data model" + Model B wallet + WhatsApp mode)

CREATE TABLE orgs (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('agency','business')),
  parent_agency_id BIGINT REFERENCES orgs(id),
  plan             TEXT NOT NULL DEFAULT 'agency_managed',
  payment_model    TEXT NOT NULL DEFAULT 'A' CHECK (payment_model IN ('A','B')),
  whatsapp_number  TEXT,             -- owner's WhatsApp, E.164 without +
  timezone         TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  auto_mode        BOOLEAN NOT NULL DEFAULT false,      -- autopilot pause/budget without asking
  auto_daily_action_limit INT NOT NULL DEFAULT 5,
  daily_budget_cap NUMERIC(14,2),                      -- account-level cap set by owner (INR/day)
  ai_call_enabled  BOOLEAN NOT NULL DEFAULT false,     -- WayneRing call on new lead
  privacy_policy_url TEXT,
  service_fee_monthly NUMERIC(14,2) NOT NULL DEFAULT 0,
  gstin            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  phone         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id  BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role    TEXT NOT NULL CHECK (role IN ('owner','manager','viewer')),
  PRIMARY KEY (user_id, org_id)
);

CREATE TABLE meta_connections (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('system_user','user')),
  meta_user_id TEXT,
  token_enc   TEXT NOT NULL,              -- envelope encrypted (KMS), never logged
  scopes      TEXT[] NOT NULL DEFAULT '{}',
  expires_at  TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked','error')),
  last_checked_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ad_accounts (
  id              BIGSERIAL PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  connection_id   BIGINT REFERENCES meta_connections(id),
  meta_account_id TEXT NOT NULL,          -- act_<id>
  name            TEXT,
  currency        TEXT NOT NULL DEFAULT 'INR',
  timezone        TEXT,
  sector_template TEXT,
  page_id         TEXT,                   -- Facebook Page used for ads / lead forms
  instagram_id    TEXT,
  whatsapp_phone  TEXT,                   -- business WhatsApp for click-to-WhatsApp ads
  pixel_id        TEXT,
  target_cpl      NUMERIC(14,2),
  service_area_pincodes TEXT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'active',
  last_synced_at  TIMESTAMPTZ,
  backfilled_at   TIMESTAMPTZ,
  UNIQUE (meta_account_id)
);

CREATE TABLE campaigns (
  id                BIGSERIAL PRIMARY KEY,
  org_id            BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ad_account_id     BIGINT NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  meta_id           TEXT UNIQUE,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL,        -- configured status (ACTIVE/PAUSED/...)
  effective_status  TEXT,
  objective         TEXT,
  daily_budget      NUMERIC(14,2),
  special_ad_categories TEXT[] NOT NULL DEFAULT '{}',
  created_by_wizard BOOLEAN NOT NULL DEFAULT false,
  wizard_draft_id   BIGINT,
  launched_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE adsets (
  id                BIGSERIAL PRIMARY KEY,
  org_id            BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  campaign_id       BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  meta_id           TEXT UNIQUE,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL,
  effective_status  TEXT,
  optimization_goal TEXT,
  destination_type  TEXT,
  daily_budget      NUMERIC(14,2),
  targeting         JSONB,
  learning_stage    TEXT,                 -- from Meta learning_stage_info
  created_by_wizard BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE creatives (
  id               BIGSERIAL PRIMARY KEY,
  org_id           BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ad_account_id    BIGINT NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  meta_creative_id TEXT UNIQUE,
  type             TEXT NOT NULL CHECK (type IN ('image','video')),
  primary_text     TEXT,
  headline         TEXT,
  cta              TEXT,
  asset_url        TEXT,
  image_hash       TEXT,
  video_id         TEXT,
  fatigue_score    NUMERIC(5,2) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ads (
  id                BIGSERIAL PRIMARY KEY,
  org_id            BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  adset_id          BIGINT NOT NULL REFERENCES adsets(id) ON DELETE CASCADE,
  creative_id       BIGINT REFERENCES creatives(id),
  meta_id           TEXT UNIQUE,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL,
  effective_status  TEXT,
  review_feedback   JSONB,
  created_by_wizard BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE insights_daily (
  org_id      BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  level       TEXT NOT NULL CHECK (level IN ('account','campaign','adset','ad')),
  object_id   TEXT NOT NULL,              -- Meta id at that level
  date        DATE NOT NULL,
  spend       NUMERIC(14,2) NOT NULL DEFAULT 0,
  impressions BIGINT NOT NULL DEFAULT 0,
  reach       BIGINT NOT NULL DEFAULT 0,
  frequency   NUMERIC(8,3) NOT NULL DEFAULT 0,
  clicks      BIGINT NOT NULL DEFAULT 0,
  ctr         NUMERIC(8,4) NOT NULL DEFAULT 0,
  cpc         NUMERIC(14,2),
  leads       BIGINT NOT NULL DEFAULT 0,  -- leads / messaging conversations / calls (per objective)
  cpl         NUMERIC(14,2),
  raw_actions JSONB,
  PRIMARY KEY (level, object_id, date)
);
CREATE INDEX insights_daily_org_date ON insights_daily (org_id, date);

CREATE TABLE rules (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  rule_type   TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  threshold   JSONB NOT NULL DEFAULT '{}',
  last_fired  TIMESTAMPTZ,
  UNIQUE (org_id, rule_type)
);

CREATE TABLE alerts (
  id           BIGSERIAL PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  rule_type    TEXT NOT NULL,
  level        TEXT NOT NULL,             -- account/campaign/adset/ad
  object_id    TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  message      TEXT NOT NULL,
  suggested_action JSONB,                 -- {type:'pause'|'budget', ...}
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected','auto_applied','dry_run','resolved')),
  dedupe_key   TEXT NOT NULL,
  action_taken TEXT,
  approved_by  TEXT,                      -- user id or 'whatsapp:<number>'
  dry_run      BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX alerts_open_dedupe ON alerts (org_id, dedupe_key) WHERE status IN ('open','dry_run');

CREATE TABLE actions_log (
  id         BIGSERIAL PRIMARY KEY,
  org_id     BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  who        TEXT NOT NULL,               -- user:<id> / rule:<type> / ai / mcp / whatsapp:<num> / system
  what       TEXT NOT NULL,               -- pause/resume/budget/launch/create/undo/ai_decision/...
  level      TEXT,
  object_id  TEXT,
  before     JSONB,
  after      JSONB,
  source     TEXT NOT NULL CHECK (source IN ('user','rule','ai','mcp','whatsapp','system')),
  undone_by  BIGINT REFERENCES actions_log(id),
  undo_of    BIGINT REFERENCES actions_log(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX actions_log_org ON actions_log (org_id, created_at DESC);

CREATE TABLE leads (
  id           BIGSERIAL PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  meta_lead_id TEXT UNIQUE NOT NULL,
  ad_id        TEXT, adset_id TEXT, campaign_id TEXT, form_id TEXT, page_id TEXT,
  name         TEXT, phone TEXT, email TEXT, city TEXT, pincode TEXT,
  answers      JSONB,
  out_of_area  BOOLEAN NOT NULL DEFAULT false,
  crm_lead_id  TEXT,
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','qualified','consultation_booked','won','lost','junk')),
  first_contact_at TIMESTAMPTZ,
  capi_sent_status TEXT,
  meta_created_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX leads_org_phone ON leads (org_id, phone);

CREATE TABLE lead_forms (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  page_id     TEXT NOT NULL,
  meta_form_id TEXT UNIQUE NOT NULL,
  name        TEXT,
  last_polled_at TIMESTAMPTZ
);

-- Wizard drafts (screens 1-7 and WhatsApp mode share this)
CREATE TABLE wizard_drafts (
  id            BIGSERIAL PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ad_account_id BIGINT REFERENCES ad_accounts(id),
  channel       TEXT NOT NULL DEFAULT 'app' CHECK (channel IN ('app','whatsapp')),
  data          JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','created','launched','abandoned')),
  campaign_id   BIGINT REFERENCES campaigns(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- WhatsApp Mode conversation state
CREATE TABLE wa_conversations (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT REFERENCES orgs(id) ON DELETE CASCADE,
  wa_number   TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'idle',
  draft_id    BIGINT REFERENCES wizard_drafts(id),
  pending_alert_id BIGINT REFERENCES alerts(id),
  followups_asked INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wa_number)
);

CREATE TABLE wa_messages (
  id         BIGSERIAL PRIMARY KEY,
  org_id     BIGINT REFERENCES orgs(id) ON DELETE CASCADE,
  wa_number  TEXT NOT NULL,
  direction  TEXT NOT NULL CHECK (direction IN ('in','out')),
  body       JSONB NOT NULL,
  wa_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AI recommendations (weekly)
CREATE TABLE recommendations (
  id         BIGSERIAL PRIMARY KEY,
  org_id     BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ad_account_id BIGINT REFERENCES ad_accounts(id),
  week_start DATE NOT NULL,
  payload    JSONB NOT NULL,              -- {actions:[3], copies:[5], summary}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ad_account_id, week_start)
);

-- Model B: prepaid wallet + ledger + invoices
CREATE TABLE wallets (
  org_id       BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  balance      NUMERIC(14,2) NOT NULL DEFAULT 0,
  low_balance_threshold NUMERIC(14,2) NOT NULL DEFAULT 2000,
  auto_paused  BOOLEAN NOT NULL DEFAULT false,
  last_low_alert_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallet_ledger (
  id         BIGSERIAL PRIMARY KEY,
  org_id     BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('topup','spend','service_fee','adjustment','refund')),
  amount     NUMERIC(14,2) NOT NULL,      -- +credit / -debit
  balance_after NUMERIC(14,2) NOT NULL,
  ref        TEXT,                        -- payment id / spend date / invoice no
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX wallet_ledger_spend_once ON wallet_ledger (org_id, ref) WHERE kind = 'spend';

CREATE TABLE invoices (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  number      TEXT UNIQUE NOT NULL,
  month       DATE NOT NULL,
  ad_spend    NUMERIC(14,2) NOT NULL,
  service_fee NUMERIC(14,2) NOT NULL,
  gst         NUMERIC(14,2) NOT NULL,
  total       NUMERIC(14,2) NOT NULL,
  status      TEXT NOT NULL DEFAULT 'issued',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, month)
);

-- Meta data deletion callback requests
CREATE TABLE deletion_requests (
  id                BIGSERIAL PRIMARY KEY,
  meta_user_id      TEXT NOT NULL,
  confirmation_code TEXT UNIQUE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','completed','failed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);

-- Webhook dedupe
CREATE TABLE webhook_events (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Row-level security as a second wall behind withOrg(). The app DB role must not be
-- a superuser / table owner for RLS to bite; see docs/SECURITY.md.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['meta_connections','ad_accounts','campaigns','adsets','creatives','ads',
    'insights_daily','rules','alerts','actions_log','leads','lead_forms','wizard_drafts','recommendations',
    'wallets','wallet_ledger','invoices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON %I USING (
      current_setting('app.org_id', true) IS NULL
      OR current_setting('app.org_id', true) = ''
      OR org_id = current_setting('app.org_id', true)::bigint)$p$, t);
  END LOOP;
END $$;
