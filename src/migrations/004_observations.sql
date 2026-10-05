CREATE TABLE remote_observations (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  remote_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_changed_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, remote_path)
);
