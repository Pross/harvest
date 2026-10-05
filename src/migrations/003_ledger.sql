CREATE TABLE ledger (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  remote_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER,
  hash TEXT,
  synced_at INTEGER NOT NULL,
  run_id INTEGER,
  remote_action TEXT NOT NULL DEFAULT 'none' CHECK (remote_action IN ('none','pending','done','failed','skipped')),
  remote_action_at INTEGER,
  forgotten_at INTEGER,
  UNIQUE (job_id, remote_path)
);
CREATE INDEX ledger_pending ON ledger(remote_action, remote_action_at);

CREATE TABLE ledger_units (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  unit_key TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, unit_key)
);
