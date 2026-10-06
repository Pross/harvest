import type { JobConfig } from "../domain.js";
import { PermanentError } from "../errors.js";
import type { RemoteEntry } from "../engine/types.js";
import { planMirrorDeletes } from "../planner/mirror.js";
import type { Stores } from "../store/index.js";
import { DRY_ROW_CAP } from "./dry-run.js";
import { sweepLocal } from "./mirror-fs.js";

/** run_files state of a local file a mirror run would delete (dry runs only). */
export const DRY_DELETE = "would_delete";
/** Activity category of the row holding a mirror dry run's true counts and any refusal. */
export const DRY_MIRROR_CATEGORY = "dry-run-mirror";

export type DryMirrorSummary = { wouldDelete: number; refused: string | null; allowedLarge?: boolean };

/** One-shot permission to delete past the safety limits: valid for a day, then the user has to give it again. */
export const ALLOW_LARGE_TTL_MS = 24 * 3_600_000;
export const largeAllowed = (job: JobConfig, now: number): boolean => job.mirrorAllowLargeAt !== null && now - job.mirrorAllowLargeAt < ALLOW_LARGE_TTL_MS;

export type MirrorCtx = {
  job: JobConfig;
  runId: number;
  stores: Stores;
  listing: readonly RemoteEntry[];
  now: () => number;
  signal: AbortSignal;
  /** Surfaces a problem as an activity entry and makes the run `partial`. */
  warn: (message: string) => void;
  note: (message: string, meta?: unknown) => void;
};

/** Dry run: record what a real run would delete, then arm the job so a real run is allowed (unless it was edited meanwhile). Nothing is touched on disk. */
function dryMirror(ctx: MirrorCtx): void {
  const { stores, job, runId } = ctx;
  const allowed = largeAllowed(job, ctx.now());
  const plan = planMirrorDeletes(ctx.listing, stores.ledger.active(job.id), allowed);
  stores.runs.inTransaction(() => {
    plan.deletes.slice(0, DRY_ROW_CAP).forEach((d) => stores.runs.recordFile({ runId, unitKey: "", remotePath: d.remotePath, size: d.size, state: DRY_DELETE, bytes: 0, attempts: 0 }));
    const meta: DryMirrorSummary = { wouldDelete: plan.deletes.length, refused: plan.refused, ...(allowed ? { allowedLarge: true } : {}) };
    stores.activity.record({ category: DRY_MIRROR_CATEGORY, runId, jobId: job.id, summary: plan.refused ?? `Mirror would delete ${plan.deletes.length} local file(s)`, meta });
  });
  const cur = stores.jobs.get(job.id);
  const unchanged = cur && cur.mode === "mirror" && cur.hostId === job.hostId && cur.remotePath === job.remotePath && cur.localPath === job.localPath;
  if (unchanged) stores.jobs.update(job.id, { mirrorArmedAt: ctx.now() });
}

/** Real run: delete local files whose remote file is gone. Only called when every download this run planned succeeded. */
async function realMirror(ctx: MirrorCtx): Promise<void> {
  const { stores, job } = ctx;
  const allowed = largeAllowed(job, ctx.now());
  const plan = planMirrorDeletes(ctx.listing, stores.ledger.active(job.id), allowed);
  if (allowed) stores.jobs.update(job.id, { mirrorAllowLargeAt: null }); // consumed by this sweep, whatever it finds
  if (plan.refused) return ctx.warn(`Mirror sweep skipped: ${plan.refused}`);
  if (plan.deletes.length === 0) return;
  const out = await sweepLocal(job.localPath, plan.deletes, (p) => stores.ledger.forgetFile(job.id, p), ctx.signal);
  ctx.note(`Mirror removed ${out.deleted.length} local file(s) that left the remote`, { deleted: out.deleted.slice(0, 200), gone: out.gone.length, kept: out.kept.length });
  for (const k of out.kept.slice(0, 20)) ctx.warn(`Mirror kept ${k.path}: ${k.reason}`);
  if (out.kept.length > 20) ctx.warn(`Mirror kept ${out.kept.length - 20} more file(s); see the first 20 above`);
}

/** Entry point from the executor. `downloadsOk` is false when any unit failed or was dropped: then nothing is deleted. */
export async function runMirror(ctx: MirrorCtx, dryRun: boolean, downloadsOk: boolean): Promise<void> {
  if (ctx.job.mode !== "mirror") return;
  if (dryRun) return dryMirror(ctx);
  if (!downloadsOk) return ctx.warn("Mirror sweep skipped: some downloads failed or were dropped, so nothing was deleted this run");
  await realMirror(ctx);
}

/** Refuses a mirror run that could delete data it should not: only after-sync "keep" is safe, and a real run needs an armed job. */
export function assertMirrorAllowed(job: JobConfig, dryRun: boolean): void {
  if (job.mode !== "mirror") return;
  if (job.afterSync !== "keep") {
    throw new PermanentError(`Mirror mode needs "After sync: keep". With "${job.afterSync}" the remote file disappears after syncing and the mirror would delete the local copy`);
  }
  if (!dryRun && job.mirrorArmedAt === null) {
    throw new PermanentError("Mirror mode is not armed: run a dry run and review what it would delete before the first real run");
  }
}
