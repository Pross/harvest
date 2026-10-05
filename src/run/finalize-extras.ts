import { promises as fsp } from "node:fs";
import path from "node:path";
import { readJournal, updateJournal } from "./extras-journal.js";
import { place } from "./finalize-place.js";
import { assertContained, assertRealContained, finalPathFor, stagingRoot } from "./paths.js";
import type { RunCtx } from "./transfer-unit.js";

/**
 * Files the extract step added to staging (promoted without a ledger row) and archive files it dropped (never promoted, deleted
 * after the ledger commit). All absolute staging paths. `holdRemote` is set when extraction failed or was skipped with a warning:
 * the unit's remote after_sync action must then not run.
 */
export type UnitExtras = { added: string[]; dropped: string[]; holdRemote?: string };
export const NO_EXTRAS: UnitExtras = { added: [], dropped: [] };

export const relToStaging = (ctx: RunCtx, p: string): string => path.relative(stagingRoot(ctx.job.localPath, ctx.job.id), p).split(path.sep).join("/");

/** Final path of an extracted staging file (containment-checked). */
export function finalOfExtra(ctx: RunCtx, stagingFile: string): string {
  const { job } = ctx;
  assertContained(stagingRoot(job.localPath, job.id), stagingFile);
  const final = finalPathFor(job.localPath, relToStaging(ctx, stagingFile));
  assertContained(job.localPath, final);
  return final;
}

const rootOf = (ctx: RunCtx): string => stagingRoot(ctx.job.localPath, ctx.job.id);

/**
 * Places extracted files. Before the first rename the planned (final path, size) pairs are journaled durably; a same-size
 * file already at a final path is replaced only when an EARLIER journal (an interrupted promote of this unit) lists it,
 * otherwise it is moved aside with a warning like any regular file.
 */
export async function placeExtras(ctx: RunCtx, files: string[], synced: Set<string>): Promise<void> {
  if (files.length === 0) return;
  const prior = await readJournal(rootOf(ctx));
  const plan: { staging: string; final: string; size: number }[] = [];
  for (const staging of files) {
    const final = finalOfExtra(ctx, staging);
    await assertRealContained(ctx.job.localPath, final);
    plan.push({ staging, final, size: (await fsp.lstat(staging)).size });
  }
  await updateJournal(rootOf(ctx), Object.fromEntries(plan.map((p) => [p.final, p.size])));
  await ctx.deps.hooks?.afterJournal?.();
  for (const p of plan) await place(ctx, { ...p, replaceable: prior[p.final] === p.size }, relToStaging(ctx, p.staging), synced);
}

/** After the ledger commit the extras are no longer in doubt: drop them from the journal. A failure only leaves stale entries. */
export async function clearExtras(ctx: RunCtx, extras: UnitExtras): Promise<void> {
  if (extras.added.length === 0) return;
  try {
    await updateJournal(rootOf(ctx), {}, extras.added.map((p) => finalOfExtra(ctx, p)));
  } catch (err) {
    ctx.note("extract", "warn", `could not update the extracted-files journal: ${err instanceof Error ? err.message : String(err)}`);
  }
}
