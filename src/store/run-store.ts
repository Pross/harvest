import type { DB } from "../db.js";
import { TERMINAL_RUN_STATES, type RunState, type RunTrigger } from "../domain.js";
import type { RunStore } from "../run/types.js";

export type RunRow = {
  id: number; jobId: number; trigger: RunTrigger; state: RunState; dryRun: boolean;
  startedAt: number | null; finishedAt: number | null; bytesTotal: number; bytesDone: number;
  filesPlanned: number; filesOk: number; filesFailed: number; filesSkipped: number; error: string | null; createdAt: number | null;
};
export type RunFileInput = { runId: number; unitKey: string; remotePath: string; size: number; state: string; bytes: number; attempts: number; error?: string | null };
export type RunFileRow = { id: number; runId: number; unitKey: string; remotePath: string; size: number; state: string; bytes: number; startedAt: number | null; finishedAt: number | null; attempts: number; error: string | null };

type RunSql = {
  id: number; job_id: number; trigger: RunTrigger; state: RunState; dry_run: number; started_at: number | null; finished_at: number | null;
  bytes_total: number; bytes_done: number; files_planned: number; files_ok: number; files_failed: number; files_skipped: number; error: string | null; created_at: number | null;
};

const toRun = (r: RunSql): RunRow => ({
  id: r.id, jobId: r.job_id, trigger: r.trigger, state: r.state, dryRun: r.dry_run === 1, startedAt: r.started_at, finishedAt: r.finished_at,
  bytesTotal: r.bytes_total, bytesDone: r.bytes_done, filesPlanned: r.files_planned, filesOk: r.files_ok,
  filesFailed: r.files_failed, filesSkipped: r.files_skipped, error: r.error, createdAt: r.created_at,
});

const isTerminal = (s: RunState): boolean => TERMINAL_RUN_STATES.includes(s);
const TERMINAL_MARKS = TERMINAL_RUN_STATES.map(() => "?").join(",");
/** States a run can be in without ever having started work. */
const NEVER_STARTED: readonly RunState[] = ["queued", "cancelled", "skipped_locked", "skipped_space"];

export class SqliteRunStore implements RunStore {
  constructor(private readonly db: DB) {}

  create(jobId: number, trigger: RunTrigger, dryRun: boolean): number {
    const res = this.db.prepare("INSERT INTO runs (job_id, trigger, state, dry_run, created_at) VALUES (?, ?, 'queued', ?, ?)")
      .run(jobId, trigger, dryRun ? 1 : 0, Date.now());
    return Number(res.lastInsertRowid);
  }

  /**
   * Moves a run to `state`. A terminal state is final: returns false (and changes nothing) when the run is already
   * terminal. started_at is stamped only when entering a state that means work began. Throws if the run does not exist.
   */
  setState(runId: number, state: RunState, error?: string): boolean {
    const now = Date.now();
    const res = this.db.prepare(
      `UPDATE runs SET state = ?, error = COALESCE(?, error),
         started_at = CASE WHEN ? AND started_at IS NULL THEN ? ELSE started_at END,
         finished_at = CASE WHEN ? THEN ? ELSE finished_at END
       WHERE id = ? AND state NOT IN (${TERMINAL_MARKS})`,
    ).run(state, error ?? null, NEVER_STARTED.includes(state) ? 0 : 1, now, isTerminal(state) ? 1 : 0, now, runId, ...TERMINAL_RUN_STATES);
    if (res.changes > 0) return true;
    if (!this.get(runId)) throw new Error(`run ${runId} not found`);
    return false;
  }

  addProgress(runId: number, d: { bytesDone?: number; filesOk?: number; filesFailed?: number; filesSkipped?: number }): void {
    this.db.prepare(
      `UPDATE runs SET bytes_done = bytes_done + ?, files_ok = files_ok + ?, files_failed = files_failed + ?,
         files_skipped = files_skipped + ? WHERE id = ?`,
    ).run(d.bytesDone ?? 0, d.filesOk ?? 0, d.filesFailed ?? 0, d.filesSkipped ?? 0, runId);
  }

  setPlanned(runId: number, files: number, bytes: number): void {
    this.db.prepare("UPDATE runs SET files_planned = ?, bytes_total = ? WHERE id = ?").run(files, bytes, runId);
  }

  /** Fails every non-terminal run and records ONE `run.interrupted` activity row with the count. */
  failNonTerminal(reason: string): number {
    return this.db.transaction(() => {
      const now = Date.now();
      const n = this.db.prepare(`UPDATE runs SET state = 'failed', error = ?, finished_at = ? WHERE state NOT IN (${TERMINAL_MARKS})`)
        .run(reason, now, ...TERMINAL_RUN_STATES).changes;
      if (n > 0) {
        this.db.prepare("INSERT INTO activity (ts, category, severity, summary, meta_json) VALUES (?, 'run.interrupted', 'warn', ?, ?)")
          .run(now, `${n} run(s) were interrupted and marked failed: ${reason}`, JSON.stringify({ count: n, reason }));
      }
      return n;
    })();
  }

  /** Delete finished runs (and, by cascade, their run_files) that ended before `ts`. Returns the number removed. */
  purgeOlderThan(ts: number): number {
    return this.db.prepare("DELETE FROM runs WHERE finished_at IS NOT NULL AND finished_at < ?").run(ts).changes;
  }

  /** Delete per-file rows finished (or, if never finished, started) before `ts`, keeping the run summaries. */
  purgeFilesOlderThan(ts: number): number {
    return this.db.prepare("DELETE FROM run_files WHERE COALESCE(finished_at, started_at) < ?").run(ts).changes;
  }

  /** Jobs with a queued or running (non-terminal) run according to the database. */
  busyJobIds(): Set<number> {
    const rows = this.db.prepare(`SELECT DISTINCT job_id FROM runs WHERE state NOT IN (${TERMINAL_MARKS})`).all(...TERMINAL_RUN_STATES) as { job_id: number }[];
    return new Set(rows.map((r) => r.job_id));
  }

  get(runId: number): RunRow | undefined {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunSql | undefined;
    return r && toRun(r);
  }

  list(jobId: number, limit: number): RunRow[] {
    return (this.db.prepare("SELECT * FROM runs WHERE job_id = ? ORDER BY id DESC LIMIT ?").all(jobId, limit) as RunSql[]).map(toRun);
  }

  listRecent(limit: number): RunRow[] {
    return (this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit) as RunSql[]).map(toRun);
  }

  /** Runs `fn` in one transaction (it commits when `fn` returns and rolls back when it throws). */
  inTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Upsert by (run_id, remote_path); started_at is set on first write, finished_at on a terminal file state. */
  recordFile(f: RunFileInput): void {
    const now = Date.now();
    const done = f.state === "done" || f.state === "failed" || f.state === "skipped" ? now : null;
    this.db.prepare(
      `INSERT INTO run_files (run_id, unit_key, remote_path, size, state, bytes, started_at, finished_at, attempts, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, remote_path) DO UPDATE SET unit_key = excluded.unit_key, size = excluded.size, state = excluded.state,
         bytes = excluded.bytes, attempts = excluded.attempts, error = excluded.error,
         finished_at = COALESCE(excluded.finished_at, run_files.finished_at)`,
    ).run(f.runId, f.unitKey, f.remotePath, f.size, f.state, f.bytes, now, done, f.attempts, f.error ?? null);
  }

  filesForRun(runId: number): RunFileRow[] {
    const rows = this.db.prepare("SELECT * FROM run_files WHERE run_id = ? ORDER BY id").all(runId) as
      { id: number; run_id: number; unit_key: string; remote_path: string; size: number; state: string; bytes: number; started_at: number | null; finished_at: number | null; attempts: number; error: string | null }[];
    return rows.map((r) => ({
      id: r.id, runId: r.run_id, unitKey: r.unit_key, remotePath: r.remote_path, size: r.size, state: r.state, bytes: r.bytes,
      startedAt: r.started_at, finishedAt: r.finished_at, attempts: r.attempts, error: r.error,
    }));
  }
}
