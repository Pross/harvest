import { promises as fsp } from "node:fs";
import type { Logger } from "../logger.js";
import { unitKeyFor } from "../planner/plan.js";
import type { Stores } from "../store/index.js";
import type { PartialRow } from "./types.js";

export type RecoveryDeps = { stores: Stores; logger: Logger; now?: () => number };
export type RecoveryResult = { committedUnits: string[]; discardedFiles: number; resumableFiles: number };

async function sizeOf(p: string): Promise<number | null> {
  try {
    return (await fsp.stat(p)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

type FileState = "promoted" | "staged" | "lost";

/**
 * Per file: promoted means the rename happened (staged file gone) and the final file has the expected size;
 * staged means the bytes are still in staging (an older final file next to them is NOT our promote);
 * lost means neither, so nothing can be resumed.
 */
async function stateOf(row: PartialRow): Promise<FileState> {
  if ((await sizeOf(row.stagingPath)) !== null) return "staged";
  if (row.finalPath !== null && (await sizeOf(row.finalPath)) === row.remoteSize) return "promoted";
  return "lost";
}

function groupByUnit(stores: Stores, rows: PartialRow[]): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const job = stores.jobs.get(row.jobId);
    if (!job) continue;
    const unitKey = unitKeyFor(row.remotePath, job.unitMode);
    const g = groups.get(`${row.jobId}\0${unitKey}`) ?? { jobId: row.jobId, unitKey, rows: [] };
    g.rows.push(row);
    groups.set(`${row.jobId}\0${unitKey}`, g);
  }
  return groups;
}

/** Staged file: back to `downloading` (all bytes durable), so finalize reruns without a re-download and without treating an older final file as its own promote. */
function resetToDownloading(stores: Stores, row: PartialRow): void {
  const ranges = stores.partials.ranges(row.id);
  stores.partials.discard(row.id);
  const { jobId, remotePath, remoteSize, remoteMtimeMs, stagingPath, remoteRaw } = row;
  const fresh = stores.partials.create({ jobId, remotePath, remoteSize, remoteMtimeMs, stagingPath, remoteRaw }, ranges.map(({ idx, startByte, endByte }) => ({ idx, startByte, endByte })));
  stores.partials.checkpoint(fresh.id, ranges.map(({ idx, durableBytes }) => ({ idx, durableBytes })));
}

type Group = { jobId: number; unitKey: string; rows: PartialRow[] };

function commitGroup(deps: RecoveryDeps, g: Group): number {
  const { stores } = deps;
  const files = g.rows.map((r) => ({ remotePath: r.remotePath, size: r.remoteSize, mtimeMs: r.remoteMtimeMs, ...(r.remoteRaw ? { remoteRaw: r.remoteRaw } : {}) }));
  const job = stores.jobs.get(g.jobId);
  const afterSync = job?.afterSync ?? "keep";
  const delay = afterSync === "delete_after_days" ? (job?.afterDays ?? 0) * 86_400_000 : 0;
  const at = (deps.now ?? Date.now)() + delay;
  stores.ledger.commitUnit(g.jobId, g.unitKey, 0, files, afterSync === "keep" ? "none" : "pending", afterSync === "keep" ? null : at);
  stores.activity.record({ category: "recovery", jobId: g.jobId, summary: `Recovered interrupted promote of ${g.unitKey} (${files.length} files)` });
  return files.length;
}

/**
 * Boot recovery (plan section 6), per file. A unit is committed to the ledger only when EVERY one of its
 * promoting files is promoted (the commit also deletes their partials). Otherwise promoted files keep their
 * partial (the next run sees staging gone and the final file in place, so it does not download them again),
 * staged files keep theirs (the next run re-verifies and promotes without downloading), and only files whose
 * bytes are gone are forgotten. Committed rows carry no hash; after_sync other than keep leaves the remote
 * action `pending` so maintenance retries it. The ledger row's run_id is 0.
 */
export async function recoverPromoting(deps: RecoveryDeps): Promise<RecoveryResult> {
  const { stores, logger } = deps;
  const result: RecoveryResult = { committedUnits: [], discardedFiles: 0, resumableFiles: 0 };
  for (const g of groupByUnit(stores, stores.partials.listPromoting()).values()) {
    const states = await Promise.all(g.rows.map(stateOf));
    if (states.every((st) => st === "promoted")) {
      commitGroup(deps, g);
      result.committedUnits.push(g.unitKey);
      continue;
    }
    let lost = 0;
    g.rows.forEach((r, i) => {
      if (states[i] === "lost") { stores.partials.discard(r.id); lost++; }
      else if (states[i] === "staged") resetToDownloading(stores, r);
    });
    result.discardedFiles += lost;
    result.resumableFiles += g.rows.length - lost;
    stores.activity.record({
      category: "recovery", severity: "warn", jobId: g.jobId,
      summary: `Interrupted promote of ${g.unitKey} was incomplete; ${g.rows.length - lost} files resume without downloading, ${lost} will be downloaded again`,
    });
  }
  logger.info(result, "recovered promoting partials");
  return result;
}
