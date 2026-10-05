import type { DB } from "../db.js";

export type ExtractMode = "off" | "keep" | "delete";
export type PostConfig = { extract: ExtractMode; chmodFile: string | null; chmodDir: string | null };
type Row = { extract: ExtractMode; chmod_file: string | null; chmod_dir: string | null };

export const DEFAULT_POST: PostConfig = { extract: "off", chmodFile: null, chmodDir: null };

/** Per-job post-action settings (archive extraction mode, chmod modes). A job without a row has the defaults. */
export class SqlitePostStore {
  constructor(private readonly db: DB) {}

  get(jobId: number): PostConfig {
    const row = this.db.prepare("SELECT extract, chmod_file, chmod_dir FROM job_post WHERE job_id = ?").get(jobId) as Row | undefined;
    return row ? { extract: row.extract, chmodFile: row.chmod_file, chmodDir: row.chmod_dir } : { ...DEFAULT_POST };
  }

  /** Upserts the config. Throws a foreign-key error for an unknown job. */
  set(jobId: number, cfg: PostConfig): void {
    this.db.prepare(
      `INSERT INTO job_post (job_id, extract, chmod_file, chmod_dir) VALUES (?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET extract = excluded.extract, chmod_file = excluded.chmod_file, chmod_dir = excluded.chmod_dir`,
    ).run(jobId, cfg.extract, cfg.chmodFile, cfg.chmodDir);
  }
}
