import type { Readable } from "node:stream";
import type { HostConfig } from "../domain.js";

/** One remote file or directory. `path` is relative to the root passed to `list`/`stat`. */
export type RemoteEntry = {
  path: string;
  size: number;
  /** null when the server does not report an mtime. */
  mtimeMs: number | null;
  isDir: boolean;
  hash?: string;
};

export type ScannedHostKey = { type: string; line: string; sha256: string };

export type Progress = { bytes: number; total: number; speedBps: number };
export type DownloadRequest = { remotePath: string; localStagingPath: string; expectedSize: number };
export type DownloadResult = { bytes: number; durationMs: number };

/** One session per run, bound to one host. All methods may throw the typed errors in ../errors.ts. */
export interface EngineSession {
  /** Recursive when `recurse`. A non-zero engine exit means the WHOLE listing failed (throw, never return partial). */
  list(root: string, opts: { recurse: boolean }): Promise<RemoteEntry[]>;
  /** null when the path does not exist. */
  stat(path: string): Promise<RemoteEntry | null>;
  /**
   * Stream exactly `count` bytes starting at `offset`. The stream errors (TransientNetwork) if the
   * process exits non-zero. Callers must count received bytes: exit 0 with fewer bytes is a failure.
   * Aborting `signal` kills the underlying process.
   */
  openRange(path: string, offset: number, count: number, signal: AbortSignal): Readable;
  remove(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  /** null = unsupported by this server. Never required. */
  hash?(path: string, algo: "md5" | "sha1" | "sha256"): Promise<string | null>;
  /** Engines that own the whole transfer (rsync, Phase 2). Absent for rclone: the RangeDownloader is used. */
  download?(req: DownloadRequest, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<DownloadResult>;
  close(): Promise<void>;
}

export interface TransferEngine {
  readonly id: "rclone" | "native" | "rsync";
  readonly capabilities: { hash: boolean; parallelRanges: boolean };
  testConnection(host: HostConfig): Promise<{ ok: true; rootListing: RemoteEntry[]; hostKeys?: ScannedHostKey[] }>;
  open(host: HostConfig): Promise<EngineSession>;
}
