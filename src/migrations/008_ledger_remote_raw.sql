-- The server's own spelling of a remote path when it differs from the NFC ledger key (NFD names).
-- NULL means the key is the raw name, or (rows written before this migration) that the raw name is unknown.
ALTER TABLE ledger ADD COLUMN remote_raw TEXT;
ALTER TABLE partials ADD COLUMN remote_raw TEXT;
