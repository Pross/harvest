import { promises as fsp } from "node:fs";
import path from "node:path";
import type { RunCtx } from "./transfer-unit.js";

export async function fsyncPath(p: string): Promise<void> {
  const fh = await fsp.open(p, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export const exists = async (p: string): Promise<boolean> => (await fsp.lstat(p).then(() => true, (e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? false : Promise.reject(e))));

/** `mkdir -p` that reports every directory it made plus the parent that gained an entry (all need an fsync). */
export async function mkdirpTracked(dir: string): Promise<string[]> {
  const first = await fsp.mkdir(dir, { recursive: true });
  if (first === undefined) return [];
  const made = [path.dirname(first)];
  for (let cur = dir; ; cur = path.dirname(cur)) {
    made.push(cur);
    if (cur === first) return made;
  }
}

const isOwnSize = async (p: string, size: number): Promise<boolean | null> =>
  await fsp.lstat(p).then((st) => st.isFile() && st.size === size, (e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));

export type Place = { staging: string; final: string; size: number; replaceable: boolean };

/**
 * Renames a staged file into place. An existing file at `final` is replaced only when `replaceable` (this file's own
 * interrupted promote, a forgotten/resynced file, or an extracted file journaled by an interrupted promote of this unit)
 * AND it has the expected size; anything else is moved aside.
 */
export async function place(ctx: RunCtx, pl: Place, label: string, synced: Set<string>): Promise<void> {
  for (const d of await mkdirpTracked(path.dirname(pl.final))) synced.add(d);
  const sameSize = await isOwnSize(pl.final, pl.size);
  if (sameSize !== null && !(pl.replaceable && sameSize === true)) {
    const conflict = `${pl.final}.harvest-conflict-${ctx.now()}`;
    await fsp.rename(pl.final, conflict);
    ctx.note("conflict", "warn", `existing local file moved aside to ${path.basename(conflict)}`, { path: label });
  }
  await fsp.rename(pl.staging, pl.final);
  synced.add(path.dirname(pl.final));
  synced.add(path.dirname(pl.staging));
}
