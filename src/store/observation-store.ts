import type { DB } from "../db.js";
import type { ObservationStore } from "../run/types.js";
import type { Observation } from "../planner/types.js";

const CHUNK = 500;

export class SqliteObservationStore implements ObservationStore {
  constructor(private readonly db: DB) {}

  all(jobId: number): Map<string, Observation> {
    const rows = this.db.prepare("SELECT * FROM remote_observations WHERE job_id = ?").all(jobId) as
      { remote_path: string; size: number; mtime: number | null; first_seen_at: number; last_changed_at: number; last_seen_at: number }[];
    const out = new Map<string, Observation>();
    for (const r of rows) {
      out.set(r.remote_path, {
        remotePath: r.remote_path, size: r.size, mtimeMs: r.mtime,
        firstSeenAt: r.first_seen_at, lastChangedAt: r.last_changed_at, lastSeenAt: r.last_seen_at,
      });
    }
    return out;
  }

  upsert(jobId: number, rows: Observation[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO remote_observations (job_id, remote_path, size, mtime, first_seen_at, last_changed_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (job_id, remote_path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime,
         first_seen_at = excluded.first_seen_at, last_changed_at = excluded.last_changed_at, last_seen_at = excluded.last_seen_at`,
    );
    this.db.transaction(() => {
      for (const r of rows) stmt.run(jobId, r.remotePath, r.size, r.mtimeMs, r.firstSeenAt, r.lastChangedAt, r.lastSeenAt);
    })();
  }

  /** Chunked so very large vanished lists stay under SQLite's bound-variable limit. */
  remove(jobId: number, remotePaths: string[]): void {
    this.db.transaction(() => {
      for (let i = 0; i < remotePaths.length; i += CHUNK) {
        const chunk = remotePaths.slice(i, i + CHUNK);
        const marks = chunk.map(() => "?").join(",");
        this.db.prepare(`DELETE FROM remote_observations WHERE job_id = ? AND remote_path IN (${marks})`).run(jobId, ...chunk);
      }
    })();
  }

  /** Delete observations not seen since `ts`. Returns the number removed. */
  purgeOlderThan(ts: number): number {
    return this.db.prepare("DELETE FROM remote_observations WHERE last_seen_at < ?").run(ts).changes;
  }
}
