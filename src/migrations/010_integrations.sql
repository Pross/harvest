-- Phase 2 integrations: *arr import targets, notification channels, and the per-job wiring.
-- Secrets (API keys, channel configs) are AES-256-GCM blobs written by the stores, like hosts.secret_enc.
CREATE TABLE arr_targets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('sonarr','radarr')),
  url TEXT NOT NULL,
  api_key_enc BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE notify_channels (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('ntfy','discord','telegram','pushover','webhook')),
  config_enc BLOB NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE job_integrations (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  arr_target_id INTEGER REFERENCES arr_targets(id) ON DELETE SET NULL,
  -- The folder as the *arr container sees job.localPath; replaces the local prefix.
  arr_path TEXT,
  notify_on TEXT NOT NULL DEFAULT 'failure' CHECK (notify_on IN ('never','failure','success','always')),
  -- JSON array of notify_channels ids; pruned by the channel store on delete.
  notify_channel_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX job_integrations_arr ON job_integrations(arr_target_id);
