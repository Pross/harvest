/** Plain-data domain types shared by every slice. No behavior, no imports from other src modules. */

export type Protocol = "ftp" | "ftps_explicit" | "ftps_implicit" | "sftp" | "rsync" | "scp";

/** A host with its secret already decrypted. Exists only in memory, never logged, never sent to the UI. */
export type HostConfig = {
  id: number;
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  authKind: "password" | "key";
  secret: { password?: string; privateKey?: string; keyPassphrase?: string };
  tlsAcceptSelfSigned: boolean;
  /** Pinned public key lines (all scanned types), or null until the user confirmed them. */
  hostKeys: string | null;
  maxConnections: number;
};

export type AfterSync = "keep" | "delete" | "delete_after_days" | "move";
export type JobMode = "copy_new" | "mirror";
export type UnitMode = "file" | "top_dir";
export type ChangedPolicy = "skip" | "resync";
export type ScheduleKind = "cron" | "interval" | "manual";
export type RunTrigger = "cron" | "interval" | "manual" | "webhook" | "followup";

/** A job row with JSON columns parsed. Times and sizes are numbers (unix ms / bytes). */
export type JobConfig = {
  id: number;
  name: string;
  hostId: number;
  enabled: boolean;
  /** Remote root. Ledger and planner paths are relative to this. */
  remotePath: string;
  localPath: string;
  mode: JobMode;
  unitMode: UnitMode;
  afterSync: AfterSync;
  afterDays: number | null;
  moveTo: string | null;
  verify: "size" | "checksum";
  settleSeconds: number;
  minAgeSeconds: number;
  minSize: number | null;
  maxSize: number | null;
  includeGlobs: string[];
  excludeGlobs: string[];
  trustMtime: boolean;
  rerunPending: boolean;
  bwlimitBps: number | null;
  parallelFiles: number;
  rangeStreams: number;
  retries: number;
  minFreeBytes: number | null;
  scheduleKind: ScheduleKind;
  scheduleExpr: string | null;
  changedPolicy: ChangedPolicy;
  /** Mirror mode only: when a dry run last armed the job for real runs. Null means a real run is refused. */
  mirrorArmedAt: number | null;
  /** Mirror mode only: when the user allowed one real run to delete past the safety limits. Expires and is consumed by that run. */
  mirrorAllowLargeAt: number | null;
};

export type RunState =
  | "queued" | "connecting" | "listing" | "planning" | "awaiting_space"
  | "transferring" | "verifying" | "finalizing" | "post_actions"
  | "succeeded" | "partial" | "failed" | "cancelled" | "skipped_locked" | "skipped_space";

export const TERMINAL_RUN_STATES: readonly RunState[] = [
  "succeeded", "partial", "failed", "cancelled", "skipped_locked", "skipped_space",
];

/** Default excludes seeded into new jobs: in-progress torrent files and client temp dirs. */
export const DEFAULT_EXCLUDES: readonly string[] = [
  "**/*.part", "**/*.!qB", "**/*.!ut", "**/.incomplete/**", "**/.unwanted/**", "**/*.rtorrent", "**/*.tmp",
];

/** Patterns whose presence INSIDE a unit holds the whole unit (file still being written). */
export const IN_PROGRESS_PATTERNS: readonly string[] = ["**/*.part", "**/*.!qB", "**/*.!ut", "**/.incomplete/**"];
