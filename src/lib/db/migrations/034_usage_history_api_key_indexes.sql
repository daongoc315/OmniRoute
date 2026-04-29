-- Index for API key usage analytics.
-- The summary query filters by timestamp, then groups by API key/provider/model.

CREATE INDEX IF NOT EXISTS idx_uh_api_key_summary_time
  ON usage_history(timestamp, api_key_id, api_key_name, provider, model)
  WHERE api_key_id IS NOT NULL OR api_key_name IS NOT NULL;
