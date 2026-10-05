import type { JobConfig, RunState } from "../../domain.js";
import type { Logger } from "../../logger.js";
import type { Stores } from "../../store/index.js";
import type { RunNotifier } from "../types.js";

const TIMEOUT_MS = 30_000;

/**
 * Notifications for runs that end before the executor takes over (failed to start, local path rejected, job disabled,
 * skipped_locked). Fire and forget: the run is already stored, so delivery problems only become activity entries.
 */
export function createEarlyNotifier(notifier: RunNotifier, stores: Pick<Stores, "activity">, logger: Logger): (job: JobConfig, runId: number, state: RunState, error: string) => void {
  return (job, runId, state, error) => {
    const summary = { filesOk: 0, filesFailed: 0, filesSkipped: 0, bytesDone: 0, durationMs: 0, error, warnings: [] };
    notifier.run({ job, runId, state, summary, signal: AbortSignal.timeout(TIMEOUT_MS) })
      .then((res) => {
        for (const w of res.warnings) stores.activity.record({ category: "notify", severity: "warn", jobId: job.id, runId, summary: w });
      })
      .catch((err: unknown) => logger.error({ err, runId, jobId: job.id }, "early run notification failed"));
  };
}
