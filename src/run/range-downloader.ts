import { promises as fsp } from "node:fs";
import type { Readable } from "node:stream";
import { PermanentError, TransientNetwork, isRetryable } from "../errors.js";
import type { EngineSession, RemoteEntry } from "../engine/types.js";
import type { PlannedFile } from "../planner/types.js";
import type { Slots } from "./connection-slots.js";
import { openRangeWriter, type RangeWriter } from "./range-writer.js";
import { abortError, defaultSleep } from "./throttle.js";
import type { PartialRow, PartialsStore, RangeRow, Throttle } from "./types.js";

export type DownloadFileRequest = {
  jobId: number;
  file: PlannedFile;
  /** Path handed to the session (stat/openRange). */
  remoteAbsPath: string;
  stagingPath: string;
  session: EngineSession;
  partials: PartialsStore;
  slots: Slots;
  throttle: Throttle;
  rangeStreams: number;
  rangeMinBytes: number;
  checkpointBytes: number;
  stallTimeoutMs: number;
  /** Default 1 MiB. */
  resumeMarginBytes?: number;
  retries: number;
  backoff?: (attempt: number, signal?: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  /** Called with bytes not previously counted (re-fetched resume margin is not counted twice). */
  onProgress: (deltaBytes: number) => void;
};
/** `promoted`: an interrupted promote already put the verified file at its final path; there is nothing to stage or finalize. */
export type DownloadFileResult = { bytes: number; resumed: boolean; promoted?: boolean };

const MIB = 1024 * 1024;

export function defaultBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
  const base = Math.min(2 ** attempt * 5000, 300_000);
  return defaultSleep(base + Math.random() * 1000, signal);
}

export async function downloadFile(req: DownloadFileRequest): Promise<DownloadFileResult> {
  if (req.signal.aborted) throw abortError(req.signal);
  const found = await reusablePartial(req);
  if (found?.promoted) return { bytes: req.file.size, resumed: true, promoted: true };
  const reuse = found?.row;
  const todo = reuse ? req.partials.ranges(reuse.id).filter(incomplete).length : plannedRanges(req);
  const grant = todo > 0 ? await req.slots.grant(todo, req.signal) : { count: 0, release: () => {} };
  try {
    const row = reuse ?? (await createFresh(req, grant.count));
    await transfer(req, row.id, req.partials.ranges(row.id), grant.count);
    return { bytes: req.file.size, resumed: reuse !== undefined };
  } finally {
    grant.release();
  }
}

const incomplete = (r: RangeRow): boolean => r.durableBytes < r.endByte - r.startByte;

function plannedRanges(req: DownloadFileRequest): number {
  if (req.file.size < req.rangeMinBytes) return 1;
  return Math.max(1, Math.min(req.rangeStreams, req.file.size));
}

function splitRanges(size: number, count: number): { idx: number; startByte: number; endByte: number }[] {
  const base = Math.floor(size / count);
  return Array.from({ length: count }, (_, idx) => ({
    idx,
    startByte: idx * base,
    endByte: idx === count - 1 ? size : (idx + 1) * base,
  }));
}

async function discard(req: DownloadFileRequest, row: PartialRow): Promise<void> {
  req.partials.discard(row.id);
  await fsp.rm(req.stagingPath, { force: true });
}

const fileSize = async (p: string): Promise<number | null> => (await fsp.stat(p).then((st) => st.size, (e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e))));

/** Interrupted promote of this very file: staging gone, final in place at the expected size. */
async function alreadyPromoted(req: DownloadFileRequest, row: PartialRow): Promise<boolean> {
  if (row.promoteState !== "promoting" || row.finalPath === null || row.stagingPath !== req.stagingPath) return false;
  if (row.remoteSize !== req.file.size || (await fileSize(row.stagingPath)) !== null) return false;
  return (await fileSize(row.finalPath)) === row.remoteSize;
}

async function statWithSlot(req: DownloadFileRequest): Promise<RemoteEntry | null> {
  const release = await req.slots.acquireOne(req.signal);
  try {
    return await req.session.stat(req.remoteAbsPath);
  } finally {
    release();
  }
}

/** Returns the existing partial only if the remote still matches it and the staging file is intact (or already promoted). */
async function reusablePartial(req: DownloadFileRequest): Promise<{ row: PartialRow; promoted: boolean } | undefined> {
  const row = req.partials.get(req.jobId, req.file.remotePath);
  if (!row) return undefined;
  if (await alreadyPromoted(req, row)) return { row, promoted: true };
  const remote = await statWithSlot(req);
  if (remote === null) {
    await discard(req, row);
    throw new PermanentError(`remote file no longer exists: ${req.remoteAbsPath}`);
  }
  const changed =
    remote.size !== row.remoteSize ||
    row.remoteSize !== req.file.size ||
    (row.remoteMtimeMs !== null && remote.mtimeMs !== row.remoteMtimeMs);
  if (changed || !(await stagingIntact(req, row))) {
    await discard(req, row);
    return undefined;
  }
  return { row, promoted: false };
}

async function stagingIntact(req: DownloadFileRequest, row: PartialRow): Promise<boolean> {
  return row.stagingPath === req.stagingPath && (await fileSize(req.stagingPath)) === row.remoteSize;
}

async function createFresh(req: DownloadFileRequest, count: number): Promise<PartialRow> {
  await fsp.rm(req.stagingPath, { force: true });
  const { file } = req;
  const meta = { jobId: req.jobId, remotePath: file.remotePath, remoteSize: file.size, remoteMtimeMs: file.mtimeMs, stagingPath: req.stagingPath, remoteRaw: file.remoteRaw ?? null };
  return req.partials.create(meta, splitRanges(file.size, count));
}

async function transfer(req: DownloadFileRequest, partialId: number, ranges: RangeRow[], concurrency: number): Promise<void> {
  const todo = ranges.flatMap((r, i) => (incomplete(r) ? [i] : []));
  const writer = await openRangeWriter(req.stagingPath, req.file.size);
  try {
    if (todo.length === 0) await writer.fsync();
    else await new Transfer(req, partialId, ranges, writer).run(todo, concurrency);
  } finally {
    await writer.close();
  }
}

/** Per-call state: received counters, the single checkpoint pipeline, failure and sibling abort. */
class Transfer {
  private readonly received: number[];
  private readonly durable: number[];
  private readonly counted: number[];
  private since = 0;
  private inflight: Promise<void> | undefined;
  private failure: { err: unknown } | undefined;
  private readonly ctrl = new AbortController();
  private readonly margin: number;

  constructor(
    private readonly req: DownloadFileRequest,
    private readonly partialId: number,
    private readonly ranges: RangeRow[],
    private readonly writer: RangeWriter,
  ) {
    this.durable = ranges.map((r) => r.durableBytes);
    this.received = [...this.durable];
    this.counted = [...this.durable];
    this.margin = req.resumeMarginBytes ?? MIB;
  }

  async run(todo: number[], concurrency: number): Promise<void> {
    const onAbort = (): void => this.fail(abortError(this.req.signal));
    this.req.signal.addEventListener("abort", onAbort, { once: true });
    if (this.req.signal.aborted) onAbort();
    const queue = [...todo];
    const worker = async (): Promise<void> => {
      for (let i = queue.shift(); i !== undefined && !this.ctrl.signal.aborted; i = queue.shift()) {
        try {
          await this.runRange(i);
        } catch (err) {
          return this.fail(err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length)) }, worker));
    this.req.signal.removeEventListener("abort", onAbort);
    await this.inflight;
    if (this.failure) throw this.failure.err;
    await this.checkpoint(true);
  }

  private fail(err: unknown): void {
    this.failure ??= { err };
    this.ctrl.abort();
  }

  private async runRange(i: number): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.stream(i);
      } catch (err) {
        if (!isRetryable(err) || attempt >= this.req.retries || this.ctrl.signal.aborted) throw err;
        await (this.req.backoff ?? defaultBackoff)(attempt, this.ctrl.signal);
        if (this.ctrl.signal.aborted) throw abortError(this.ctrl.signal);
      }
    }
  }

  private async stream(i: number): Promise<void> {
    const r = this.ranges[i]!;
    const len = r.endByte - r.startByte;
    const got = (this.received[i] = Math.max(0, this.durable[i]! - this.margin));
    const stall = new AbortController();
    let stalled = false;
    const arm = (): NodeJS.Timeout => setTimeout(() => ((stalled = true), stall.abort()), this.req.stallTimeoutMs);
    let timer = arm();
    const signal = AbortSignal.any([this.ctrl.signal, stall.signal]);
    try {
      const src: Readable = this.req.session.openRange(this.req.remoteAbsPath, r.startByte + got, len - got, signal);
      signal.addEventListener("abort", () => src.destroy(), { once: true });
      for await (const chunk of src) {
        clearTimeout(timer);
        await this.accept(i, chunk as Buffer, signal);
        timer = arm();
      }
      if (this.received[i] !== len) throw new TransientNetwork(`range ${r.idx} ended after ${this.received[i]} of ${len} bytes`);
    } catch (err) {
      if (stalled) throw new TransientNetwork(`range ${r.idx} stalled for ${this.req.stallTimeoutMs} ms`, { cause: err });
      if (this.ctrl.signal.aborted) throw abortError(this.ctrl.signal);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async accept(i: number, chunk: Buffer, signal: AbortSignal): Promise<void> {
    const r = this.ranges[i]!;
    await this.req.throttle.take(chunk.length, signal);
    await this.writer.write(r.startByte + this.received[i]!, chunk, r.endByte);
    this.received[i]! += chunk.length;
    if (this.received[i]! > this.counted[i]!) {
      this.req.onProgress(this.received[i]! - this.counted[i]!);
      this.counted[i] = this.received[i]!;
    }
    this.since += chunk.length;
    this.maybeCheckpoint();
  }

  private maybeCheckpoint(): void {
    if (this.since < this.req.checkpointBytes || this.inflight) return;
    this.since = 0;
    this.inflight = this.checkpoint(false)
      .catch((err) => this.fail(err))
      .finally(() => (this.inflight = undefined));
  }

  /** Snapshot first, then fsync, then persist: a crash in between only loses progress. */
  private async checkpoint(final: boolean): Promise<void> {
    const snaps = this.ranges.map((r, i) => ({
      idx: r.idx,
      durableBytes: final ? r.endByte - r.startByte : Math.max(this.durable[i]!, this.received[i]!),
    }));
    await this.writer.fsync();
    this.req.partials.checkpoint(this.partialId, snaps);
    snaps.forEach((s, i) => (this.durable[i] = s.durableBytes));
  }
}
