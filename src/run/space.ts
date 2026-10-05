import { promises as fsp } from "node:fs";
import path from "node:path";
import { releaseSpace, reserveSpace, totalReserved, trimToFit } from "../planner/space.js";
import type { PlannedUnit } from "../planner/types.js";

export type Statfs = (path: string) => Promise<{ bavail: number; bsize: number }>;

/** Shared in-memory map runId -> planned-remaining bytes, so concurrent runs see each other's claims. */
export interface SpaceReservations {
  set(runId: number, bytes: number): void;
  release(runId: number): void;
  reservedByOthers(runId: number): number;
}

export function createSpaceReservations(): SpaceReservations {
  let map: ReadonlyMap<number, number> = new Map();
  return {
    set: (runId, bytes) => void (map = reserveSpace(map, runId, bytes)),
    release: (runId) => void (map = releaseSpace(map, runId)),
    reservedByOthers: (runId) => totalReserved(releaseSpace(map, runId)),
  };
}

export const defaultStatfs: Statfs = async (p) => {
  const s = await fsp.statfs(p);
  return { bavail: Number(s.bavail), bsize: Number(s.bsize) };
};

/** statfs needs an existing path; a dry run must not create the target, so walk up to an ancestor. */
async function nearestExisting(p: string): Promise<string> {
  for (let cur = path.resolve(p); ; cur = path.dirname(cur)) {
    try {
      await fsp.access(cur);
      return cur;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || cur === path.dirname(cur)) throw err;
    }
  }
}

export type FitInput = {
  units: readonly PlannedUnit[];
  localPath: string;
  minFreeBytes: number | null;
  runId: number;
  reservations: SpaceReservations;
  statfs: Statfs;
};

/** Trims by whole unit against free space minus other runs' reservations, then reserves what is kept. */
export async function fitToSpace(i: FitInput): Promise<{ kept: PlannedUnit[]; dropped: PlannedUnit[] }> {
  const st = await i.statfs(await nearestExisting(i.localPath));
  const fit = trimToFit(i.units, st.bavail * st.bsize, i.reservations.reservedByOthers(i.runId), i.minFreeBytes);
  i.reservations.set(i.runId, fit.kept.reduce((n, u) => n + u.totalBytes, 0));
  return fit;
}

/** Whether one unit still fits right now: fresh statfs minus other runs' reservations minus the job's minimum. */
export async function unitFits(i: { unit: PlannedUnit; localPath: string; minFreeBytes: number | null; runId: number; reservations: SpaceReservations; statfs: Statfs }): Promise<boolean> {
  const st = await i.statfs(await nearestExisting(i.localPath));
  return trimToFit([i.unit], st.bavail * st.bsize, i.reservations.reservedByOthers(i.runId), i.minFreeBytes).dropped.length === 0;
}
