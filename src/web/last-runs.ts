import type { RunRow } from "../store/index.js";
import type { AppDeps } from "./deps.js";

const RECENT_WINDOW = 500;

/**
 * Latest run per job id. One `listRecent` query covers jobs that ran recently; only jobs absent from that window
 * (rarely run, or never run) fall back to a per-job lookup, so the common dashboard load is a single query.
 */
export function lastRunByJob(deps: AppDeps, jobIds: number[]): Map<number, RunRow | undefined> {
  const latest = new Map<number, RunRow>();
  for (const r of deps.stores.runs.listRecent(RECENT_WINDOW)) if (!latest.has(r.jobId)) latest.set(r.jobId, r);
  const out = new Map<number, RunRow | undefined>();
  for (const id of jobIds) out.set(id, latest.get(id) ?? deps.stores.runs.list(id, 1)[0]);
  return out;
}
