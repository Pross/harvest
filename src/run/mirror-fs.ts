import { promises as fsp } from "node:fs";
import path from "node:path";
import type { RemoteEntry } from "../engine/types.js";
import type { LedgerEntry } from "../planner/types.js";
import { assertContained, assertRealContained, finalPathFor } from "./paths.js";

const STAT_BATCH = 32;

export type SweepOutcome = {
  /** Files unlinked. */
  deleted: string[];
  /** Ledger files that were already gone locally. */
  gone: string[];
  /** Files left alone, with the reason (changed locally, not a regular file, error). */
  kept: { path: string; reason: string }[];
};

const code = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

/** NFC paths of the files in a remote listing: the form ledger keys use. */
export function listedKeys(listing: readonly RemoteEntry[]): Set<string> {
  return new Set(listing.filter((e) => !e.isDir).map((e) => e.path.normalize("NFC")));
}

async function localMissing(localPath: string, remotePath: string): Promise<boolean> {
  try {
    const final = finalPathFor(localPath, remotePath);
    assertContained(localPath, final);
    await fsp.lstat(final);
    return false;
  } catch (err) {
    return code(err) === "ENOENT";
  }
}

/**
 * Ledger files that are still listed remotely but whose local copy is gone. Mirror mode downloads them again.
 * Any error other than "not found" (permissions, a bad path) counts as present: never re-download on doubt.
 */
export async function findMissingLocal(localPath: string, ledger: ReadonlyMap<string, LedgerEntry>, listing: readonly RemoteEntry[]): Promise<Set<string>> {
  const listed = listedKeys(listing);
  const candidates = [...ledger.keys()].filter((p) => listed.has(p));
  const missing = new Set<string>();
  for (let i = 0; i < candidates.length; i += STAT_BATCH) {
    const batch = candidates.slice(i, i + STAT_BATCH);
    const flags = await Promise.all(batch.map((p) => localMissing(localPath, p)));
    batch.forEach((p, k) => flags[k] && missing.add(p));
  }
  return missing;
}

/** Removes empty directories from `dir` upward, stopping at (and never removing) the job's local root. */
async function pruneEmptyParents(root: string, dir: string): Promise<void> {
  for (let cur = dir; cur !== root && cur.startsWith(root + path.sep); cur = path.dirname(cur)) {
    try {
      await fsp.rmdir(cur);
    } catch {
      return;
    }
  }
}

type Verdict = { kind: "deleted" } | { kind: "gone" } | { kind: "kept"; reason: string };

/** Deletes one file Harvest placed, after proving it is still that file: inside the root, a regular file, same size as recorded. */
async function sweepOne(localPath: string, entry: LedgerEntry): Promise<Verdict> {
  const final = finalPathFor(localPath, entry.remotePath);
  assertContained(localPath, final);
  await assertRealContained(localPath, final);
  const st = await fsp.lstat(final).catch((err: unknown) => (code(err) === "ENOENT" ? null : Promise.reject(err)));
  if (st === null) return { kind: "gone" };
  if (!st.isFile()) return { kind: "kept", reason: "not a regular file" };
  if (st.size !== entry.size) return { kind: "kept", reason: `size ${st.size} differs from the ${entry.size} bytes Harvest placed, so it was changed locally` };
  await fsp.unlink(final);
  await pruneEmptyParents(path.resolve(localPath), path.dirname(final));
  return { kind: "deleted" };
}

/**
 * Deletes the given ledger files from disk one at a time. A file that cannot be deleted never stops the sweep.
 * `forget` is called for files that are deleted, already gone, or no longer ours (changed locally), so the ledger stops tracking them.
 */
export async function sweepLocal(localPath: string, deletes: readonly LedgerEntry[], forget: (remotePath: string) => void, signal?: AbortSignal): Promise<SweepOutcome> {
  const out: SweepOutcome = { deleted: [], gone: [], kept: [] };
  for (const entry of deletes) {
    if (signal?.aborted) break;
    try {
      const v = await sweepOne(localPath, entry);
      if (v.kind === "kept") out.kept.push({ path: entry.remotePath, reason: v.reason });
      else (v.kind === "deleted" ? out.deleted : out.gone).push(entry.remotePath);
      if (v.kind !== "kept" || v.reason.includes("changed locally")) forget(entry.remotePath);
    } catch (err) {
      out.kept.push({ path: entry.remotePath, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
