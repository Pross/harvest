import { promises as fsp } from "node:fs";
import path from "node:path";
import type { PartialRow } from "../run/types.js";
import { STAGING_DIR, stagingRoot } from "../run/paths.js";
import type { MaintenanceDeps, MaintenanceResult } from "./maintenance.js";

const DAY = 86_400_000;
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function note(deps: MaintenanceDeps, jobId: number, summary: string): void {
  try {
    deps.stores.activity.record({ category: "maintenance", severity: "warn", jobId, summary });
  } catch (err) {
    deps.logger.error({ err }, "maintenance bookkeeping failed");
  }
}

const busyJobs = (deps: MaintenanceDeps): Set<number> => new Set([...deps.stores.runs.busyJobIds(), ...(deps.busyJobs?.() ?? [])]);
const remover = (deps: MaintenanceDeps) => deps.removeFile ?? ((p: string) => fsp.rm(p, { recursive: true, force: true }));

function findStale(deps: MaintenanceDeps, olderThanMs: number, res: MaintenanceResult): PartialRow[] | undefined {
  try {
    return deps.stalePartials(olderThanMs);
  } catch (err) {
    res.errors++;
    deps.logger.error({ err }, "maintenance could not list stale partials");
    return undefined;
  }
}

/** Stale partials: their staged bytes are removed and the row discarded. Partials of busy jobs and promoting partials are left alone. */
async function discardStale(deps: MaintenanceDeps, now: number, days: number, res: MaintenanceResult): Promise<void> {
  const stale = findStale(deps, now - days * DAY, res);
  if (!stale) return;
  const busy = busyJobs(deps);
  for (const p of stale) {
    deps.signal?.throwIfAborted();
    if (p.promoteState === "promoting" || busy.has(p.jobId)) continue;
    try {
      await remover(deps)(p.stagingPath);
      deps.stores.partials.discard(p.id);
      res.stagingDiscarded++;
    } catch (err) {
      res.errors++;
      deps.logger.error({ err, partialId: p.id }, "maintenance could not discard a stale partial");
      note(deps, p.jobId, `Could not discard stale staging ${p.stagingPath}: ${errText(err)}`);
    }
  }
}

type Walk = { deps: MaintenanceDeps; cutoff: number; known: Set<string>; res: MaintenanceResult; jobId: number };

/** A real directory (not a symlink): the sweep never follows links out of staging. */
const isRealDir = (p: string): Promise<boolean> => fsp.lstat(p).then((st) => st.isDirectory(), () => false);

/** Removes regular files older than the cutoff that no partial row owns; prunes directories that end up empty. */
async function walk(w: Walk, dir: string, isRoot: boolean): Promise<void> {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    w.deps.signal?.throwIfAborted();
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(w, full, false);
    else if (e.isFile() && !w.known.has(full)) await sweepFile(w, full);
  }
  if (!isRoot) await fsp.rmdir(dir).catch(() => {});
}

async function sweepFile(w: Walk, file: string): Promise<void> {
  try {
    if ((await fsp.lstat(file)).mtimeMs >= w.cutoff) return;
    await remover(w.deps)(file);
    w.res.stagingDiscarded++;
  } catch (err) {
    w.res.errors++;
    w.deps.logger.error({ err, file }, "maintenance could not remove an orphaned staging file");
    note(w.deps, w.jobId, `Could not remove orphaned staging file ${file}: ${errText(err)}`);
  }
}

/**
 * Staging files under `.harvest-staging/<job>` that no partial row owns (extraction output of an aborted attempt, an archive left
 * behind by a crash between the ledger commit and the archive delete) and that are older than `days`. Jobs with a queued or
 * running run are skipped (checked again right before each job), and nothing outside `.harvest-staging` is ever touched.
 */
async function sweepOrphans(deps: MaintenanceDeps, now: number, days: number, res: MaintenanceResult): Promise<void> {
  const rows = findStale(deps, Number.MAX_SAFE_INTEGER, res);
  if (!rows) return;
  const known = new Set(rows.map((r) => path.resolve(r.stagingPath)));
  for (const job of deps.stores.jobs.list()) {
    deps.signal?.throwIfAborted();
    const root = stagingRoot(job.localPath, job.id);
    if (busyJobs(deps).has(job.id) || !(await isRealDir(path.join(job.localPath, STAGING_DIR))) || !(await isRealDir(root))) continue;
    try {
      await walk({ deps, cutoff: now - days * DAY, known, res, jobId: job.id }, root, true);
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      res.errors++;
      deps.logger.error({ err, jobId: job.id }, "maintenance staging sweep failed");
      note(deps, job.id, `Staging sweep failed: ${errText(err)}`);
    }
  }
}

export async function cleanStaging(deps: MaintenanceDeps, now: number, days: number, res: MaintenanceResult): Promise<void> {
  await discardStale(deps, now, days, res);
  await sweepOrphans(deps, now, days, res);
}
