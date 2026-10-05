import type { JobConfig, RunState } from "../domain.js";

/** Result of one post-action step. Failures are warnings (the run becomes `partial`), never run failures. */
export type PostResult = { warnings: string[] };

export type PostContext = { job: JobConfig; runId: number; signal: AbortSignal };

/** Runs INSIDE staging, before promote: unzip/unrar so Sonarr/Plex never see archives. `files` are absolute staged paths. */
export type ExtractInput = PostContext & { unitDir: string; files: string[] };
export interface ExtractStep {
  run(input: ExtractInput): Promise<PostResult & { added: string[]; removed: string[] }>;
}

/** Runs after the unit was promoted and the ledger committed. `finalPaths` are absolute local paths. */
export type AfterPromoteInput = PostContext & { unitKey: string; finalPaths: string[] };
export interface AfterPromoteStep {
  run(input: AfterPromoteInput): Promise<PostResult>;
}

export type RunSummary = {
  filesOk: number;
  filesFailed: number;
  filesSkipped: number;
  bytesDone: number;
  durationMs: number;
  error: string | null;
  warnings: string[];
};

/** Runs once per real (non-dry) run after it reached a terminal state. */
export interface RunNotifier {
  run(input: { job: JobConfig; runId: number; state: RunState; summary: RunSummary; signal?: AbortSignal }): Promise<PostResult>;
}

/** What the executor calls. Order inside a unit: extract (staging) -> promote -> afterPromote [chmod, arr]. Order per run: afterRun. */
export interface PostPipeline {
  extractInStaging(input: ExtractInput): Promise<PostResult & { added: string[]; removed: string[] }>;
  afterPromote(input: AfterPromoteInput): Promise<PostResult>;
  afterRun(input: Parameters<RunNotifier["run"]>[0]): Promise<PostResult>;
}
