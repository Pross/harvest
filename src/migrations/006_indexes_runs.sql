-- Run bookkeeping and index additions. Nothing deployed before this, but kept as a new migration.
DELETE FROM run_files WHERE id NOT IN (SELECT MAX(id) FROM run_files GROUP BY run_id, remote_path);
CREATE UNIQUE INDEX run_files_run_path ON run_files(run_id, remote_path);
CREATE INDEX run_files_finished ON run_files(finished_at);

ALTER TABLE runs ADD COLUMN created_at INTEGER;
UPDATE runs SET created_at = COALESCE(started_at, finished_at, 0) WHERE created_at IS NULL;
CREATE INDEX runs_state ON runs(state, job_id);
CREATE INDEX runs_finished ON runs(finished_at);

CREATE INDEX ledger_job_active ON ledger(job_id, forgotten_at, synced_at DESC, id DESC);
CREATE INDEX activity_job ON activity(job_id, id DESC);
CREATE INDEX activity_severity ON activity(severity, id DESC);
