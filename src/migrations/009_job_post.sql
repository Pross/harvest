-- Per-job post actions (wave 2). A missing row means all defaults: extract off, no chmod.
CREATE TABLE job_post (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  extract TEXT NOT NULL DEFAULT 'off' CHECK (extract IN ('off','keep','delete')),
  chmod_file TEXT,
  chmod_dir TEXT
);
