import type { JobConfig, RunState, RunTrigger } from "../domain.js";
import type { LedgerEntry, Observation, PlannedFile } from "../planner/types.js";

/** Persistence ports. The db slice implements them over better-sqlite3; run/ and planner/ depend only on these. */

export type PartialRow = {
  id: number;
  jobId: number;
  remotePath: string;
  remoteSize: number;
  remoteMtimeMs: number | null;
  stagingPath: string;
  promoteState: "downloading" | "promoting";
  finalPath: string | null;
  /** Server spelling of the path when it differs from the NFC `remotePath`. */
  remoteRaw?: string | null;
};
export type RangeRow = { partialId: number; idx: number; startByte: number; endByte: number; durableBytes: number };

export interface PartialsStore {
  get(jobId: number, remotePath: string): PartialRow | undefined;
  create(row: Omit<PartialRow, "id" | "promoteState" | "finalPath">, ranges: Omit<RangeRow, "partialId" | "durableBytes">[]): PartialRow;
  ranges(partialId: number): RangeRow[];
  /** Persist snapshots taken BEFORE the fsync. Must be a single transaction. */
  checkpoint(partialId: number, snapshots: { idx: number; durableBytes: number }[]): void;
  setPromoting(partialId: number, finalPath: string): void;
  discard(partialId: number): void;
  listPromoting(): PartialRow[];
}

export interface LedgerStore {
  active(jobId: number): Map<string, LedgerEntry>;
  completedUnits(jobId: number): Set<string>;
  /** One transaction: upsert ledger rows (clearing forgotten_at), ledger_units, delete the partials rows. */
  commitUnit(jobId: number, unitKey: string, runId: number, files: (PlannedFile & { hash?: string })[], remoteAction: "none" | "pending", remoteActionAt: number | null): void;
  forgetFile(jobId: number, remotePath: string): void;
  forgetUnit(jobId: number, unitKey: string): void;
  forgetAll(jobId: number): void;
}

export interface ObservationStore {
  all(jobId: number): Map<string, Observation>;
  upsert(jobId: number, rows: Observation[]): void;
  remove(jobId: number, remotePaths: string[]): void;
}

export interface ActivityStore {
  record(e: { category: string; severity?: "info" | "warn" | "error"; jobId?: number; runId?: number; summary: string; meta?: unknown }): void;
}

export interface RunStore {
  create(jobId: number, trigger: RunTrigger, dryRun: boolean): number;
  setState(runId: number, state: RunState, error?: string): void;
  addProgress(runId: number, delta: { bytesDone?: number; filesOk?: number; filesFailed?: number; filesSkipped?: number }): void;
  setPlanned(runId: number, files: number, bytes: number): void;
  failNonTerminal(reason: string): number;
}

export interface JobStore {
  get(id: number): JobConfig | undefined;
  setRerunPending(id: number, pending: boolean): void;
}

/** Global bandwidth gate. `take` resolves when `bytes` may flow; implementations compose job and global buckets. */
export interface Throttle {
  take(bytes: number, signal?: AbortSignal): Promise<void>;
}
