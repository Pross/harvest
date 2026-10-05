import { PermanentError } from "../errors.js";
import type { JobConfig } from "../domain.js";
import { isInProgress, makeFileFilter } from "./filters.js";
import { sanitizeRemotePath } from "./paths.js";
import { evaluateFile, updateObservation } from "./settle.js";
import { byKey, byPath, groupByUnit, unitKeyFor } from "./units.js";
import type { Plan, PlannedFile, PlannedUnit, PlannerInput, SkippedEntry, SkipReason } from "./types.js";

export { unitKeyFor } from "./units.js";
export { sanitizeRemotePath } from "./paths.js";
export { reserveSpace, trimToFit } from "./space.js";

const FOLLOWUP_REASONS: ReadonlySet<SkipReason> = new Set(["first_sighting", "unsettled", "too_young"]);

/** Step 1: drop directories, reject unsafe or duplicate paths, normalize to NFC. */
function sanitizeListing(input: PlannerInput, skipped: SkippedEntry[]): PlannedFile[] {
  const seen = new Map<string, PlannedFile>();
  for (const e of input.listing) {
    if (e.isDir) continue;
    const res = sanitizeRemotePath(e.path, input.job.localPath);
    if (!res.ok) {
      skipped.push({ remotePath: e.path, reason: "unsafe_path", detail: res.detail });
    } else if (seen.has(res.path)) {
      skipped.push({ remotePath: res.path, reason: "unsafe_path", detail: "duplicate path after NFC normalization" });
    } else {
      seen.set(res.path, { remotePath: res.path, size: e.size, mtimeMs: e.mtimeMs, ...(e.path !== res.path ? { remoteRaw: e.path } : {}) });
    }
  }
  return [...seen.values()].sort(byPath);
}

/** Step 3: a marker inside a unit holds the whole unit. Runs before any filtering. */
function applyMarkers(files: PlannedFile[], job: JobConfig, skipped: SkippedEntry[]): PlannedFile[] {
  const held = new Set<string>();
  for (const f of files) if (isInProgress(f.remotePath)) held.add(unitKeyFor(f.remotePath, job.unitMode));
  const rest: PlannedFile[] = [];
  for (const f of files) {
    if (isInProgress(f.remotePath)) skipped.push({ remotePath: f.remotePath, reason: "in_progress_marker" });
    else if (held.has(unitKeyFor(f.remotePath, job.unitMode))) skipped.push({ remotePath: f.remotePath, reason: "unit_held" });
    else rest.push(f);
  }
  return rest;
}

function applyFilters(files: PlannedFile[], job: JobConfig, skipped: SkippedEntry[]): PlannedFile[] {
  const filter = makeFileFilter(job);
  return files.filter((f) => {
    const v = filter(f);
    if (v) skipped.push({ remotePath: f.remotePath, ...v });
    return v === null;
  });
}

function applyLedger(files: PlannedFile[], input: PlannerInput, skipped: SkippedEntry[]): PlannedFile[] {
  return files.filter((f) => {
    const row = input.ledger.get(f.remotePath);
    if (!row) return true;
    if (input.job.changedPolicy === "resync" && row.size !== f.size) return true;
    skipped.push({ remotePath: f.remotePath, reason: "already_synced" });
    return false;
  });
}

/** Steps 5-6: every file of a unit must be settled and old enough, or the whole unit is skipped. */
function buildUnits(files: PlannedFile[], input: PlannerInput, obs: Map<string, ReturnType<typeof updateObservation>>, skipped: SkippedEntry[], warnings: string[]): PlannedUnit[] {
  const units: PlannedUnit[] = [];
  for (const [key, group] of groupByUnit(files, input.job.unitMode)) {
    const verdicts = group.map((f) => {
      const v = evaluateFile(input.job, !input.observations.has(f.remotePath), obs.get(f.remotePath)!, input.now);
      if (v.warning) warnings.push(v.warning);
      return v.reason;
    });
    if (verdicts.every((r) => r === null)) {
      const sorted = [...group].sort(byPath);
      const totalBytes = sorted.reduce((n, f) => n + f.size, 0);
      units.push({ key, files: sorted, totalBytes, existing: input.completedUnits.has(key) });
      continue;
    }
    group.forEach((f, i) => skipped.push({ remotePath: f.remotePath, reason: verdicts[i] ?? "unit_held" }));
  }
  return units.sort(byKey);
}

/** The pure planner: listing + ledger + observations + rules -> units, skips, observation upserts. */
export function planRun(input: PlannerInput): Plan {
  const { job, now } = input;
  if (job.mode === "mirror") throw new PermanentError("mirror mode is not implemented in phase 1");
  const skipped: SkippedEntry[] = [];
  const warnings: string[] = [];
  const sane = sanitizeListing(input, skipped);
  const obs = new Map(sane.map((f) => [f.remotePath, updateObservation(input.observations.get(f.remotePath), f, now)]));
  const candidates = applyLedger(applyFilters(applyMarkers(sane, job, skipped), job, skipped), input, skipped);
  const units = buildUnits(candidates, input, obs, skipped, warnings);
  const listed = new Set(input.listing.flatMap((e) => [e.path, e.path.normalize("NFC")]));
  const wait = skipped.some((s) => FOLLOWUP_REASONS.has(s.reason));
  return {
    units,
    skipped: skipped.sort(byPath),
    observations: [...obs.values()].sort(byPath),
    vanished: [...input.observations.keys()].filter((p) => !listed.has(p)).sort(),
    followupAt: wait ? now + job.settleSeconds * 1000 : null,
    warnings: warnings.sort(),
  };
}
