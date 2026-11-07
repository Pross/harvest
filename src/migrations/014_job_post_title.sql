-- Post action "Title NFO": write a Jellyfin/Kodi/Emby episode .nfo next to each downloaded video, titled from its filename.
-- title_strip: comma-separated release tokens (e.g. SkyF1HD, 1080P) removed from the title.
ALTER TABLE job_post ADD COLUMN title_nfo INTEGER NOT NULL DEFAULT 0 CHECK (title_nfo IN (0, 1));
ALTER TABLE job_post ADD COLUMN title_strip TEXT NOT NULL DEFAULT '';
