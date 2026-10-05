import { promises as fsp } from "node:fs";
import path from "node:path";
import { RemoteChanged } from "../errors.js";
import type { PlannedUnit } from "../planner/types.js";
import { clearExtras, NO_EXTRAS, placeExtras, relToStaging, type UnitExtras } from "./finalize-extras.js";
import { exists, fsyncPath, mkdirpTracked, place } from "./finalize-place.js";
import { applyAfterSync, matchesGuard, pendingAt, statWithSlot } from "./finalize-remote.js";
import { assertRealContained, finalPathFor, stagingPathFor } from "./paths.js";
import type { RunCtx, StagedFile } from "./transfer-unit.js";

export { finalOfExtra, NO_EXTRAS, type UnitExtras } from "./finalize-extras.js";

/** Step 1: any change discards that file's partial and staged bytes; the unit is then not promoted. */
async function recheckRemote(ctx: RunCtx, staged: StagedFile[]): Promise<Map<string, string>> {
  const changed = new Map<string, string>();
  for (const sf of staged) {
    if (sf.promoted || matchesGuard(await statWithSlot(ctx, sf), sf)) continue;
    ctx.deps.stores.partials.discard(sf.partial.id);
    await fsp.rm(sf.staging, { force: true });
    changed.set(sf.file.remotePath, new RemoteChanged(`remote file changed during transfer: ${sf.file.remotePath}`).message);
  }
  return changed;
}

async function listFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)));
    else out.push(r);
  }
  return out;
}

/** A whole-dir rename is only safe when the staged dir holds exactly this unit's files plus the extracted ones (no stale leftovers, no dropped archives). */
async function canRenameDir(ctx: RunCtx, unit: PlannedUnit, staged: StagedFile[], extras: UnitExtras): Promise<boolean> {
  const { job } = ctx;
  if (job.unitMode !== "top_dir" || extras.dropped.length > 0 || !staged.every((s) => s.file.remotePath.startsWith(`${unit.key}/`))) return false;
  if (await exists(finalPathFor(job.localPath, unit.key))) return false;
  const have = (await listFiles(stagingPathFor(job.localPath, job.id, unit.key))).map((r) => `${unit.key}/${r}`).sort();
  const want = [...staged.map((s) => s.file.remotePath), ...extras.added.map((p) => relToStaging(ctx, p))].sort();
  return JSON.stringify(have) === JSON.stringify(want);
}

async function moveOne(ctx: RunCtx, sf: StagedFile, forgotten: ReadonlySet<string>, synced: Set<string>): Promise<void> {
  if (sf.promoted) return;
  const replaceable = sf.wasPromoting || forgotten.has(sf.file.remotePath);
  await place(ctx, { staging: sf.staging, final: sf.final, size: sf.file.size, replaceable }, sf.file.remotePath, synced);
}

/** Whole-directory rename: the staged unit directory becomes the final one. */
async function renameDir(ctx: RunCtx, unit: PlannedUnit, synced: Set<string>): Promise<void> {
  const { job } = ctx;
  const finalDir = finalPathFor(job.localPath, unit.key);
  const stagingDir = stagingPathFor(job.localPath, job.id, unit.key);
  await assertRealContained(job.localPath, finalDir);
  for (const d of await mkdirpTracked(path.dirname(finalDir))) synced.add(d);
  await fsp.rename(stagingDir, finalDir);
  synced.add(path.dirname(finalDir));
  synced.add(path.dirname(stagingDir));
}

/**
 * Extracted files are placed BEFORE the staged files: a crash then leaves the archive (and its partial row) in staging, so boot
 * recovery resumes the unit and re-extraction is idempotent (the extras journal proves the earlier placements are ours).
 */
async function placeFiles(ctx: RunCtx, staged: StagedFile[], extras: UnitExtras, synced: Set<string>): Promise<void> {
  const keep = staged.filter((sf) => !extras.dropped.includes(sf.staging));
  for (const sf of keep) if (!sf.promoted) await assertRealContained(ctx.job.localPath, sf.final);
  await placeExtras(ctx, extras.added, synced);
  await ctx.deps.hooks?.afterExtras?.();
  const forgotten = ctx.deps.stores.ledger.forgottenPaths(ctx.job.id);
  for (const sf of keep) await moveOne(ctx, sf, forgotten, synced);
}

/** Step 3: promote, then fsync every directory whose entries changed. */
async function promote(ctx: RunCtx, unit: PlannedUnit, staged: StagedFile[], extras: UnitExtras): Promise<void> {
  const synced = new Set<string>();
  if (await canRenameDir(ctx, unit, staged, extras)) await renameDir(ctx, unit, synced);
  else await placeFiles(ctx, staged, extras, synced);
  for (const dir of synced) await fsyncPath(dir);
}

/** Archives the extract step consumed are deleted only after the ledger row exists; a leftover after a crash here is cleaned by staging maintenance. */
async function dropArchives(ctx: RunCtx, extras: UnitExtras): Promise<void> {
  for (const p of extras.dropped) {
    try {
      await fsp.rm(p, { force: true });
    } catch (err) {
      ctx.note("extract", "warn", `could not delete extracted archive ${path.basename(p)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Crash-safe finalize in the order of plan section 6. Returns the files that failed the remote re-check. */
export async function finalizeUnit(ctx: RunCtx, unit: PlannedUnit, staged: StagedFile[], extras: UnitExtras = NO_EXTRAS): Promise<Map<string, string>> {
  const { stores, hooks } = { stores: ctx.deps.stores, hooks: ctx.deps.hooks };
  const changed = await recheckRemote(ctx, staged);
  if (changed.size > 0) return changed;
  for (const sf of staged) {
    if (sf.promoted) continue;
    await fsyncPath(sf.staging);
    stores.partials.setPromoting(sf.partial.id, sf.final);
  }
  await promote(ctx, unit, staged, extras);
  await hooks?.afterRename?.();
  const files = staged.map((s) => (s.hash ? { ...s.file, hash: s.hash } : s.file));
  const { action, at } = pendingAt(ctx, extras.holdRemote);
  stores.ledger.commitUnit(ctx.job.id, unit.key, ctx.runId, files, action, at);
  await clearExtras(ctx, extras);
  await dropArchives(ctx, extras);
  await applyAfterSync(ctx, staged, unit.key, extras.holdRemote);
  return changed;
}
