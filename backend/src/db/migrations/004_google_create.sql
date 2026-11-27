ALTER TABLE google_campaigns ADD COLUMN created_by_wizard BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE google_campaigns ADD COLUMN wizard_draft_id BIGINT REFERENCES wizard_drafts(id);
ALTER TABLE google_campaigns ADD COLUMN daily_budget NUMERIC(14,2);
ALTER TABLE google_campaigns ADD COLUMN launched_at TIMESTAMPTZ;
ALTER TABLE wizard_drafts ADD COLUMN google_campaign_id TEXT;
