import type { Readable } from "node:stream";
import type { HostConfig } from "../domain.js";
import { PermanentError } from "../errors.js";
import type { EngineSession, RemoteEntry, ScannedHostKey, TransferEngine } from "./types.js";
import { scanHostKeys, type Exec } from "./hostkeys.js";
import { isNotFound, mapRcloneError } from "./rclone-errors.js";
import { cleanStaleConfigs, createRunner, type Runner, type SpawnFn } from "./rclone-process.js";
import { buildRemote, type BuildOptions } from "./rclone-remote.js";

export type RcloneEngineOptions = {
  rclone: string;
  tmpDir: string;
  connectTimeoutMs: number;
  /** Upper bound for one non-streaming command (list can be slow on big trees). Default 10 minutes. */
  runTimeoutMs?: number;
  spawn?: SpawnFn;
  killGraceMs?: number;
  keyScanExec?: Exec;
};

/** rclone's idle timeout: a connection that moves no data for this long is dropped (then retried by Harvest). */
const IDLE_TIMEOUT = "60s";
const DEFAULT_RUN_TIMEOUT_MS = 600_000;

type LsJsonItem = { Path: string; Size?: number; ModTime?: string; IsDir?: boolean };

/**
 * Flags on every command.
 *  -q                      only errors reach stderr (so mapRcloneError sees the cause, not progress noise)
 *  --retries 1             rclone must not retry whole operations; Harvest owns retry/backoff (isRetryable)
 *  --low-level-retries 1   same for per-request retries, so a dead server fails fast instead of hanging
 *  --contimeout            time allowed to establish a connection (engine connectTimeoutMs)
 *  --timeout               idle timeout (IDLE_TIMEOUT) so stalled transfers die instead of blocking a slot
 */
export function commonFlags(connectTimeoutMs: number): string[] {
  return [
    "-q", "--retries", "1", "--low-level-retries", "1",
    "--contimeout", `${Math.max(1, Math.ceil(connectTimeoutMs / 1000))}s`,
    "--timeout", IDLE_TIMEOUT,
  ];
}

/** rclone prints the zero time for "unknown mtime". */
export function parseModTime(value: string | undefined): number | null {
  if (!value || value.startsWith("0001-01-01")) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function toEntry(item: LsJsonItem): RemoteEntry {
  const isDir = item.IsDir === true;
  if (!isDir && (typeof item.Size !== "number" || !Number.isFinite(item.Size) || item.Size < 0)) {
    throw new PermanentError(`rclone listing has no valid size for file ${item.Path}`);
  }
  return {
    path: item.Path,
    size: isDir ? 0 : item.Size!,
    mtimeMs: parseModTime(item.ModTime),
    isDir,
  };
}

function parseLsJson(stdout: string): LsJsonItem[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed as LsJsonItem[];
  } catch (err) {
    throw new PermanentError("rclone lsjson returned unparseable output", { cause: err });
  }
}

class RcloneSession implements EngineSession {
  constructor(private readonly runner: Runner, private readonly fs: string, private readonly flags: string[], private readonly timeoutMs: number) {}

  private target(path: string): string {
    return `${this.fs}${path}`;
  }

  private cmd(name: string, ...rest: string[]): string[] {
    return [name, ...this.flags, ...rest];
  }

  async list(root: string, opts: { recurse: boolean }): Promise<RemoteEntry[]> {
    const rec = opts.recurse ? ["-R"] : [];
    const res = await this.runner.runOk(this.cmd("lsjson", ...rec, "--no-mimetype", this.target(root)), { timeoutMs: this.timeoutMs });
    return parseLsJson(res.stdout).map(toEntry);
  }

  async stat(path: string): Promise<RemoteEntry | null> {
    const res = await this.runner.run(this.cmd("lsjson", "--stat", "--no-mimetype", this.target(path)), { timeoutMs: this.timeoutMs });
    if (res.code !== 0) {
      if (isNotFound(res.code)) return null;
      throw mapRcloneError(res.code, res.stderr);
    }
    const parsed: unknown = JSON.parse(res.stdout || "null");
    if (parsed === null || Array.isArray(parsed)) return null;
    return { ...toEntry(parsed as LsJsonItem), path };
  }

  openRange(path: string, offset: number, count: number, signal: AbortSignal): Readable {
    const args = this.cmd("cat", "--buffer-size", "0", "--offset", String(offset), "--count", String(count), this.target(path));
    return this.runner.stream(args, signal);
  }

  /** Idempotent: `deletefile` exits 4 for a missing file AND for a directory, so exit 4 is settled by a stat. */
  async remove(path: string): Promise<void> {
    const res = await this.runner.run(this.cmd("deletefile", this.target(path)), { timeoutMs: this.timeoutMs });
    if (res.code === 0) return;
    if (res.code !== 4) throw mapRcloneError(res.code, res.stderr);
    const left = await this.stat(path);
    if (left === null) return;
    throw new PermanentError(`rclone cannot delete ${left.isDir ? "directory" : "file"} ${path}`);
  }

  async move(from: string, to: string): Promise<void> {
    await this.runner.runOk(this.cmd("moveto", this.target(from), this.target(to)), { timeoutMs: this.timeoutMs });
  }

  async hash(path: string, algo: "md5" | "sha1" | "sha256"): Promise<string | null> {
    const res = await this.runner.run(this.cmd("hashsum", algo, this.target(path)), { timeoutMs: this.timeoutMs });
    if (res.code !== 0) {
      if (/unsupported|not supported/i.test(res.stderr)) return null;
      throw mapRcloneError(res.code, res.stderr);
    }
    const [token = "", name] = res.stdout.trim().split(/\s+/, 2);
    const len = { md5: 32, sha1: 40, sha256: 64 }[algo];
    return name !== undefined && token.length === len && /^[0-9a-f]+$/i.test(token) ? token.toLowerCase() : null;
  }

  async close(): Promise<void> {
    this.runner.killAll();
  }
}

export function createRcloneEngine(opts: RcloneEngineOptions): TransferEngine {
  cleanStaleConfigs(opts.tmpDir);
  const deps = { rclone: opts.rclone, tmpDir: opts.tmpDir, spawn: opts.spawn, killGraceMs: opts.killGraceMs };
  const flags = commonFlags(opts.connectTimeoutMs);
  const timeoutMs = opts.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

  async function openWith(host: HostConfig, buildOpts: BuildOptions): Promise<EngineSession> {
    const remote = await buildRemote(host, deps, buildOpts);
    return new RcloneSession(createRunner(deps, remote.env), remote.fs, flags, timeoutMs);
  }

  const open = (host: HostConfig): Promise<EngineSession> => openWith(host, {});

  async function testConnection(host: HostConfig) {
    const session = await openWith(host, { allowUnpinned: true });
    try {
      const rootListing = await session.list("", { recurse: false });
      let hostKeys: ScannedHostKey[] | undefined;
      if (host.protocol === "sftp") {
        const timeoutSec = Math.max(1, Math.ceil(opts.connectTimeoutMs / 1000));
        hostKeys = await scanHostKeys(host.host, host.port, { timeoutSec, exec: opts.keyScanExec });
      }
      return { ok: true as const, rootListing, ...(hostKeys ? { hostKeys } : {}) };
    } finally {
      await session.close();
    }
  }

  return { id: "rclone", capabilities: { hash: false, parallelRanges: true }, testConnection, open };
}
