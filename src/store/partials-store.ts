import type { DB } from "../db.js";
import type { PartialRow, PartialsStore, RangeRow } from "../run/types.js";

type PartialSql = {
  id: number; job_id: number; remote_path: string; remote_size: number; remote_mtime_ms: number | null;
  staging_path: string; promote_state: "downloading" | "promoting"; final_path: string | null; remote_raw: string | null;
};

function toPartial(r: PartialSql): PartialRow {
  return {
    id: r.id, jobId: r.job_id, remotePath: r.remote_path, remoteSize: r.remote_size, remoteMtimeMs: r.remote_mtime_ms,
    stagingPath: r.staging_path, promoteState: r.promote_state, finalPath: r.final_path, remoteRaw: r.remote_raw,
  };
}

export class SqlitePartialsStore implements PartialsStore {
  constructor(private readonly db: DB) {}

  /** Rows not updated since `cutoffMs` (a timestamp, not a duration). */
  listOlderThan(cutoffMs: number): PartialRow[] {
    const rows = this.db.prepare("SELECT * FROM partials WHERE updated_at < ? ORDER BY updated_at").all(cutoffMs) as PartialSql[];
    return rows.map(toPartial);
  }

  get(jobId: number, remotePath: string): PartialRow | undefined {
    const r = this.db.prepare("SELECT * FROM partials WHERE job_id = ? AND remote_path = ?").get(jobId, remotePath) as PartialSql | undefined;
    return r && toPartial(r);
  }

  create(row: Omit<PartialRow, "id" | "promoteState" | "finalPath">, ranges: Omit<RangeRow, "partialId" | "durableBytes">[]): PartialRow {
    const now = Date.now();
    const id = this.db.transaction(() => {
      const res = this.db.prepare(
        `INSERT INTO partials (job_id, remote_path, remote_size, remote_mtime_ms, staging_path, created_at, updated_at, remote_raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.jobId, row.remotePath, row.remoteSize, row.remoteMtimeMs, row.stagingPath, now, now, row.remoteRaw ?? null);
      const ins = this.db.prepare("INSERT INTO partial_ranges (partial_id, idx, start_byte, end_byte) VALUES (?, ?, ?, ?)");
      for (const r of ranges) ins.run(res.lastInsertRowid, r.idx, r.startByte, r.endByte);
      return Number(res.lastInsertRowid);
    })();
    return { ...row, remoteRaw: row.remoteRaw ?? null, id, promoteState: "downloading", finalPath: null };
  }

  ranges(partialId: number): RangeRow[] {
    const rows = this.db.prepare("SELECT * FROM partial_ranges WHERE partial_id = ? ORDER BY idx").all(partialId) as
      { partial_id: number; idx: number; start_byte: number; end_byte: number; durable_bytes: number }[];
    return rows.map((r) => ({ partialId: r.partial_id, idx: r.idx, startByte: r.start_byte, endByte: r.end_byte, durableBytes: r.durable_bytes }));
  }

  /** Monotonic: durable_bytes = MAX(old, MIN(new, range length)). */
  checkpoint(partialId: number, snapshots: { idx: number; durableBytes: number }[]): void {
    const upd = this.db.prepare(
      `UPDATE partial_ranges SET durable_bytes = MAX(durable_bytes, MIN(?, end_byte - start_byte))
       WHERE partial_id = ? AND idx = ?`,
    );
    this.db.transaction(() => {
      for (const s of snapshots) upd.run(Math.max(0, s.durableBytes), partialId, s.idx);
      this.db.prepare("UPDATE partials SET updated_at = ? WHERE id = ?").run(Date.now(), partialId);
    })();
  }

  setPromoting(partialId: number, finalPath: string): void {
    const res = this.db.prepare("UPDATE partials SET promote_state = 'promoting', final_path = ?, updated_at = ? WHERE id = ?")
      .run(finalPath, Date.now(), partialId);
    if (res.changes === 0) throw new Error(`partial ${partialId} not found`);
  }

  discard(partialId: number): void {
    this.db.prepare("DELETE FROM partials WHERE id = ?").run(partialId);
  }

  listPromoting(): PartialRow[] {
    return (this.db.prepare("SELECT * FROM partials WHERE promote_state = 'promoting' ORDER BY id").all() as PartialSql[]).map(toPartial);
  }
}
