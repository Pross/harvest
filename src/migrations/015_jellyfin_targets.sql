-- Allow kind 'jellyfin' on arr_targets. SQLite cannot alter a CHECK, so the table is rebuilt. Dropping a referenced table
-- runs the implicit DELETE with its FK actions (job_integrations.arr_target_id is ON DELETE SET NULL), and PRAGMA
-- foreign_keys is a no-op inside the migration transaction, so the child table is parked and rebuilt around the swap.
CREATE TABLE job_integrations_park AS SELECT * FROM job_integrations;
DROP TABLE job_integrations;

CREATE TABLE arr_targets_new (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('sonarr','radarr','jellyfin')),
  url TEXT NOT NULL,
  api_key_enc BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO arr_targets_new SELECT id, name, kind, url, api_key_enc, created_at, updated_at FROM arr_targets;
DROP TABLE arr_targets;
ALTER TABLE arr_targets_new RENAME TO arr_targets;

CREATE TABLE job_integrations (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  arr_target_id INTEGER REFERENCES arr_targets(id) ON DELETE SET NULL,
  -- The folder as the target's container sees job.localPath; replaces the local prefix.
  arr_path TEXT,
  notify_on TEXT NOT NULL DEFAULT 'failure' CHECK (notify_on IN ('never','failure','success','always')),
  -- JSON array of notify_channels ids; pruned by the channel store on delete.
  notify_channel_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX job_integrations_arr ON job_integrations(arr_target_id);
INSERT INTO job_integrations SELECT job_id, arr_target_id, arr_path, notify_on, notify_channel_ids FROM job_integrations_park;
DROP TABLE job_integrations_park;
