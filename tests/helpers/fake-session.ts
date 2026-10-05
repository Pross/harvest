import { Readable } from "node:stream";
import type { EngineSession, RemoteEntry } from "../../src/engine/types.js";

export type RangeCall = { path: string; offset: number; count: number; signal: AbortSignal };
/** What one openRange call should do. Default: deliver exactly the requested bytes. */
export type Behavior = {
  /** Deliver this many bytes fewer than requested, then end cleanly. */
  shortBy?: number;
  /** Append this many 0xEE bytes after the requested bytes. */
  extra?: number;
  /** Never emit anything. */
  hang?: boolean;
  /** Destroy the stream with `error` after `bytes` bytes. */
  failAfter?: { bytes: number; error: Error };
};
export type FakeInit = {
  files: Record<string, Buffer>;
  mtimeMs?: number | null;
  chunkSize?: number;
  behavior?: (call: RangeCall, callIndex: number) => Behavior | undefined;
};
export type FakeSession = EngineSession & {
  calls: RangeCall[];
  statCalls: string[];
  files: Map<string, Buffer>;
  /** Replace a remote file (and optionally its mtime). */
  setFile(path: string, data: Buffer, mtimeMs?: number | null): void;
  setMtime(mtimeMs: number | null): void;
  remove(path: string): Promise<void>;
};

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

export function createFakeSession(init: FakeInit): FakeSession {
  const files = new Map(Object.entries(init.files));
  let mtimeMs: number | null = init.mtimeMs === undefined ? 1000 : init.mtimeMs;
  const chunk = init.chunkSize ?? 4096;
  const calls: RangeCall[] = [];
  const statCalls: string[] = [];

  const feed = async (s: Readable, body: Buffer, b: Behavior): Promise<void> => {
    const limit = b.failAfter ? Math.min(b.failAfter.bytes, body.length) : body.length;
    for (let pos = 0; pos < limit; pos += chunk) {
      if (s.destroyed) return;
      s.push(body.subarray(pos, Math.min(pos + chunk, limit)));
      await tick();
    }
    if (s.destroyed) return;
    if (b.failAfter) s.destroy(b.failAfter.error);
    else s.push(null);
  };

  const session: FakeSession = {
    calls,
    statCalls,
    files,
    setFile(path, data, m) {
      files.set(path, data);
      if (m !== undefined) mtimeMs = m;
    },
    setMtime(m) {
      mtimeMs = m;
    },
    async list() {
      throw new Error("list not used by the downloader");
    },
    async stat(path): Promise<RemoteEntry | null> {
      statCalls.push(path);
      const data = files.get(path);
      return data ? { path, size: data.length, mtimeMs, isDir: false } : null;
    },
    openRange(path, offset, count, signal) {
      const call: RangeCall = { path, offset, count, signal };
      const b = init.behavior?.(call, calls.length) ?? {};
      calls.push(call);
      let body: Buffer = (files.get(path) ?? Buffer.alloc(0)).subarray(offset, offset + count);
      if (b.shortBy) body = body.subarray(0, Math.max(0, body.length - b.shortBy));
      if (b.extra) body = Buffer.concat([body, Buffer.alloc(b.extra, 0xee)]);
      const stream = new Readable({ read() {} });
      signal.addEventListener("abort", () => stream.destroy(Object.assign(new Error("killed"), { name: "AbortError" })), { once: true });
      if (!b.hang) void feed(stream, body, b);
      return stream;
    },
    async remove(path) {
      files.delete(path);
    },
    async move() {},
    async close() {},
  };
  return session;
}

/** Deterministic pseudo-random bytes, so every offset (and so every range) holds distinct content. */
export function makeData(size: number, seed = 1): Buffer {
  const out = Buffer.alloc(size);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}
