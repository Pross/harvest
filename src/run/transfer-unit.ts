import { createHash } from "node:crypto";
import { createReadStream, promises as fsp } from "node:fs";
import path from "node:path";
import type { JobConfig } from "../domain.js";
import { AuthError, HostKeyChanged, PermanentError } from "../errors.js";
import type { EngineSession } from "../engine/types.js";
import type { PlannedFile, PlannedUnit } from "../planner/types.js";
import type { Slots } from "./connection-slots.js";
import type { ExecutorDeps } from "./executor.js";
import { finalizeUnit } from "./finalize.js";
import { afterPromoteUnit, extractUnit } from "./post-hooks.js";
import { resolvePaths, remoteAbsOf } from "./paths.js";
import { downloadFile, type DownloadFileResult } from "./range-downloader.js";
import type { EventBus } from "./events.js";
import type { Stores } from "../store/index.js";
import type { PartialRow, Throttle } from "./types.js";
import { verifyComplete, verifyStagedSize } from "./verify.js";

/** Aggregates per-file byte deltas into run counters and ~1/s progress events. */
export class Tracker {
  private done = 0;
  private pending = 0;
  private lastEmit = 0;
  private readonly started = Date.now();
  private readonly active = new Map<string, { bytes: number; total: number }>();

  constructor(private readonly runs: Stores["runs"], private readonly bus: EventBus, private readonly jobId: number, private readonly runId: number, private readonly total: number) {}

  begin(path: string, total: number): void {
    this.active.set(path, { bytes: 0, total });
  }

  add(path: string, delta: number): void {
    const a = this.active.get(path);
    if (a) a.bytes += delta;
    this.done += delta;
    this.pending += delta;
    this.flush(false);
  }

  /** A finished file counts its full size even when part of it was fetched by an earlier run. */
  complete(path: string, size: number): void {
    const a = this.active.get(path);
    if (a && a.bytes < size) this.add(path, size - a.bytes);
    this.active.delete(path);
  }

  end(path: string): void {
    this.active.delete(path);
  }

  flush(force: boolean): void {
    const t = Date.now();
    if (!force && t - this.lastEmit < 1000) return;
    this.lastEmit = t;
    if (this.pending > 0) this.runs.addProgress(this.runId, { bytesDone: this.pending });
    this.pending = 0;
    const speedBps = (this.done / Math.max(1, t - this.started)) * 1000;
    const activeFiles = [...this.active].map(([path, v]) => ({ path, ...v }));
    this.bus.emit({ type: "run.progress", runId: this.runId, jobId: this.jobId, bytesDone: this.done, bytesTotal: this.total, speedBps, activeFiles });
  }
}

export type Severity = "info" | "warn" | "error";

/** Everything one run's unit pipeline needs. Built once per run by the executor. */
export type RunCtx = {
  deps: ExecutorDeps;
  job: JobConfig;
  runId: number;
  session: EngineSession;
  slots: Slots;
  throttle: Throttle;
  signal: AbortSignal;
  tracker: Tracker;
  now: () => number;
  note(category: string, severity: Severity, summary: string, meta?: unknown): void;
  /** Records a warning activity at most once per key per run. */
  warnOnce(key: string, summary: string): void;
  /** A post-action warning: recorded as activity and turns a succeeded run into `partial`. */
  postWarn(summary: string): void;
  setState(state: "transferring" | "verifying" | "finalizing"): void;
};

/** A downloaded, verified, fsynced staged file ready to finalize. */
export type StagedFile = {
  file: PlannedFile;
  partial: PartialRow;
  wasPromoting: boolean;
  /** An interrupted promote already placed this file at `final`: nothing to stage, verify or rename. */
  promoted?: boolean;
  staging: string;
  final: string;
  hash?: string;
};

export type UnitOutcome = { ok: boolean; failedFiles: number };

const HASH_ALGOS = ["sha256", "sha1", "md5"] as const;

export const isFatal = (err: unknown): boolean => err instanceof AuthError || err instanceof HostKeyChanged;

/** Runs `fn` over `items` with `limit` workers. The first error stops the pool, calls `onFatal` and is rethrown. */
async function runPool<T>(items: readonly T[], limit: number, fn: (t: T) => Promise<void>, onFatal: () => void): Promise<void> {
  const queue = [...items];
  let fatal: { err: unknown } | undefined;
  const worker = async (): Promise<void> => {
    for (let t = queue.shift(); t !== undefined && !fatal; t = queue.shift()) {
      try {
        await fn(t);
      } catch (err) {
        if (!fatal) { fatal = { err }; onFatal(); }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (fatal) throw fatal.err;
}

function recordFile(ctx: RunCtx, unitKey: string, f: PlannedFile, state: string, bytes: number, error?: string): void {
  ctx.deps.stores.runs.recordFile({ runId: ctx.runId, unitKey, remotePath: f.remotePath, size: f.size, state, bytes, attempts: 1, error: error ?? null });
}

async function fetchFile(ctx: RunCtx, unit: PlannedUnit, file: PlannedFile): Promise<DownloadFileResult> {
  const { job, deps } = ctx;
  const { staging } = resolvePaths(job.localPath, job.id, file.remotePath);
  await fsp.mkdir(path.dirname(staging), { recursive: true });
  ctx.tracker.begin(file.remotePath, file.size);
  recordFile(ctx, unit.key, file, "downloading", 0);
  const result = await downloadFile({
    jobId: job.id, file, remoteAbsPath: remoteAbsOf(job.remotePath, file), stagingPath: staging,
    session: ctx.session, partials: deps.stores.partials, slots: ctx.slots, throttle: ctx.throttle,
    rangeStreams: job.rangeStreams, rangeMinBytes: deps.cfg.rangeMinBytes, checkpointBytes: deps.cfg.checkpointBytes,
    stallTimeoutMs: deps.cfg.stallTimeoutMs, resumeMarginBytes: deps.cfg.resumeMarginBytes, retries: job.retries,
    backoff: deps.backoff, signal: ctx.signal, onProgress: (d) => ctx.tracker.add(file.remotePath, d),
  });
  recordFile(ctx, unit.key, file, "downloaded", file.size);
  return result;
}

async function localHash(file: string, algo: string): Promise<string> {
  const h = createHash(algo);
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function remoteHash(ctx: RunCtx, abs: string, algo: (typeof HASH_ALGOS)[number]): Promise<string | null> {
  const release = await ctx.slots.acquireOne(ctx.signal);
  try {
    return await ctx.session.hash!(abs, algo);
  } finally {
    release();
  }
}

/** Checksum only with job.verify = checksum AND a remote hash; otherwise a visible warning, never a silent skip. */
async function checksum(ctx: RunCtx, file: PlannedFile, staging: string, partial: PartialRow): Promise<string | undefined> {
  const abs = remoteAbsOf(ctx.job.remotePath, file);
  for (const algo of ctx.session.hash ? HASH_ALGOS : []) {
    const remote = await remoteHash(ctx, abs, algo);
    if (remote === null) continue;
    const local = await localHash(staging, algo);
    if (local !== remote.toLowerCase()) {
      ctx.deps.stores.partials.discard(partial.id);
      await fsp.rm(staging, { force: true });
      throw new PermanentError(`${algo} mismatch for ${file.remotePath}: remote ${remote}, local ${local}`);
    }
    return `${algo}:${local}`;
  }
  ctx.warnOnce("no-remote-hash", "checksum verification requested but the server provides no remote hash; verified by size only");
  return undefined;
}

async function verifyFile(ctx: RunCtx, file: PlannedFile): Promise<StagedFile> {
  const { staging, final } = resolvePaths(ctx.job.localPath, ctx.job.id, file.remotePath);
  const { partials } = ctx.deps.stores;
  const partial = partials.get(ctx.job.id, file.remotePath);
  if (!partial) throw new PermanentError(`no partial recorded for ${file.remotePath}`);
  verifyComplete(partials, partial.id, file.size);
  await verifyStagedSize(staging, file.size);
  const hash = ctx.job.verify === "checksum" ? await checksum(ctx, file, staging, partial) : undefined;
  const staged: StagedFile = { file, partial, wasPromoting: partial.promoteState === "promoting", staging, final };
  return hash ? { ...staged, hash } : staged;
}

type Failures = Map<string, string>;

function failFile(ctx: RunCtx, unit: PlannedUnit, file: PlannedFile, err: unknown, failures: Failures): void {
  const msg = err instanceof Error ? err.message : String(err);
  failures.set(file.remotePath, msg);
  ctx.deps.logger.warn({ err, runId: ctx.runId, path: file.remotePath }, "file failed");
  ctx.note("file", "error", `${file.remotePath} failed: ${msg}`, { unit: unit.key, error: err instanceof Error ? err.name : "Error" });
}

/** Per-file boundary: a non-fatal failure is recorded and does not touch sibling files. */
async function guarded<T>(ctx: RunCtx, unit: PlannedUnit, file: PlannedFile, failures: Failures, step: () => Promise<T>): Promise<T | undefined> {
  try {
    return await step();
  } catch (err) {
    if (ctx.signal.aborted || isFatal(err)) throw err;
    failFile(ctx, unit, file, err, failures);
    ctx.tracker.end(file.remotePath);
    return undefined;
  }
}

type Fetched = { file: PlannedFile; promoted: boolean };

async function downloadAll(ctx: RunCtx, unit: PlannedUnit, failures: Failures, abortUnit: () => void): Promise<Fetched[]> {
  const fetched: Fetched[] = [];
  const run = (file: PlannedFile) => ctx.deps.fileGate.run(() => fetchFile(ctx, unit, file), ctx.signal);
  await runPool(unit.files, ctx.job.parallelFiles, async (file) => {
    const res = await guarded(ctx, unit, file, failures, run.bind(null, file));
    if (res) fetched.push({ file, promoted: res.promoted === true });
  }, abortUnit);
  return fetched;
}

/** A file an interrupted promote already put in place needs no verification: it was verified before it was renamed. */
function promotedFile(ctx: RunCtx, file: PlannedFile): StagedFile {
  const { staging, final } = resolvePaths(ctx.job.localPath, ctx.job.id, file.remotePath);
  const partial = ctx.deps.stores.partials.get(ctx.job.id, file.remotePath);
  if (!partial) throw new PermanentError(`no partial recorded for ${file.remotePath}`);
  return { file, partial, wasPromoting: true, promoted: true, staging, final };
}

async function verifyAll(ctx: RunCtx, unit: PlannedUnit, fetched: Fetched[], failures: Failures): Promise<StagedFile[]> {
  const out: StagedFile[] = [];
  for (const { file, promoted } of fetched) {
    const sf = await guarded(ctx, unit, file, failures, async () => (promoted ? promotedFile(ctx, file) : verifyFile(ctx, file)));
    if (sf) out.push(sf);
  }
  return out.sort((a, b) => (a.file.remotePath < b.file.remotePath ? -1 : 1));
}

function settle(ctx: RunCtx, unit: PlannedUnit, failures: Failures, ok: boolean): UnitOutcome {
  const { runs } = ctx.deps.stores;
  for (const f of unit.files) {
    const err = failures.get(f.remotePath);
    if (ok) {
      ctx.tracker.complete(f.remotePath, f.size);
      recordFile(ctx, unit.key, f, "done", f.size);
    } else {
      ctx.tracker.end(f.remotePath);
      if (err !== undefined) recordFile(ctx, unit.key, f, "failed", 0, err);
      else recordFile(ctx, unit.key, f, "skipped", 0, "unit held: another file of the unit failed");
    }
  }
  ctx.tracker.flush(true);
  runs.addProgress(ctx.runId, ok ? { filesOk: unit.files.length } : { filesFailed: failures.size, filesSkipped: unit.files.length - failures.size });
  return { ok, failedFiles: ok ? 0 : failures.size };
}

/**
 * One unit end to end: download (parallel files), verify, finalize. Fatal and abort errors propagate.
 * The unit has its own AbortController (combined with the run signal): the first fatal error aborts the
 * sibling downloads so the run does not wait for in-flight multi-GB files, and pending bytes are flushed.
 */
export async function processUnit(runCtx: RunCtx, unit: PlannedUnit): Promise<UnitOutcome> {
  const unitCtl = new AbortController();
  const ctx: RunCtx = { ...runCtx, signal: AbortSignal.any([runCtx.signal, unitCtl.signal]) };
  try {
    return await runUnit(ctx, unit, () => unitCtl.abort());
  } catch (err) {
    ctx.tracker.flush(true);
    throw err;
  }
}

async function runUnit(ctx: RunCtx, unit: PlannedUnit, abortUnit: () => void): Promise<UnitOutcome> {
  const failures: Failures = new Map();
  ctx.setState("transferring");
  const fetched = await downloadAll(ctx, unit, failures, abortUnit);
  ctx.setState("verifying");
  const staged = await verifyAll(ctx, unit, fetched, failures);
  if (failures.size > 0) return settle(ctx, unit, failures, false);
  ctx.setState("finalizing");
  try {
    const extras = await extractUnit(ctx, unit, staged);
    const changed = await finalizeUnit(ctx, unit, staged, extras);
    for (const [p, msg] of changed) failFile(ctx, unit, unit.files.find((f) => f.remotePath === p)!, new Error(msg), failures);
    if (changed.size === 0) await afterPromoteUnit(ctx, unit, staged, extras);
  } catch (err) {
    if (ctx.signal.aborted || isFatal(err)) throw err;
    for (const f of unit.files) failFile(ctx, unit, f, err, failures);
  }
  const ok = failures.size === 0;
  if (ok) ctx.note("unit", "info", `Synced ${unit.key} (${unit.files.length} files, ${unit.totalBytes} bytes)`, { unit: unit.key });
  return settle(ctx, unit, failures, ok);
}
