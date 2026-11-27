-- Out-of-area + junk leads -> custom audience, excluded from every wizard ad set.
CREATE TABLE exclusion_audiences (
  id            BIGSERIAL PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ad_account_id BIGINT NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  meta_id       TEXT,
  kind          TEXT NOT NULL DEFAULT 'out_of_area_junk',
  size_sent     INT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ad_account_id, kind)
);
ALTER TABLE leads ADD COLUMN audience_synced BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ad_accounts ADD COLUMN pixel_last_fired_at TIMESTAMPTZ;
ALTER TABLE exclusion_audiences ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON exclusion_audiences USING (
  current_setting('app.org_id', true) IS NULL OR current_setting('app.org_id', true) = ''
  OR org_id = current_setting('app.org_id', true)::bigint);
