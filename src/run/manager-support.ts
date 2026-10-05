import type { RunState, RunTrigger } from "../domain.js";
import { TERMINAL_RUN_STATES } from "../domain.js";

export type Entry = { runId: number; jobId: number; trigger: RunTrigger; dryRun: boolean; ac: AbortController; userCancelled: boolean };
export type Followup = { atMs: number; timer: NodeJS.Timeout };

/** One skipped_locked row per job per this window; later locked triggers reuse it silently. */
export const SKIP_COALESCE_MS = 600_000;
export const isTerminal = (s: RunState): boolean => TERMINAL_RUN_STATES.includes(s);
export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const defaultJitter = (): number => Math.floor(Math.random() * 30_000);
