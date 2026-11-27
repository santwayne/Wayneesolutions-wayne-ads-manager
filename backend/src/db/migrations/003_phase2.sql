-- Phase 2: self-serve, Razorpay billing, Loopdesk hub, MCP OAuth, CAPI for CRM, Google Ads

-- Self-serve + Loopdesk hub
ALTER TABLE orgs ADD COLUMN self_serve BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE orgs ADD COLUMN hub_business_id TEXT UNIQUE;
ALTER TABLE orgs ADD COLUMN hub_status TEXT;               -- active / paused (bundle lapsed)
ALTER TABLE orgs ADD COLUMN hub_owner_user_id BIGINT REFERENCES users(id);
ALTER TABLE orgs ADD COLUMN subscription_status TEXT;      -- self-serve plan status

CREATE TABLE hub_tickets_used (jti TEXT PRIMARY KEY, used_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE hub_events_outbox (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  sent_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Razorpay
CREATE TABLE payments (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('wallet_topup','invoice','subscription')),
  invoice_id BIGINT REFERENCES invoices(id),
  rp_order_id TEXT UNIQUE NOT NULL,
  rp_payment_id TEXT UNIQUE,
  amount NUMERIC(14,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX wallet_ledger_topup_once ON wallet_ledger (org_id, ref) WHERE kind = 'topup';

-- MCP connector OAuth (per user)
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  resource TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  resource TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT false
);

-- Conversions API for CRM
ALTER TABLE ad_accounts ADD COLUMN capi_dataset_id TEXT;
ALTER TABLE leads ADD COLUMN capi_sent_at TIMESTAMPTZ;

-- Google Ads
CREATE TABLE google_connections (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  refresh_token_enc TEXT NOT NULL,
  login_customer_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE google_accounts (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  connection_id BIGINT NOT NULL REFERENCES google_connections(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL UNIQUE,     -- digits only
  name TEXT,
  currency TEXT,
  last_synced_at TIMESTAMPTZ
);
CREATE TABLE google_campaigns (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  google_account_id BIGINT NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL,
  name TEXT, status TEXT, channel TEXT,
  UNIQUE (google_account_id, campaign_id)
);
ALTER TABLE insights_daily ADD COLUMN platform TEXT NOT NULL DEFAULT 'meta';

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['hub_events_outbox','payments','google_connections','google_accounts','google_campaigns'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON %I USING (
      current_setting('app.org_id', true) IS NULL OR current_setting('app.org_id', true) = ''
      OR org_id = current_setting('app.org_id', true)::bigint)$p$, t);
  END LOOP;
END $$;
