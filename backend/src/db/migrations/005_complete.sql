-- Forgot password + team invites
CREATE TABLE user_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('reset','invite')),
  org_id     BIGINT REFERENCES orgs(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_tokens_user ON user_tokens (user_id, purpose);
ALTER TABLE users ADD COLUMN password_set BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE memberships ADD COLUMN invited_by BIGINT REFERENCES users(id);
ALTER TABLE memberships ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Live report share links + monthly report log
CREATE TABLE report_links (
  id         BIGSERIAL PRIMARY KEY,
  org_id     BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  created_by BIGINT REFERENCES users(id),
  expires_at TIMESTAMPTZ,
  revoked    BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE monthly_reports (
  org_id     BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  month      DATE NOT NULL,
  payload    JSONB NOT NULL,
  sent_at    TIMESTAMPTZ,
  PRIMARY KEY (org_id, month)
);
ALTER TABLE report_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON report_links USING (current_setting('app.org_id', true) IS NULL OR current_setting('app.org_id', true) = '' OR org_id = current_setting('app.org_id', true)::bigint);
CREATE POLICY org_isolation ON monthly_reports USING (current_setting('app.org_id', true) IS NULL OR current_setting('app.org_id', true) = '' OR org_id = current_setting('app.org_id', true)::bigint);
