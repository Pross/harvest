import { DEFAULT_EXCLUDES } from "../../src/domain.js";
import type { JobConfig } from "../../src/domain.js";
import type { RemoteEntry } from "../../src/engine/types.js";
import type { LedgerEntry, Observation, PlannerInput } from "../../src/planner/types.js";

export const NOW = 1_000_000_000_000;
export const OLD = NOW - 86_400_000;

export function job(over: Partial<JobConfig> = {}): JobConfig {
  return {
    id: 1, name: "j", hostId: 1, enabled: true, remotePath: "/remote", localPath: "/data/local",
    mode: "copy_new", unitMode: "top_dir", afterSync: "keep", afterDays: null, moveTo: null,
    verify: "size", settleSeconds: 60, minAgeSeconds: 0, minSize: null, maxSize: null,
    includeGlobs: [], excludeGlobs: [...DEFAULT_EXCLUDES], trustMtime: false, rerunPending: false,
    bwlimitBps: null, parallelFiles: 2, rangeStreams: 4, retries: 3, minFreeBytes: null,
    scheduleKind: "manual", scheduleExpr: null, changedPolicy: "skip", mirrorArmedAt: null, mirrorAllowLargeAt: null, ...over,
  };
}

export function file(path: string, size = 100, mtimeMs: number | null = OLD): RemoteEntry {
  return { path, size, mtimeMs, isDir: false };
}

export function dir(path: string): RemoteEntry {
  return { path, size: 0, mtimeMs: null, isDir: true };
}

export function input(listing: RemoteEntry[], over: Partial<PlannerInput> = {}): PlannerInput {
  return {
    job: job(), listing, ledger: new Map(), observations: new Map(), completedUnits: new Set(), now: NOW, ...over,
  };
}

export function obsMap(list: Observation[]): Map<string, Observation> {
  return new Map(list.map((o) => [o.remotePath, o]));
}

/** An observation of a file that has been stable since `changedAgo` ms ago. */
export function seenObs(e: RemoteEntry, changedAgo = 120_000): Observation {
  return {
    remotePath: e.path, size: e.size, mtimeMs: e.mtimeMs,
    firstSeenAt: NOW - changedAgo, lastChangedAt: NOW - changedAgo, lastSeenAt: NOW - 1000,
  };
}

export function ledgerMap(list: LedgerEntry[]): Map<string, LedgerEntry> {
  return new Map(list.map((l) => [l.remotePath, l]));
}
