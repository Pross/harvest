import type { UnitMode } from "../domain.js";
import type { PlannedFile } from "./types.js";

/** top_dir => first path segment (the file itself when it sits at the root); file => the path. */
export function unitKeyFor(remotePath: string, unitMode: UnitMode): string {
  if (unitMode === "file") return remotePath;
  const i = remotePath.indexOf("/");
  return i === -1 ? remotePath : remotePath.slice(0, i);
}

export function groupByUnit(files: readonly PlannedFile[], unitMode: UnitMode): Map<string, PlannedFile[]> {
  const groups = new Map<string, PlannedFile[]>();
  for (const f of files) {
    const key = unitKeyFor(f.remotePath, unitMode);
    const list = groups.get(key);
    if (list) list.push(f);
    else groups.set(key, [f]);
  }
  return groups;
}

export function byPath<T extends { remotePath: string }>(a: T, b: T): number {
  return a.remotePath < b.remotePath ? -1 : a.remotePath > b.remotePath ? 1 : 0;
}

export function byKey<T extends { key: string }>(a: T, b: T): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
