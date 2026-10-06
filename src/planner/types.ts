import type { JobConfig } from "../domain.js";
import type { RemoteEntry } from "../engine/types.js";

/** Active (not forgotten) ledger row, as the planner sees it. */
export type LedgerEntry = { remotePath: string; size: number; mtimeMs: number | null; syncedAt: number };

/** Settle-check state persisted per remote file (table remote_observations). */
export type Observation = {
  remotePath: string;
  size: number;
  mtimeMs: number | null;
  firstSeenAt: number;
  lastChangedAt: number;
  lastSeenAt: number;
};

export type PlannerInput = {
  job: JobConfig;
  /** Recursive listing of job.remotePath; entries relative to it. */
  listing: RemoteEntry[];
  /** Keyed by remotePath. Only active rows. */
  ledger: ReadonlyMap<string, LedgerEntry>;
  /** Keyed by remotePath. */
  observations: ReadonlyMap<string, Observation>;
  /** Unit keys already completed (ledger_units), used for pack-gains-a-file detection. */
  completedUnits: ReadonlySet<string>;
  /** Mirror mode: ledger files still on the remote whose local copy is gone; they are downloaded again. Ignored otherwise. */
  missingLocal?: ReadonlySet<string>;
  now: number;
};

export type SkipReason =
  | "unsafe_path" | "filtered_glob" | "filtered_size" | "in_progress_marker"
  | "first_sighting" | "unsettled" | "too_young" | "already_synced" | "unit_held";

export type PlannedFile = {
  /** NFC-normalized path: ledger key, observation key and the basis of LOCAL paths. */
  remotePath: string;
  size: number;
  mtimeMs: number | null;
  /** The path exactly as the server listed it, set only when it differs from `remotePath` (NFD names). Engine calls use it. */
  remoteRaw?: string;
};
export type PlannedUnit = { key: string; files: PlannedFile[]; totalBytes: number; existing: boolean };
export type SkippedEntry = { remotePath: string; reason: SkipReason; detail?: string };
export type ObservationUpdate = Observation;

export type Plan = {
  units: PlannedUnit[];
  skipped: SkippedEntry[];
  /** Upserts for remote_observations; the caller persists them (not in dry-run). */
  observations: ObservationUpdate[];
  /** Remote paths no longer listed; caller deletes their observations. */
  vanished: string[];
  /** Epoch ms for one coalesced follow-up run when any file was unsettled or first-seen, else null. */
  followupAt: number | null;
  warnings: string[];
};
