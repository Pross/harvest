import type { DB } from "../db.js";
import type { ActivityStore } from "../run/types.js";

export type Severity = "info" | "warn" | "error";
export type ActivityRow = {
  id: number; ts: number; category: string; severity: Severity;
  jobId: number | null; runId: number | null; summary: string; meta: unknown;
};

type ActivitySql = {
  id: number; ts: number; category: string; severity: Severity;
  job_id: number | null; run_id: number | null; summary: string; meta_json: string | null;
};

/** A corrupt meta_json must not fail a whole listing: fall back to the raw string. */
function parseMeta(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export class SqliteActivityStore implements ActivityStore {
  constructor(private readonly db: DB) {}

  record(e: { category: string; severity?: Severity; jobId?: number; runId?: number; summary: string; meta?: unknown }): number {
    const meta = e.meta === undefined ? null : JSON.stringify(e.meta);
    const res = this.db.prepare("INSERT INTO activity (ts, category, severity, job_id, run_id, summary, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(Date.now(), e.category, e.severity ?? "info", e.jobId ?? null, e.runId ?? null, e.summary, meta);
    return Number(res.lastInsertRowid);
  }

  /** Keyset pagination, newest first: pass the last row's id as `beforeId` for the next page. */
  list(opts: { beforeId?: number; limit: number; jobId?: number; runId?: number; category?: string; severity?: Severity }): ActivityRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.beforeId !== undefined) { where.push("id < ?"); args.push(opts.beforeId); }
    if (opts.jobId !== undefined) { where.push("job_id = ?"); args.push(opts.jobId); }
    if (opts.runId !== undefined) { where.push("run_id = ?"); args.push(opts.runId); }
    if (opts.category !== undefined) { where.push("category = ?"); args.push(opts.category); }
    if (opts.severity !== undefined) { where.push("severity = ?"); args.push(opts.severity); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM activity ${clause} ORDER BY id DESC LIMIT ?`).all(...args, opts.limit) as ActivitySql[];
    return rows.map((r) => ({
      id: r.id, ts: r.ts, category: r.category, severity: r.severity, jobId: r.job_id, runId: r.run_id,
      summary: r.summary, meta: parseMeta(r.meta_json),
    }));
  }

  purgeOlderThan(ts: number): number {
    return this.db.prepare("DELETE FROM activity WHERE ts < ?").run(ts).changes;
  }
}
