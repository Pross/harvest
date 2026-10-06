-- Mirror mode only deletes after a dry run has been reviewed. Set by a successful dry run of a mirror job,
-- cleared when the job's mode, host, remote path or local path changes.
ALTER TABLE jobs ADD COLUMN mirror_armed_at INTEGER;
