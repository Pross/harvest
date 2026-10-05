import type { PlannedUnit } from "./types.js";

/** Adds (or replaces) one run's reservation, returning a new map. Pure: the caller owns the state. */
export function reserveSpace<K>(reservations: ReadonlyMap<K, number>, runId: K, bytes: number): Map<K, number> {
  const next = new Map(reservations);
  next.set(runId, bytes);
  return next;
}

export function releaseSpace<K>(reservations: ReadonlyMap<K, number>, runId: K): Map<K, number> {
  const next = new Map(reservations);
  next.delete(runId);
  return next;
}

export function totalReserved(reservations: ReadonlyMap<unknown, number>): number {
  let sum = 0;
  for (const v of reservations.values()) sum += v;
  return sum;
}

/**
 * Keeps as many WHOLE units as fit in freeBytes - reservedBytes - minFreeBytes, preferring smaller
 * units. Never splits a unit. `kept` and `dropped` preserve the input order.
 */
export function trimToFit(
  units: readonly PlannedUnit[],
  freeBytes: number,
  reservedBytes: number,
  minFreeBytes: number | null,
): { kept: PlannedUnit[]; dropped: PlannedUnit[] } {
  let budget = freeBytes - reservedBytes - (minFreeBytes ?? 0);
  const bySize = [...units].sort((a, b) => a.totalBytes - b.totalBytes || (a.key < b.key ? -1 : 1));
  const keptSet = new Set<PlannedUnit>();
  for (const u of bySize) {
    if (u.totalBytes > budget) break;
    budget -= u.totalBytes;
    keptSet.add(u);
  }
  return {
    kept: units.filter((u) => keptSet.has(u)),
    dropped: units.filter((u) => !keptSet.has(u)),
  };
}
