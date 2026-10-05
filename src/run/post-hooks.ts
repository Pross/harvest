import path from "node:path";
import type { PlannedUnit } from "../planner/types.js";
import { finalOfExtra, NO_EXTRAS, type UnitExtras } from "./finalize-extras.js";
import { stagingPathFor, stagingRoot } from "./paths.js";
import type { RunCtx, StagedFile } from "./transfer-unit.js";
import { isInside } from "../post/extract-fs.js";

/** Directory the unit's files live in inside staging: the unit directory, or the parent of a single-file unit. */
function unitDirOf(ctx: RunCtx, unit: PlannedUnit, staged: StagedFile[]): string {
  const dirUnit = ctx.job.unitMode === "top_dir" && staged.every((s) => s.file.remotePath.startsWith(`${unit.key}/`));
  return dirUnit ? stagingPathFor(ctx.job.localPath, ctx.job.id, unit.key) : path.dirname(staged[0]!.staging);
}

/** A post step is a boundary: whatever it throws (except a run abort) becomes a warning. */
async function guarded<T>(ctx: RunCtx, what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.postWarn(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Runs the extract step after every file of the unit is verified and before promote. Returned paths are checked here:
 * added files must sit inside the job's staging root, removed ones must be staged files of this unit.
 */
export async function extractUnit(ctx: RunCtx, unit: PlannedUnit, staged: StagedFile[]): Promise<UnitExtras> {
  const { post } = ctx.deps;
  const files = staged.filter((s) => !s.promoted).map((s) => s.staging);
  if (!post || files.length === 0) return NO_EXTRAS;
  const unitDir = unitDirOf(ctx, unit, staged);
  const res = await guarded(ctx, "extraction", () => post.extractInStaging({ job: ctx.job, runId: ctx.runId, signal: ctx.signal, unitDir, files }));
  if (!res) return { ...NO_EXTRAS, holdRemote: "extraction failed" };
  res.warnings.forEach((w) => ctx.postWarn(w));
  const root = stagingRoot(ctx.job.localPath, ctx.job.id);
  const added = res.added.filter((p) => isInside(root, p) && path.resolve(p) !== path.resolve(root));
  const dropped = res.removed.filter((p) => files.includes(p));
  if (added.length > 0) ctx.note("extract", "info", `Extracted ${added.length} file(s) in ${unit.key}`, { unit: unit.key, dropped: dropped.length });
  const holdRemote = res.warnings.length > 0 ? "extraction reported a warning (the archives are still on the remote)" : undefined;
  return holdRemote === undefined ? { added, dropped } : { added, dropped, holdRemote };
}

/** After the ledger commit: chmod, *arr. `finalPaths` are the promoted local files (dropped archives excluded, extracted files included). */
export async function afterPromoteUnit(ctx: RunCtx, unit: PlannedUnit, staged: StagedFile[], extras: UnitExtras): Promise<void> {
  const { post } = ctx.deps;
  if (!post) return;
  const finalPaths = [...staged.filter((s) => !extras.dropped.includes(s.staging)).map((s) => s.final), ...extras.added.map((p) => finalOfExtra(ctx, p))];
  const res = await guarded(ctx, "post-promote actions", () => post.afterPromote({ job: ctx.job, runId: ctx.runId, signal: ctx.signal, unitKey: unit.key, finalPaths }));
  res?.warnings.forEach((w) => ctx.postWarn(w));
}
