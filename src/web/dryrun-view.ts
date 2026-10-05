import type { JobConfig } from "../domain.js";
import { DRY_NO_SPACE, DRY_PLANNED, DRY_SKIPPED, type DrySummary } from "../run/dry-run.js";
import type { RunFileRow } from "../store/index.js";
import { formatBytes } from "./format.js";

const SKIP_LABELS: Record<string, string> = {
  already_synced: "Already in the ledger (synced earlier)",
  first_sighting: "First sighting: a real run would start its settle clock",
  unsettled: "Still changing (settle check)",
  too_young: "Younger than the minimum age",
  filtered_glob: "Excluded by the include/exclude filters",
  filtered_size: "Outside the size limits",
  in_progress_marker: "In-progress marker (partial upload)",
  unit_held: "Held back with the rest of its unit",
  unsafe_path: "Unsafe remote path",
  [DRY_NO_SPACE]: "Not enough free space",
};
const SHOWN_PLANNED = 500;
const SHOWN_PER_REASON = 100;

type SkipGroup = { reason: string; label: string; count: number; shown: { path: string; detail: string }[] };

function skipGroups(files: RunFileRow[], trueCounts: Record<string, number> | undefined): SkipGroup[] {
  const groups = new Map<string, SkipGroup>();
  for (const f of files) {
    const [reason = "other", ...rest] = (f.error ?? "other").split(": ");
    const g = groups.get(reason) ?? { reason, label: SKIP_LABELS[reason] ?? reason, count: 0, shown: [] };
    g.count++;
    if (g.shown.length < SHOWN_PER_REASON) g.shown.push({ path: f.remotePath, detail: rest.join(": ") });
    groups.set(reason, g);
  }
  for (const [reason, n] of Object.entries(trueCounts ?? {})) {
    const g = groups.get(reason) ?? { reason, label: SKIP_LABELS[reason] ?? reason, count: 0, shown: [] };
    g.count = Math.max(g.count, n);
    groups.set(reason, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function unitGroups(planned: RunFileRow[]) {
  const units = new Map<string, { key: string; total: number; files: { path: string; size: string }[]; count: number }>();
  let shown = 0;
  for (const f of planned) {
    const u = units.get(f.unitKey) ?? { key: f.unitKey, total: 0, files: [], count: 0 };
    u.total += f.size;
    u.count++;
    if (shown < SHOWN_PLANNED) {
      u.files.push({ path: f.remotePath, size: formatBytes(f.size) });
      shown++;
    }
    units.set(f.unitKey, u);
  }
  return [...units.values()].map((u) => ({ ...u, totalText: formatBytes(u.total) }));
}

/** Everything the dry-run partial renders: run_files rows (states planned / would_skip, capped) plus the true totals when recorded. */
export function dryRunView(files: RunFileRow[], job: Pick<JobConfig, "afterSync"> | undefined, summary?: DrySummary) {
  const planned = files.filter((f) => f.state === DRY_PLANNED);
  const deletes = job?.afterSync === "delete";
  const plannedCount = Math.max(planned.length, summary?.plannedFiles ?? 0);
  const bytes = summary?.plannedBytes ?? planned.reduce((n, f) => n + f.size, 0);
  const units = unitGroups(planned);
  return {
    plannedCount, plannedBytes: formatBytes(bytes), units, unitCount: Math.max(units.length, summary?.plannedUnits ?? 0),
    skips: skipGroups(files.filter((f) => f.state === DRY_SKIPPED), summary?.skipCounts), deletes,
    wouldDelete: deletes ? planned.slice(0, SHOWN_PLANNED).map((f) => f.remotePath) : [],
    wouldDeleteCount: deletes ? plannedCount : 0, shownPlanned: Math.min(planned.length, SHOWN_PLANNED),
    hiddenPlanned: Math.max(0, plannedCount - SHOWN_PLANNED),
  };
}
