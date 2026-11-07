import type { RemoteEntry } from "../engine/types.js";
import type { LedgerEntry } from "./types.js";

/** A sweep never deletes more than this share of a job's ledger in one run (and always allows up to MIN_GUARDED files). */
export const MAX_DELETE_FRACTION = 0.5;
export const MIN_GUARDED = 10;

export type MirrorPlan = {
  /** Ledger rows missing from this listing AND from an earlier run's listing: the only local files a mirror run may delete. */
  deletes: LedgerEntry[];
  /** Missing from this listing for the first time: marked now, deleted by a later run if still missing. */
  newlyMissing: string[];
  /** Listed again after an earlier missing mark: the mark is cleared. */
  reappeared: string[];
  /** Set when the sweep must not run at all; `deletes` is then empty. Shown to the user. */
  refused: string | null;
};

/** Both spellings of every listed file, so an NFD name on the server still matches its NFC ledger key. */
function listedFiles(listing: readonly RemoteEntry[]): Set<string> {
  const out = new Set<string>();
  for (const e of listing) {
    if (e.isDir) continue;
    out.add(e.path);
    out.add(e.path.normalize("NFC"));
  }
  return out;
}

/**
 * Pure: which ledger files vanished from the remote. A listing that looks wrong (empty, or missing most of what was
 * synced, as when the remote path was repointed or the server returned a truncated tree) refuses the whole sweep
 * instead of deleting, unless the user explicitly allowed one large delete. Even a plausible listing only deletes files that
 * an earlier run also saw missing, so one truncated listing never deletes anything (and cannot erode the ledger run by run). Only ledger rows are candidates, so files Harvest did not place are never touched.
 */
export function planMirrorDeletes(listing: readonly RemoteEntry[], ledger: ReadonlyMap<string, LedgerEntry>, allowLarge: boolean, runId: number): MirrorPlan {
  const none = { deletes: [], newlyMissing: [], reappeared: [] };
  if (ledger.size === 0) return { ...none, refused: null };
  const listed = listedFiles(listing);
  if (listed.size === 0 && !allowLarge) {
    return { ...none, refused: `The remote listing is empty but the ledger holds ${ledger.size} file(s); refusing to delete anything. If the remote really is empty, allow one large delete on the job page` };
  }
  const gone = [...ledger.values()].filter((l) => !listed.has(l.remotePath)).sort((a, b) => (a.remotePath < b.remotePath ? -1 : 1));
  const reappeared = [...ledger.values()].filter((l) => listed.has(l.remotePath) && l.missingRunId != null).map((l) => l.remotePath);
  if (!allowLarge && gone.length > MIN_GUARDED && gone.length > ledger.size * MAX_DELETE_FRACTION) {
    return {
      ...none,
      refused: `${gone.length} of ${ledger.size} synced files are missing from the remote (more than ${Math.round(MAX_DELETE_FRACTION * 100)}%); refusing to delete. Check the remote path; if they really were removed, allow one large delete on the job page`,
    };
  }
  // An explicit one-shot allowance is the user's own confirmation; otherwise a file must have been missing in an earlier run too.
  const confirmed = (l: LedgerEntry): boolean => allowLarge || (l.missingRunId != null && l.missingRunId !== runId);
  return { deletes: gone.filter(confirmed), newlyMissing: gone.filter((l) => l.missingRunId == null).map((l) => l.remotePath), reappeared, refused: null };
}
