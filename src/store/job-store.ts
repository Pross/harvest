import { z } from "zod";
import type { DB } from "../db.js";
import { DEFAULT_EXCLUDES, type JobConfig } from "../domain.js";
import { TERMINAL_RUN_STATES } from "../domain.js";
import type { JobStore } from "../run/types.js";
import { JobBusyError } from "./errors.js";

export type JobInput = Partial<Omit<JobConfig, "id" | "rerunPending">> & Pick<JobConfig, "name" | "hostId" | "remotePath" | "localPath">;

export type BadJobRow = { id: number; name: string; error: string };

const globs = z.array(z.string());
type Sql = Record<string, unknown>;

/** [JobConfig key, column, kind]. Drives row mapping, insert and update generically. */
const FIELDS: readonly [keyof JobConfig, string, "str" | "num" | "bool" | "json"][] = [
  ["name", "name", "str"], ["hostId", "host_id", "num"], ["enabled", "enabled", "bool"], ["remotePath", "remote_path", "str"],
  ["localPath", "local_path", "str"], ["mode", "mode", "str"], ["unitMode", "unit_mode", "str"], ["afterSync", "after_sync", "str"],
  ["afterDays", "after_days", "num"], ["moveTo", "move_to", "str"], ["verify", "verify", "str"], ["settleSeconds", "settle_seconds", "num"],
  ["minAgeSeconds", "min_age_seconds", "num"], ["minSize", "min_size", "num"], ["maxSize", "max_size", "num"],
  ["includeGlobs", "include_globs", "json"], ["excludeGlobs", "exclude_globs", "json"], ["trustMtime", "trust_mtime", "bool"],
  ["rerunPending", "rerun_pending", "bool"], ["bwlimitBps", "bwlimit_bps", "num"], ["parallelFiles", "parallel_files", "num"],
  ["rangeStreams", "range_streams", "num"], ["retries", "retries", "num"], ["minFreeBytes", "min_free_bytes", "num"],
  ["scheduleKind", "schedule_kind", "str"], ["scheduleExpr", "schedule_expr", "str"], ["changedPolicy", "changed_policy", "str"],
  ["mirrorArmedAt", "mirror_armed_at", "num"],
];

const DEFAULTS: Partial<JobConfig> = {
  enabled: true, mode: "copy_new", unitMode: "top_dir", afterSync: "keep", afterDays: null, moveTo: null, verify: "size",
  settleSeconds: 300, minAgeSeconds: 0, minSize: null, maxSize: null, includeGlobs: [], trustMtime: false, bwlimitBps: null,
  parallelFiles: 2, rangeStreams: 4, retries: 3, minFreeBytes: null, scheduleKind: "manual", scheduleExpr: null, changedPolicy: "skip", mirrorArmedAt: null,
};

function parseGlobs(raw: unknown, col: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch (err) {
    throw new Error(`jobs.${col} is not valid JSON: ${(err as Error).message}`);
  }
  const res = globs.safeParse(parsed);
  if (!res.success) throw new Error(`jobs.${col} must be a JSON array of strings`);
  return res.data;
}

function toJob(r: Sql): JobConfig {
  const out: Record<string, unknown> = { id: r.id };
  for (const [key, col, kind] of FIELDS) {
    const v = r[col];
    out[key] = kind === "bool" ? v === 1 : kind === "json" ? parseGlobs(v, col) : v;
  }
  return out as JobConfig;
}

function toSql(kind: "str" | "num" | "bool" | "json", v: unknown): unknown {
  if (v === undefined || v === null) return null;
  return kind === "bool" ? (v ? 1 : 0) : kind === "json" ? JSON.stringify(v) : v;
}

export class SqliteJobStore implements JobStore {
  constructor(private readonly db: DB) {}

  get(id: number): JobConfig | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Sql | undefined;
    return r && toJob(r);
  }

  list(): JobConfig[] {
    return (this.db.prepare("SELECT * FROM jobs ORDER BY name").all() as Sql[]).map(toJob);
  }

  /** Enabled scheduled jobs; rows whose JSON columns fail to parse are skipped (see scheduledJobsChecked). */
  scheduledJobs(): JobConfig[] {
    return this.scheduledJobsChecked().jobs;
  }

  /** Like scheduledJobs, but also reports the rows that could not be parsed instead of throwing. */
  scheduledJobsChecked(): { jobs: JobConfig[]; bad: BadJobRow[] } {
    const rows = this.db.prepare("SELECT * FROM jobs WHERE enabled = 1 AND schedule_kind != 'manual' ORDER BY id").all() as Sql[];
    const out: { jobs: JobConfig[]; bad: BadJobRow[] } = { jobs: [], bad: [] };
    for (const r of rows) {
      try {
        out.jobs.push(toJob(r));
      } catch (err) {
        out.bad.push({ id: r.id as number, name: String(r.name), error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }

  /** Ids of jobs whose rerun_pending flag is set (read straight from SQL, so a bad JSON column cannot hide one). */
  rerunPendingIds(): number[] {
    return (this.db.prepare("SELECT id FROM jobs WHERE rerun_pending = 1 ORDER BY id").all() as { id: number }[]).map((r) => r.id);
  }

  create(input: JobInput): number {
    const merged: Record<string, unknown> = { ...DEFAULTS, excludeGlobs: [...DEFAULT_EXCLUDES], rerunPending: false };
    for (const [k, v] of Object.entries(input)) if (v !== undefined) merged[k] = v;
    const fields = FIELDS.filter(([k]) => k !== "rerunPending");
    const now = Date.now();
    const cols = [...fields.map(([, c]) => c), "created_at", "updated_at"];
    const vals = [...fields.map(([k, , kind]) => toSql(kind, merged[k])), now, now];
    const res = this.db.prepare(`INSERT INTO jobs (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...vals);
    return Number(res.lastInsertRowid);
  }

  /** Changing remotePath or hostId clears the pending/failed remote actions recorded against the old location. */
  update(id: number, input: Partial<Omit<JobConfig, "id">>): void {
    const patch: Partial<JobConfig> = input;
    const sets: string[] = ["updated_at = ?"];
    const vals: unknown[] = [Date.now()];
    for (const [key, col, kind] of FIELDS) {
      if (patch[key] === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(toSql(kind, patch[key]));
    }
    this.db.transaction(() => {
      const cur = this.db.prepare("SELECT remote_path, host_id FROM jobs WHERE id = ?").get(id) as { remote_path: string; host_id: number } | undefined;
      if (!cur) throw new Error(`job ${id} not found`);
      this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
      const moved = (patch.remotePath !== undefined && patch.remotePath !== cur.remote_path) || (patch.hostId !== undefined && patch.hostId !== cur.host_id);
      if (moved) {
        this.db.prepare("UPDATE ledger SET remote_action = 'none', remote_action_at = NULL WHERE job_id = ? AND remote_action IN ('pending','failed')").run(id);
      }
    })();
  }

  /**
   * Deletes a job and returns the staging paths of the partial downloads that were orphaned by it, so the caller can
   * remove them (or surface them). Throws JobBusyError while the job has a non-terminal run.
   */
  delete(id: number): string[] {
    const marks = TERMINAL_RUN_STATES.map(() => "?").join(",");
    return this.db.transaction(() => {
      const busy = this.db.prepare(`SELECT 1 FROM runs WHERE job_id = ? AND state NOT IN (${marks}) LIMIT 1`).get(id, ...TERMINAL_RUN_STATES);
      if (busy) throw new JobBusyError(id);
      const paths = (this.db.prepare("SELECT staging_path FROM partials WHERE job_id = ?").all(id) as { staging_path: string }[]).map((r) => r.staging_path);
      this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
      return paths;
    })();
  }

  setRerunPending(id: number, pending: boolean): void {
    this.db.prepare("UPDATE jobs SET rerun_pending = ? WHERE id = ?").run(pending ? 1 : 0, id);
  }
}
