import type { RunState } from "../../domain.js";
import type { RunSummary } from "../types.js";

/** What a sender delivers. `text` is already concise and truncated. */
export type NotifyEvent = {
  title: string;
  text: string;
  job: string;
  runId: number;
  state: RunState | "test";
  summary: RunSummary | null;
};

export type Sender = (config: Record<string, string>, event: NotifyEvent, signal?: AbortSignal) => Promise<void>;

export const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`);
