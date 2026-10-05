import type { DB } from "../db.js";
import type { LedgerStore } from "../run/types.js";
import type { LedgerEntry, PlannedFile } from "../planner/types.js";

/** `skipped` is terminal: the remote file changed since it was synced (or the job no longer asks for the action). */
export type RemoteAction = "none" | "pending" | "done" | "failed" | "skipped";
const DAY_MS = 86_400_000;
export type LedgerRow = LedgerEntry & { remoteRaw: string | null; hash: string | null; runId: number | null; remoteAction: RemoteAction; remoteActionAt: number | null };
export type DueAction = { jobId: number; remotePath: string; remoteRaw: string | null; remoteAction: RemoteAction; remoteActionAt: number | null };

type LedgerSql = {
  remote_path: string; size: number; mtime: number | null; hash: string | null; synced_at: number;
  run_id: number | null; remote_action: RemoteAction; remote_action_at: number | null; remote_raw: string | null;
};

function toRow(r: LedgerSql): LedgerRow {
  return {
    remotePath: r.remote_path, size: r.size, mtimeMs: r.mtime, syncedAt: r.synced_at, hash: r.hash, remoteRaw: r.remote_raw,
    runId: r.run_id, remoteAction: r.remote_action, remoteActionAt: r.remote_action_at,
  };
}

export class SqliteLedgerStore implements LedgerStore {
  constructor(private readonly db: DB) {}

  active(jobId: number): Map<string, LedgerEntry> {
    const rows = this.db.prepare("SELECT * FROM ledger WHERE job_id = ? AND forgotten_at IS NULL").all(jobId) as LedgerSql[];
    const out = new Map<string, LedgerEntry>();
    for (const r of rows) out.set(r.remote_path, { remotePath: r.remote_path, size: r.size, mtimeMs: r.mtime, syncedAt: r.synced_at });
    return out;
  }

  /** The active (not forgotten) row for one path. */
  get(jobId: number, remotePath: string): LedgerRow | undefined {
    const r = this.db.prepare("SELECT * FROM ledger WHERE job_id = ? AND remote_path = ? AND forgotten_at IS NULL").get(jobId, remotePath) as LedgerSql | undefined;
    return r && toRow(r);
  }

  /** Paths of forgotten (active = false) rows: an explicit resync may rename over their old local files. */
  forgottenPaths(jobId: number): Set<string> {
    const rows = this.db.prepare("SELECT remote_path FROM ledger WHERE job_id = ? AND forgotten_at IS NOT NULL").all(jobId) as { remote_path: string }[];
    return new Set(rows.map((r) => r.remote_path));
  }

  completedUnits(jobId: number): Set<string> {
    const rows = this.db.prepare("SELECT unit_key FROM ledger_units WHERE job_id = ?").all(jobId) as { unit_key: string }[];
    return new Set(rows.map((r) => r.unit_key));
  }

  commitUnit(jobId: number, unitKey: string, runId: number, files: (PlannedFile & { hash?: string })[], remoteAction: "none" | "pending", remoteActionAt: number | null): void {
    const now = Date.now();
    const upsert = this.db.prepare(
      `INSERT INTO ledger (job_id, remote_path, size, mtime, hash, synced_at, run_id, remote_action, remote_action_at, remote_raw, forgotten_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (job_id, remote_path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, hash = excluded.hash,
         synced_at = excluded.synced_at, run_id = excluded.run_id, remote_action = excluded.remote_action,
         remote_action_at = excluded.remote_action_at, remote_raw = excluded.remote_raw, forgotten_at = NULL`,
    );
    const delPartial = this.db.prepare("DELETE FROM partials WHERE job_id = ? AND remote_path = ?");
    this.db.transaction(() => {
      for (const f of files) {
        upsert.run(jobId, f.remotePath, f.size, f.mtimeMs, f.hash ?? null, now, runId, remoteAction, remoteActionAt, f.remoteRaw ?? null);
        delPartial.run(jobId, f.remotePath);
      }
      this.db.prepare(
        `INSERT INTO ledger_units (job_id, unit_key, completed_at) VALUES (?, ?, ?)
         ON CONFLICT (job_id, unit_key) DO UPDATE SET completed_at = excluded.completed_at`,
      ).run(jobId, unitKey, now);
    })();
  }

  forgetFile(jobId: number, remotePath: string): void {
    this.db.prepare("UPDATE ledger SET forgotten_at = ? WHERE job_id = ? AND remote_path = ? AND forgotten_at IS NULL")
      .run(Date.now(), jobId, remotePath);
  }

  forgetUnit(jobId: number, unitKey: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM ledger_units WHERE job_id = ? AND unit_key = ?").run(jobId, unitKey);
      this.db.prepare(
        `UPDATE ledger SET forgotten_at = ? WHERE job_id = ? AND forgotten_at IS NULL
         AND (remote_path = ? OR (remote_path >= ? AND remote_path < ?))`,
      ).run(Date.now(), jobId, unitKey, `${unitKey}/`, `${unitKey}0`);
    })();
  }

  forgetAll(jobId: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM ledger_units WHERE job_id = ?").run(jobId);
      this.db.prepare("UPDATE ledger SET forgotten_at = ? WHERE job_id = ? AND forgotten_at IS NULL").run(Date.now(), jobId);
    })();
  }

  duePendingActions(now: number): DueAction[] {
    const rows = this.db.prepare(
      `SELECT job_id, remote_path, remote_raw, remote_action, remote_action_at FROM ledger
       WHERE remote_action IN ('pending','failed') AND (remote_action_at IS NULL OR remote_action_at <= ?) AND forgotten_at IS NULL ORDER BY remote_action_at, id`,
    ).all(now) as { job_id: number; remote_path: string; remote_raw: string | null; remote_action: RemoteAction; remote_action_at: number | null }[];
    return rows.map((r) => ({ jobId: r.job_id, remotePath: r.remote_path, remoteRaw: r.remote_raw, remoteAction: r.remote_action, remoteActionAt: r.remote_action_at }));
  }

  /** A `failed` mark without an explicit `at` backs off 24 h before the next retry. */
  markRemoteAction(jobId: number, remotePath: string, action: RemoteAction, at?: number): void {
    const when = at ?? (action === "failed" ? Date.now() + DAY_MS : null);
    const res = this.db.prepare(
      "UPDATE ledger SET remote_action = ?, remote_action_at = COALESCE(?, remote_action_at) WHERE job_id = ? AND remote_path = ?",
    ).run(action, when, jobId, remotePath);
    if (res.changes === 0) throw new Error(`ledger row not found: ${jobId} ${remotePath}`);
  }

  listActive(jobId: number, opts: { limit: number; offset: number; search?: string }): { rows: LedgerRow[]; total: number } {
    const search = opts.search ? `%${opts.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : "%";
    const where = "job_id = ? AND forgotten_at IS NULL AND remote_path LIKE ? ESCAPE '\\'";
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM ledger WHERE ${where}`).get(jobId, search) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM ledger WHERE ${where} ORDER BY synced_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(jobId, search, opts.limit, opts.offset) as LedgerSql[];
    return { rows: rows.map(toRow), total };
  }
}
