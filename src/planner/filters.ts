import picomatch from "picomatch";
import { IN_PROGRESS_PATTERNS } from "../domain.js";
import type { JobConfig } from "../domain.js";
import type { PlannedFile, SkipReason } from "./types.js";

type Matcher = (p: string) => boolean;

function compile(globs: readonly string[]): Matcher {
  if (globs.length === 0) return () => false;
  return picomatch([...globs], { dot: true });
}

const inProgress = compile(IN_PROGRESS_PATTERNS);

/** True when the path looks like a file a torrent client is still writing. */
export function isInProgress(remotePath: string): boolean {
  return inProgress(remotePath);
}

export type FilterVerdict = { reason: SkipReason; detail?: string } | null;

/** Builds the include/exclude/size filter for a job. Returns the skip reason, or null to keep the file. */
export function makeFileFilter(job: JobConfig): (f: PlannedFile) => FilterVerdict {
  const include = compile(job.includeGlobs);
  const exclude = compile(job.excludeGlobs);
  return (f) => {
    if (job.includeGlobs.length > 0 && !include(f.remotePath)) {
      return { reason: "filtered_glob", detail: "not matched by include globs" };
    }
    if (exclude(f.remotePath)) return { reason: "filtered_glob", detail: "matched an exclude glob" };
    if (job.minSize !== null && f.size < job.minSize) return { reason: "filtered_size", detail: "below min size" };
    if (job.maxSize !== null && f.size > job.maxSize) return { reason: "filtered_size", detail: "above max size" };
    return null;
  };
}
