import type { JobConfig, RunState, RunTrigger } from "../domain.js";

export type TriggerResult =
  | { status: "started"; runId: number }
  | { status: "queued"; runId: number }
  | { status: "skipped_locked"; runId: number }
  | { status: "rerun_pending" }
  | { status: "disabled" };

export type ActiveRun = {
  runId: number;
  jobId: number;
  state: RunState;
  trigger: RunTrigger;
  startedAt: number | null;
  bytesDone: number;
  bytesTotal: number;
  speedBps: number;
  activeFiles: { path: string; bytes: number; total: number }[];
};

/** Executes one run to a terminal state. Implemented by run/executor.ts, injected into the manager. */
export type RunJob = (job: JobConfig, runId: number, signal: AbortSignal) => Promise<RunState>;

/** What the web layer and scheduler may do with runs. Frozen contract. */
export interface RunManager {
  /** Cron/interval/manual/followup: a running job yields skipped_locked. Webhook: a running job sets rerun_pending. */
  trigger(jobId: number, trigger: RunTrigger, opts?: { dryRun?: boolean }): TriggerResult;
  cancel(runId: number): boolean;
  active(): ActiveRun[];
  /** Waits for in-flight runs (graceful shutdown). */
  stop(): Promise<void>;
}
