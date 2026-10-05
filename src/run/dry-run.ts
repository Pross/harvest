import type { PlannedUnit, SkippedEntry } from "../planner/types.js";
import type { Stores } from "../store/index.js";

/** run_files states used by dry runs; nothing else in the app writes them. */
export const DRY_PLANNED = "planned";
export const DRY_SKIPPED = "would_skip";
/** Reason stored for units the free-space check would drop. */
export const DRY_NO_SPACE = "no_space";
/** Activity category of the row that carries a dry run's true totals. */
export const DRY_SUMMARY_CATEGORY = "dry-run";
/** Bounds the rows a huge remote can add to run_files per kind (planned, would-skip); the summary row keeps the true counts. */
export const DRY_ROW_CAP = 5000;

/** True totals of a dry run, stored as the meta of its `dry-run` activity row because the file rows are capped. */
export type DrySummary = { plannedFiles: number; plannedBytes: number; plannedUnits: number; skipCounts: Record<string, number> };

type Runs = Stores["runs"];

function recordPlanned(runs: Runs, runId: number, kept: readonly PlannedUnit[]): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const u of kept) {
    for (const f of u.files) {
      if (files < DRY_ROW_CAP) runs.recordFile({ runId, unitKey: u.key, remotePath: f.remotePath, size: f.size, state: DRY_PLANNED, bytes: 0, attempts: 0 });
      files++;
      bytes += f.size;
    }
  }
  return { files, bytes };
}

/** Writes at most DRY_ROW_CAP would-skip rows (listing order) and returns the true per-reason counts. */
function recordSkips(runs: Runs, runId: number, skipped: readonly SkippedEntry[], dropped: readonly PlannedUnit[]): Record<string, number> {
  const counts: Record<string, number> = {};
  let rows = 0;
  const add = (unitKey: string, remotePath: string, size: number, reason: string, error: string): void => {
    counts[reason] = (counts[reason] ?? 0) + 1;
    if (rows++ < DRY_ROW_CAP) runs.recordFile({ runId, unitKey, remotePath, size, state: DRY_SKIPPED, bytes: 0, attempts: 0, error });
  };
  for (const s of skipped) add("", s.remotePath, 0, s.reason, s.detail ? `${s.reason}: ${s.detail}` : s.reason);
  for (const u of dropped) for (const f of u.files) add(u.key, f.remotePath, f.size, DRY_NO_SPACE, DRY_NO_SPACE);
  return counts;
}

/**
 * Persists a dry run's plan in ONE transaction: the would-download files (units that fit), the would-skip files
 * (plan skips plus units dropped for space), run totals, and a summary activity row with the true counts.
 */
export function recordDryRun(stores: Stores, runId: number, skipped: readonly SkippedEntry[], kept: readonly PlannedUnit[], dropped: readonly PlannedUnit[]): void {
  stores.runs.inTransaction(() => {
    const planned = recordPlanned(stores.runs, runId, kept);
    const skipCounts = recordSkips(stores.runs, runId, skipped, dropped);
    stores.runs.setPlanned(runId, planned.files, planned.bytes);
    const summary: DrySummary = { plannedFiles: planned.files, plannedBytes: planned.bytes, plannedUnits: kept.length, skipCounts };
    stores.activity.record({ category: DRY_SUMMARY_CATEGORY, runId, jobId: stores.runs.get(runId)?.jobId, summary: `Recorded the plan: ${planned.files} file(s) and would skip ${Object.values(skipCounts).reduce((a, b) => a + b, 0)}`, meta: summary });
  });
}
