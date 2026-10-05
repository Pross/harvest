CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron','interval','manual','webhook','followup')),
  state TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER,
  bytes_total INTEGER NOT NULL DEFAULT 0,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  files_planned INTEGER NOT NULL DEFAULT 0,
  files_ok INTEGER NOT NULL DEFAULT 0,
  files_failed INTEGER NOT NULL DEFAULT 0,
  files_skipped INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX runs_job ON runs(job_id, id DESC);

CREATE TABLE run_files (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  unit_key TEXT NOT NULL,
  remote_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  state TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX run_files_run ON run_files(run_id, state);

CREATE TABLE partials (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  remote_path TEXT NOT NULL,
  remote_size INTEGER NOT NULL,
  remote_mtime_ms INTEGER,
  staging_path TEXT NOT NULL,
  promote_state TEXT NOT NULL DEFAULT 'downloading' CHECK (promote_state IN ('downloading','promoting')),
  final_path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (job_id, remote_path)
);

CREATE TABLE partial_ranges (
  partial_id INTEGER NOT NULL REFERENCES partials(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  durable_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (partial_id, idx)
);
