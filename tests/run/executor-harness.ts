import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach } from "vitest";
import type { JobConfig } from "../../src/domain.js";
import type { EngineSession, RemoteEntry, TransferEngine } from "../../src/engine/types.js";
import { buildLogger } from "../../src/logger.js";
import { createSlots } from "../../src/run/connection-slots.js";
import { createEventBus, type AppEvent } from "../../src/run/events.js";
import { createExecutor, type ExecutorDeps } from "../../src/run/executor.js";
import { createSpaceReservations } from "../../src/run/space.js";
import type { RunRow } from "../../src/store/run-store.js";
import type { JobInput } from "../../src/store/job-store.js";
import { setup } from "../store/helpers.js";

export const REMOTE_ROOT = "/remote";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export type RemoteFile = { data: Buffer; mtimeMs: number | null };
export type SessionOpts = {
  chunkSize?: number;
  onChunk?: (sent: number) => Promise<void> | void;
  onStat?: (abs: string, count: number) => void;
  hash?: (abs: string, algo: string) => Promise<string | null>;
};
export type TestSession = EngineSession & {
  files: Map<string, RemoteFile>;
  ranged: { bytes: number };
  removed: string[];
  moved: [string, string][];
  failMove?: Error;
  failList?: Error;
  failRemove?: Error;
  failOpen?: Error;
  set(rel: string, data: Buffer, mtimeMs?: number | null): void;
};

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

export function createTestSession(o: SessionOpts = {}): TestSession {
  const files = new Map<string, RemoteFile>();
  const statCounts = new Map<string, number>();
  const chunk = o.chunkSize ?? 4096;
  const s: TestSession = {
    files,
    ranged: { bytes: 0 },
    removed: [],
    moved: [],
    set: (rel, data, mtimeMs = 1000) => void files.set(path.posix.join(REMOTE_ROOT, rel), { data, mtimeMs }),
    async list(root) {
      if (s.failList) throw s.failList;
      const out: RemoteEntry[] = [];
      for (const [abs, f] of files) {
        if (abs.startsWith(`${root}/`)) out.push({ path: abs.slice(root.length + 1), size: f.data.length, mtimeMs: f.mtimeMs, isDir: false });
      }
      return out;
    },
    async stat(abs) {
      const n = (statCounts.get(abs) ?? 0) + 1;
      statCounts.set(abs, n);
      o.onStat?.(abs, n);
      const f = files.get(abs);
      return f ? { path: abs, size: f.data.length, mtimeMs: f.mtimeMs, isDir: false } : null;
    },
    openRange(abs, offset, count, signal) {
      const body = (files.get(abs)?.data ?? Buffer.alloc(0)).subarray(offset, offset + count);
      const stream = new Readable({ read() {} });
      signal.addEventListener("abort", () => stream.destroy(Object.assign(new Error("killed"), { name: "AbortError" })), { once: true });
      void (async () => {
        for (let pos = 0; pos < body.length && !stream.destroyed; pos += chunk) {
          const part = body.subarray(pos, pos + chunk);
          s.ranged.bytes += part.length;
          stream.push(part);
          await tick();
          await o.onChunk?.(s.ranged.bytes);
        }
        if (!stream.destroyed) stream.push(null);
      })();
      return stream;
    },
    async remove(abs) {
      if (s.failRemove) throw s.failRemove;
      s.removed.push(abs);
      files.delete(abs);
    },
    async move(from, to) {
      if (s.failMove) throw s.failMove;
      s.moved.push([from, to]);
      const f = files.get(from);
      if (f) files.set(to, f);
      files.delete(from);
    },
    async close() {},
  };
  if (o.hash) s.hash = async (abs, algo) => o.hash!(abs, algo as string);
  return s;
}

export type HarnessOpts = {
  job?: Partial<JobInput>;
  session?: SessionOpts;
  deps?: Partial<ExecutorDeps>;
  cfg?: Partial<ExecutorDeps["cfg"]>;
  freeBytes?: number;
};
export type RunResult = { state: string; runId: number; row: RunRow };

export function makeHarness(o: HarnessOpts = {}) {
  const base = setup();
  const { stores, jobId } = base;
  const local = mkdtempSync(path.join(tmpdir(), "exec-"));
  dirs.push(local);
  stores.jobs.update(jobId, {
    remotePath: REMOTE_ROOT, localPath: local, settleSeconds: 1, parallelFiles: 2, rangeStreams: 3, retries: 1, ...o.job,
  } as Partial<JobConfig>);
  const session = createTestSession(o.session);
  const engine: TransferEngine = { id: "rclone", capabilities: { hash: false, parallelRanges: true }, testConnection: async () => Promise.reject(new Error("unused")), open: async () => session };
  const clock = { t: 1_000_000_000 };
  const events: AppEvent[] = [];
  const bus = createEventBus();
  bus.subscribe((e) => events.push(e));
  const followups: { jobId: number; at: number }[] = [];
  const slots = createSlots(9);
  const deps: ExecutorDeps = {
    engine, stores, bus, logger: buildLogger("silent", false),
    cfg: { rangeMinBytes: 1000, checkpointBytes: 8192, stallTimeoutMs: 2000, resumeMarginBytes: 1024, ...o.cfg },
    slotsFor: () => slots, throttleFor: () => ({ take: async () => {} }), fileGate: { run: (fn) => fn() },
    reservations: createSpaceReservations(), onFollowup: (j, at) => void followups.push({ jobId: j, at }),
    statfs: async () => ({ bavail: o.freeBytes ?? 1e12, bsize: 1 }), now: () => clock.t, backoff: async () => {}, ...o.deps,
  };
  const executor = createExecutor(deps);
  const exec = async (opts: { dryRun?: boolean; signal?: AbortSignal } = {}): Promise<RunResult> => {
    const runId = stores.runs.create(jobId, "manual", opts.dryRun ?? false);
    const state = await executor(stores.jobs.get(jobId)!, runId, opts.signal ?? new AbortController().signal);
    return { state, runId, row: stores.runs.get(runId)! };
  };
  /** First run records the sighting, the clock advances past settle, the second run transfers. */
  const settled = async (opts: { dryRun?: boolean; signal?: AbortSignal } = {}): Promise<RunResult> => {
    await exec();
    clock.t += 5000;
    return exec(opts);
  };
  const activity = () => stores.activity.list({ limit: 500 }).reverse();
  return { ...base, local, session, clock, events, followups, deps, exec, settled, activity, jobRow: () => stores.jobs.get(jobId)! };
}

export const states = (events: AppEvent[], runId: number): string[] =>
  events.flatMap((e) => (e.type === "run.state" && e.runId === runId ? [e.state] : []));
