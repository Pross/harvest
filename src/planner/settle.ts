import type { JobConfig } from "../domain.js";
import type { Observation, PlannedFile, SkipReason } from "./types.js";

/** Applies one sighting to the persisted observation (or starts a new one). */
export function updateObservation(prev: Observation | undefined, f: PlannedFile, now: number): Observation {
  if (!prev) {
    return { remotePath: f.remotePath, size: f.size, mtimeMs: f.mtimeMs, firstSeenAt: now, lastChangedAt: now, lastSeenAt: now };
  }
  const changed = prev.size !== f.size || prev.mtimeMs !== f.mtimeMs;
  return {
    remotePath: f.remotePath,
    size: f.size,
    mtimeMs: f.mtimeMs,
    firstSeenAt: prev.firstSeenAt,
    lastChangedAt: changed ? now : prev.lastChangedAt,
    lastSeenAt: now,
  };
}

export type Eligibility = { reason: SkipReason | null; warning?: string };

function settleReason(job: JobConfig, first: boolean, obs: Observation, now: number): SkipReason | null {
  const settleMs = job.settleSeconds * 1000;
  if (first) {
    const trusted = job.trustMtime && obs.mtimeMs !== null && now - obs.mtimeMs >= settleMs;
    return trusted ? null : "first_sighting";
  }
  return now - obs.lastChangedAt >= settleMs ? null : "unsettled";
}

/**
 * Decides whether one file is settled and old enough. `obs` is the already-updated observation;
 * `first` is true when no observation existed before this call.
 */
export function evaluateFile(job: JobConfig, first: boolean, obs: Observation, now: number): Eligibility {
  const settle = settleReason(job, first, obs, now);
  if (settle) return { reason: settle };
  if (obs.mtimeMs === null) {
    if (job.minAgeSeconds <= 0) return { reason: null };
    return { reason: null, warning: `${obs.remotePath}: remote mtime unknown, min age not enforced` };
  }
  if (now - obs.mtimeMs < job.minAgeSeconds * 1000) return { reason: "too_young" };
  return { reason: null };
}
