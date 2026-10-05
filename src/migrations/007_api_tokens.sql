-- Per-job webhook tokens. Only the sha-256 of the token is stored; the plaintext is shown once at creation.
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX api_tokens_job ON api_tokens(job_id, id);
