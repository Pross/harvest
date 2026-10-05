import path from "node:path";
import type { RemoteEntry } from "../engine/types.js";
import { moveToFreeName } from "./remote-move.js";
import { remoteAbsOf } from "./paths.js";
import type { RunCtx, StagedFile } from "./transfer-unit.js";

const DAY_MS = 86_400_000;

/** Size and mtime still equal the guard recorded when the partial was created (null mtime: size only). */
export function matchesGuard(remote: RemoteEntry | null, sf: StagedFile): boolean {
  if (remote === null || remote.size !== sf.partial.remoteSize) return false;
  return sf.partial.remoteMtimeMs === null || remote.mtimeMs === sf.partial.remoteMtimeMs;
}

const remoteOf = (ctx: RunCtx, sf: StagedFile): string => remoteAbsOf(ctx.job.remotePath, sf.file);

export async function statWithSlot(ctx: RunCtx, sf: StagedFile): Promise<RemoteEntry | null> {
  const release = await ctx.slots.acquireOne(ctx.signal);
  try {
    return await ctx.session.stat(remoteOf(ctx, sf));
  } finally {
    release();
  }
}

async function deleteRemote(ctx: RunCtx, sf: StagedFile): Promise<void> {
  const { ledger } = ctx.deps.stores;
  const p = sf.file.remotePath;
  try {
    if (!matchesGuard(await statWithSlot(ctx, sf), sf)) {
      ctx.note("remote-action", "warn", `${p} changed after sync; remote copy kept`, { path: p });
      return;
    }
    const release = await ctx.slots.acquireOne(ctx.signal);
    try {
      await ctx.session.remove(remoteOf(ctx, sf));
    } finally {
      release();
    }
    ledger.markRemoteAction(ctx.job.id, p, "done", ctx.now());
  } catch (err) {
    ledger.markRemoteAction(ctx.job.id, p, "failed", ctx.now());
    ctx.note("remote-action", "warn", `remote delete failed for ${p}: ${err instanceof Error ? err.message : String(err)}`, { path: p });
  }
}

async function moveRemote(ctx: RunCtx, sf: StagedFile): Promise<void> {
  const { ledger } = ctx.deps.stores;
  const { job } = ctx;
  const p = sf.file.remotePath;
  try {
    if (!matchesGuard(await statWithSlot(ctx, sf), sf)) {
      ctx.note("remote-action", "warn", `${p} changed after sync; remote copy left in place`, { path: p });
      return;
    }
    if (!job.moveTo) throw new Error("job is set to move files but has no move target");
    const release = await ctx.slots.acquireOne(ctx.signal);
    try {
      await moveToFreeName(ctx.session, remoteOf(ctx, sf), path.posix.join(job.moveTo, p));
    } finally {
      release();
    }
    ledger.markRemoteAction(job.id, p, "done", ctx.now());
  } catch (err) {
    ledger.markRemoteAction(job.id, p, "failed", ctx.now());
    ctx.note("remote-action", "warn", `remote move failed for ${p}: ${err instanceof Error ? err.message : String(err)}`, { path: p });
  }
}

/**
 * The ledger row is committed `pending` for every acting mode so a crash between the commit and the remote action is
 * retried by maintenance: delete_after_days waits `afterDays`; delete and move are due at once and flip to `done` after success.
 * When `hold` is set (extraction failed or was skipped) nothing is scheduled: the remote copy stays and the row says `none`.
 */
export function pendingAt(ctx: RunCtx, hold: string | undefined): { action: "none" | "pending"; at: number | null } {
  const { afterSync, afterDays } = ctx.job;
  if (hold !== undefined) return { action: "none", at: null };
  if (afterSync === "delete_after_days") return { action: "pending", at: ctx.now() + (afterDays ?? 0) * DAY_MS };
  if (afterSync === "move" || afterSync === "delete") return { action: "pending", at: ctx.now() };
  return { action: "none", at: null };
}

/**
 * Step 5. `delete` and `move` act now; `delete_after_days` is left `pending` for the maintenance task. With `hold` the action is
 * skipped and an activity warning says why. Empty remote parent directories are NOT removed: `session.remove` is a file delete
 * and removing directories safely needs an engine call the contract lacks.
 */
export async function applyAfterSync(ctx: RunCtx, staged: StagedFile[], unitKey: string, hold: string | undefined): Promise<void> {
  const mode = ctx.job.afterSync;
  if (mode === "keep") return;
  if (hold !== undefined) {
    ctx.note("remote-action", "warn", `Remote after-sync action (${mode}) skipped for ${unitKey}: ${hold}. The remote files are kept.`, { unit: unitKey });
    return;
  }
  if (mode === "delete") for (const sf of staged) await deleteRemote(ctx, sf);
  else if (mode === "move") for (const sf of staged) await moveRemote(ctx, sf);
}
