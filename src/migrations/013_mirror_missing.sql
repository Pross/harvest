-- Mirror mode deletes a local file only after it was missing from two complete listings in a row.
-- The run that first saw the file missing; NULL while the file is listed. Cleared when the file reappears or is re-downloaded.
ALTER TABLE ledger ADD COLUMN missing_run_id INTEGER;
