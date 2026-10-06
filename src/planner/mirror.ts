import type { RemoteEntry } from "../engine/types.js";
import type { LedgerEntry } from "./types.js";

/** A sweep never deletes more than this share of a job's ledger in one run (and always allows up to MIN_GUARDED files). */
export const MAX_DELETE_FRACTION = 0.5;
export const MIN_GUARDED = 10;

export type MirrorPlan = {
  /** Ledger rows whose remote file is gone from a complete listing: the only local files a mirror run may delete. */
  deletes: LedgerEntry[];
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
 * instead of deleting, unless the user explicitly allowed one large delete. Only ledger rows are candidates, so files Harvest did not place are never touched.
 */
export function planMirrorDeletes(listing: readonly RemoteEntry[], ledger: ReadonlyMap<string, LedgerEntry>, allowLarge = false): MirrorPlan {
  if (ledger.size === 0) return { deletes: [], refused: null };
  const listed = listedFiles(listing);
  if (listed.size === 0 && !allowLarge) {
    return { deletes: [], refused: `The remote listing is empty but the ledger holds ${ledger.size} file(s); refusing to delete anything. If the remote really is empty, allow one large delete on the job page` };
  }
  const gone = [...ledger.values()].filter((l) => !listed.has(l.remotePath)).sort((a, b) => (a.remotePath < b.remotePath ? -1 : 1));
  if (!allowLarge && gone.length > MIN_GUARDED && gone.length > ledger.size * MAX_DELETE_FRACTION) {
    return {
      deletes: [],
      refused: `${gone.length} of ${ledger.size} synced files are missing from the remote (more than ${Math.round(MAX_DELETE_FRACTION * 100)}%); refusing to delete. Check the remote path; if they really were removed, allow one large delete on the job page`,
    };
  }
  return { deletes: gone, refused: null };
}
