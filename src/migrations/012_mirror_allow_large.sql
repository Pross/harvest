-- One-shot, expiring permission for the next real mirror run to delete past its safety limits
-- (empty remote listing, or more than half of the ledger gone). Cleared by that run and by edits to the job.
ALTER TABLE jobs ADD COLUMN mirror_allow_large_at INTEGER;
