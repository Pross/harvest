import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, openSync, writeSync, closeSync, statSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermanentError, TransientNetwork } from "../../src/errors.js";
import { createSlots } from "../../src/run/connection-slots.js";
import { downloadFile, type DownloadFileRequest } from "../../src/run/range-downloader.js";
import { RangeOverrun } from "../../src/run/range-writer.js";
import { verifyComplete } from "../../src/run/verify.js";
import { createFakeSession, makeData, type FakeInit } from "../helpers/fake-session.js";
import { createMemoryPartials } from "../helpers/memory-partials.js";

const REMOTE = "/remote/f.bin";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Opts = { size?: number; behavior?: FakeInit["behavior"]; mtimeMs?: number | null; slotsMax?: number; log?: string[] };
function setup(o: Opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "rd-"));
  dirs.push(dir);
  const data = makeData(o.size ?? 100_003, 7);
  const session = createFakeSession({ files: { [REMOTE]: data }, mtimeMs: o.mtimeMs, chunkSize: 4096, behavior: o.behavior });
  const partials = createMemoryPartials(o.log);
  const slots = createSlots(o.slotsMax ?? 9);
  const staging = path.join(dir, "stage", "f.bin");
  const progress: number[] = [];
  const takes: number[] = [];
  const backoffs: number[] = [];
  const ctrl = new AbortController();
  const base = (over: Partial<DownloadFileRequest> = {}): DownloadFileRequest => ({
    jobId: 1,
    file: { remotePath: "f.bin", size: data.length, mtimeMs: o.mtimeMs === undefined ? 1000 : o.mtimeMs },
    remoteAbsPath: REMOTE,
    stagingPath: staging,
    session,
    partials,
    slots,
    throttle: { take: async (n) => void takes.push(n) },
    rangeStreams: 4,
    rangeMinBytes: 1000,
    checkpointBytes: 8192,
    stallTimeoutMs: 2000,
    resumeMarginBytes: 1024,
    retries: 2,
    backoff: async (a) => void backoffs.push(a),
    signal: ctrl.signal,
    onProgress: (d) => void progress.push(d),
    ...over,
  });
  return { dir, data, session, partials, slots, staging, progress, takes, backoffs, ctrl, base };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const staged = (p: string) => readFileSync(p);
const onceFor = (pred: (n: number) => boolean, b: object) => (_: unknown, n: number) => (pred(n) ? b : undefined);

/** Abort once `bytes` of progress were reported. */
function abortAfter(h: ReturnType<typeof setup>, bytes: number) {
  let seen = 0;
  return (d: number) => {
    h.progress.push(d);
    seen += d;
    if (seen >= bytes) h.ctrl.abort();
  };
}

describe("fresh downloads", () => {
  it("downloads a small file as one range", async () => {
    const h = setup({ size: 500 });
    const res = await downloadFile(h.base());
    expect(res).toEqual({ bytes: 500, resumed: false });
    expect(staged(h.staging).equals(h.data)).toBe(true);
    expect(h.partials.ranges(1)).toHaveLength(1);
  });

  it("uses rangeMinBytes as the single-range threshold", async () => {
    const h = setup({ size: 5000 });
    await downloadFile(h.base({ rangeMinBytes: 5001 }));
    expect(h.partials.ranges(1)).toHaveLength(1);
  });

  it("downloads a large file as equal ranges with exact bytes at every offset", async () => {
    const h = setup({ size: 100_003 });
    await downloadFile(h.base());
    const out = staged(h.staging);
    expect(out.length).toBe(h.data.length);
    expect(sha(out)).toBe(sha(h.data));
    const ranges = h.partials.ranges(1);
    expect(ranges).toHaveLength(4);
    expect(ranges.map((r) => r.endByte - r.startByte)).toEqual([25000, 25000, 25000, 25003]);
    for (const r of ranges) {
      expect(out.subarray(r.startByte, r.endByte).equals(h.data.subarray(r.startByte, r.endByte))).toBe(true);
    }
    for (let i = 0; i < out.length; i += 997) expect(out[i]).toBe(h.data[i]);
  });

  it("each range gets distinct content (ranges are not mixed up)", async () => {
    const h = setup({ size: 40_000 });
    await downloadFile(h.base({ rangeStreams: 4 }));
    const ranges = h.partials.ranges(1);
    const hashes = new Set(ranges.map((r) => sha(staged(h.staging).subarray(r.startByte, r.endByte))));
    expect(hashes.size).toBe(4);
  });

  it("opens each range at its start with its length and the remote path", async () => {
    const h = setup({ size: 40_000 });
    await downloadFile(h.base());
    const calls = [...h.session.calls].sort((a, b) => a.offset - b.offset);
    expect(calls.map((c) => [c.offset, c.count])).toEqual([[0, 10000], [10000, 10000], [20000, 10000], [30000, 10000]]);
    expect(calls.every((c) => c.path === REMOTE)).toBe(true);
  });

  it("makes every range's durable_bytes equal its length and passes verifyComplete", async () => {
    const h = setup();
    await downloadFile(h.base());
    expect(() => verifyComplete(h.partials, 1, h.data.length)).not.toThrow();
  });

  it("handles an empty file", async () => {
    const h = setup({ size: 0 });
    const res = await downloadFile(h.base());
    expect(res.bytes).toBe(0);
    expect(statSync(h.staging).size).toBe(0);
    expect(() => verifyComplete(h.partials, 1, 0)).not.toThrow();
  });

  it("handles a file smaller than the number of streams", async () => {
    const h = setup({ size: 3 });
    await downloadFile(h.base({ rangeMinBytes: 1 }));
    expect(h.partials.ranges(1)).toHaveLength(3);
    expect(staged(h.staging).equals(h.data)).toBe(true);
  });

  it("does not stat the remote on a fresh start", async () => {
    const h = setup();
    await downloadFile(h.base());
    expect(h.session.statCalls).toEqual([]);
  });

  it("progress deltas sum to the file size", async () => {
    const h = setup();
    await downloadFile(h.base());
    expect(sum(h.progress)).toBe(h.data.length);
  });

  it("calls throttle.take with each chunk size before writing", async () => {
    const h = setup({ size: 10_000 });
    await downloadFile(h.base({ rangeStreams: 1 }));
    expect(sum(h.takes)).toBe(10_000);
    // Stream chunking depends on event-loop timing under load: assert bounds, not exact splits.
    expect(h.takes.every((n) => n > 0)).toBe(true);
    expect(h.takes[0]).toBe(4096);
  });

  it("shrinks the range count to the granted slots", async () => {
    const h = setup({ slotsMax: 3 }); // file capacity 2
    await downloadFile(h.base({ rangeStreams: 8 }));
    expect(h.partials.ranges(1)).toHaveLength(2);
    expect(sha(staged(h.staging))).toBe(sha(h.data));
  });

  it("waits for a free slot and releases its slots afterwards", async () => {
    const h = setup({ slotsMax: 3 });
    const hold = await h.slots.acquire(2, h.ctrl.signal);
    let done = false;
    const p = downloadFile(h.base()).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    hold();
    await p;
    expect(h.slots.freeForFiles()).toBe(2);
  });

  it("replaces stale staging garbage when starting fresh", async () => {
    const h = setup({ size: 20_000 });
    await fsp.mkdir(path.dirname(h.staging), { recursive: true });
    writeFileSync(h.staging, Buffer.alloc(50_000, 0xab));
    await downloadFile(h.base());
    expect(staged(h.staging).equals(h.data)).toBe(true);
  });
});

describe("checkpoints", () => {
  it("fsyncs before every partials.checkpoint, and snapshots never exceed what is on disk", async () => {
    const log: string[] = [];
    const h = setup({ log });
    const probe = await fsp.open(path.join(h.dir, "probe"), "w");
    const proto = Object.getPrototypeOf(probe);
    await probe.close();
    const orig = proto.sync;
    vi.spyOn(proto, "sync").mockImplementation(async function (this: unknown) {
      log.push("fsync");
      return orig.call(this);
    });
    h.partials.onCheckpoint = (_id, snaps) => {
      const disk = staged(h.staging);
      const ranges = h.partials.ranges(1);
      for (const s of snaps) {
        const r = ranges.find((x) => x.idx === s.idx)!;
        const a = disk.subarray(r.startByte, r.startByte + s.durableBytes);
        expect(a.equals(h.data.subarray(r.startByte, r.startByte + s.durableBytes))).toBe(true);
      }
    };
    await downloadFile(h.base());
    const cps = log.filter((e) => e === "checkpoint").length;
    expect(cps).toBeGreaterThanOrEqual(2);
    const events = log.filter((e) => e !== "create");
    events.forEach((e, i) => {
      if (e === "checkpoint") expect(events[i - 1]).toBe("fsync");
    });
    expect(events.at(-1)).toBe("checkpoint");
  });

  it("checkpoints roughly every checkpointBytes across the whole file", async () => {
    const h = setup({ size: 64 * 1024 });
    const probe = await fsp.open(path.join(h.dir, "probe"), "w");
    vi.spyOn(Object.getPrototypeOf(probe), "sync").mockResolvedValue(undefined);
    await probe.close();
    await downloadFile(h.base({ checkpointBytes: 16 * 1024 }));
    expect(h.partials.checkpoints.length).toBeGreaterThanOrEqual(3);
    expect(h.partials.checkpoints.length).toBeLessThanOrEqual(6);
  });

  it("every checkpoint snapshots every range", async () => {
    const h = setup();
    await downloadFile(h.base());
    for (const c of h.partials.checkpoints) expect(c.snapshots.map((s) => s.idx).sort()).toEqual([0, 1, 2, 3]);
  });

  it("never lowers a stored durable_bytes between checkpoints", async () => {
    const h = setup({ size: 60_000 });
    await downloadFile(h.base({ rangeStreams: 2 }));
    const last = new Map<number, number>();
    for (const c of h.partials.checkpoints) {
      for (const s of c.snapshots) {
        expect(s.durableBytes).toBeGreaterThanOrEqual(last.get(s.idx) ?? 0);
        last.set(s.idx, s.durableBytes);
      }
    }
  });

  it("fails the file when the checkpoint store throws", async () => {
    const h = setup();
    h.partials.onCheckpoint = () => {
      throw new PermanentError("db locked");
    };
    await expect(downloadFile(h.base())).rejects.toThrow("db locked");
  });
});

describe("kill and resume", () => {
  it("resumes from durable minus the margin and produces the correct file", async () => {
    const h = setup({ size: 200_000 });
    await expect(downloadFile(h.base({ onProgress: abortAfter(h, 90_000) }))).rejects.toThrow(/abort/i);
    expect(h.partials.discards).toEqual([]);
    const before = h.partials.ranges(1);
    expect(before.some((r) => r.durableBytes > 0)).toBe(true);
    h.session.calls.length = 0;
    const ctrl2 = new AbortController();
    const res = await downloadFile(h.base({ signal: ctrl2.signal }));
    expect(res.resumed).toBe(true);
    expect(sha(staged(h.staging))).toBe(sha(h.data));
    for (const r of before) {
      const call = h.session.calls.find((c) => c.offset >= r.startByte && c.offset < r.endByte);
      if (r.durableBytes === r.endByte - r.startByte) expect(call).toBeUndefined();
      else expect(call!.offset).toBe(r.startByte + Math.max(0, r.durableBytes - 1024));
    }
  });

  it("re-fetches a bounded amount on resume", async () => {
    const h = setup({ size: 200_000 });
    await expect(downloadFile(h.base({ onProgress: abortAfter(h, 120_000) }))).rejects.toThrow();
    const durable = sum(h.partials.ranges(1).map((r) => r.durableBytes));
    h.session.calls.length = 0;
    await downloadFile(h.base({ signal: new AbortController().signal }));
    const fetched = sum(h.session.calls.map((c) => c.count));
    expect(fetched).toBeGreaterThanOrEqual(200_000 - durable);
    expect(fetched).toBeLessThanOrEqual(200_000 - durable + 4 * 1024);
  });

  it("uses a 1 MiB margin by default", async () => {
    const size = 4 * 1024 * 1024;
    const h = setup({ size });
    const req = (over: Partial<DownloadFileRequest>) => ({ ...h.base(over), resumeMarginBytes: undefined, rangeStreams: 1, checkpointBytes: 256 * 1024 });
    await expect(downloadFile(req({ onProgress: abortAfter(h, 3 * 1024 * 1024) }))).rejects.toThrow();
    const durable = h.partials.ranges(1)[0]!.durableBytes;
    // How far fsync checkpoints got before the abort depends on load, so assert the formula, not a value.
    h.session.calls.length = 0;
    await downloadFile(req({ signal: new AbortController().signal }));
    expect(h.session.calls[0]!.offset).toBe(Math.max(0, durable - 1024 * 1024));
    expect(sha(staged(h.staging))).toBe(sha(h.data));
  });

  it("survives a torn tail: garbage beyond durable_bytes in the staging file", async () => {
    const h = setup({ size: 200_000 });
    await expect(downloadFile(h.base({ onProgress: abortAfter(h, 100_000) }))).rejects.toThrow();
    const fd = openSync(h.staging, "r+");
    for (const r of h.partials.ranges(1)) {
      const from = r.startByte + r.durableBytes;
      writeSync(fd, Buffer.alloc(Math.min(r.endByte, from + 30_000) - from, 0xff), 0, Math.min(r.endByte, from + 30_000) - from, from);
    }
    closeSync(fd);
    await downloadFile(h.base({ signal: new AbortController().signal }));
    expect(sha(staged(h.staging))).toBe(sha(h.data));
  });

  it("survives garbage with a zero margin as well", async () => {
    const h = setup({ size: 50_000 });
    await expect(downloadFile(h.base({ resumeMarginBytes: 0, onProgress: abortAfter(h, 20_000) }))).rejects.toThrow();
    const fd = openSync(h.staging, "r+");
    for (const r of h.partials.ranges(1)) {
      const n = Math.min(4096, r.endByte - r.startByte - r.durableBytes);
      if (n > 0) writeSync(fd, Buffer.alloc(n, 0x55), 0, n, r.startByte + r.durableBytes);
    }
    closeSync(fd);
    await downloadFile(h.base({ resumeMarginBytes: 0, signal: new AbortController().signal }));
    expect(sha(staged(h.staging))).toBe(sha(h.data));
  });

  it("leaves the partial resumable after an abort and releases the slots", async () => {
    const h = setup();
    await expect(downloadFile(h.base({ onProgress: abortAfter(h, 30_000) }))).rejects.toThrow(/abort/i);
    expect(h.partials.get(1, "f.bin")).toBeDefined();
    expect(h.partials.discards).toEqual([]);
    expect(h.slots.freeForFiles()).toBe(h.slots.capacity);
  });

  it("an abort stops all ranges promptly", async () => {
    const h = setup({ size: 2_000_000 });
    const t0 = Date.now();
    await expect(downloadFile(h.base({ onProgress: abortAfter(h, 40_000) }))).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(h.session.calls.every((c) => c.signal.aborted)).toBe(true);
  });

  it("rejects without touching the session when already aborted", async () => {
    const h = setup();
    h.ctrl.abort();
    await expect(downloadFile(h.base())).rejects.toThrow(/abort/i);
    expect(h.session.calls).toEqual([]);
  });

  it("returns immediately when every range is already durable", async () => {
    const h = setup({ size: 1000 });
    await fsp.mkdir(path.dirname(h.staging), { recursive: true });
    writeFileSync(h.staging, h.data);
    const row = h.partials.create(
      { jobId: 1, remotePath: "f.bin", remoteSize: 1000, remoteMtimeMs: 1000, stagingPath: h.staging },
      [{ idx: 0, startByte: 0, endByte: 1000 }],
    );
    h.partials.checkpoint(row.id, [{ idx: 0, durableBytes: 1000 }]);
    const res = await downloadFile(h.base());
    expect(res).toEqual({ bytes: 1000, resumed: true });
    expect(h.session.calls).toEqual([]);
  });
});

describe("change guard", () => {
  async function interrupted(h: ReturnType<typeof setup>) {
    await expect(downloadFile(h.base({ onProgress: abortAfter(h, 30_000) }))).rejects.toThrow();
    h.session.calls.length = 0;
  }

  it("discards the partial and restarts when the remote size changed", async () => {
    const h = setup({ size: 100_000 });
    await interrupted(h);
    const bigger = makeData(120_000, 99);
    h.session.setFile(REMOTE, bigger);
    const res = await downloadFile(h.base({ file: { remotePath: "f.bin", size: 120_000, mtimeMs: 1000 }, signal: new AbortController().signal }));
    expect(res.resumed).toBe(false);
    expect(h.partials.discards).toEqual([1]);
    expect(sha(staged(h.staging))).toBe(sha(bigger));
  });

  it("discards when only the fresh stat differs from the recorded size", async () => {
    const h = setup({ size: 100_000 });
    await interrupted(h);
    h.session.setFile(REMOTE, makeData(100_001, 5));
    const res = await downloadFile(h.base({ signal: new AbortController().signal }));
    expect(res.resumed).toBe(false);
    expect(h.partials.discards).toHaveLength(1);
  });

  it("discards and restarts when the mtime changed", async () => {
    const h = setup({ size: 100_000 });
    await interrupted(h);
    const replaced = makeData(100_000, 42);
    h.session.setFile(REMOTE, replaced, 2000);
    const res = await downloadFile(h.base({ file: { remotePath: "f.bin", size: 100_000, mtimeMs: 2000 }, signal: new AbortController().signal }));
    expect(res.resumed).toBe(false);
    expect(h.partials.discards).toHaveLength(1);
    expect(h.session.calls.map((c) => c.offset).sort((a, b) => a - b)[0]).toBe(0);
    expect(sha(staged(h.staging))).toBe(sha(replaced));
  });

  it("compares size only when the recorded mtime is null", async () => {
    const h = setup({ size: 100_000, mtimeMs: null });
    await interrupted(h);
    h.session.setMtime(5555);
    const res = await downloadFile(h.base({ signal: new AbortController().signal }));
    expect(res.resumed).toBe(true);
    expect(h.partials.discards).toEqual([]);
    expect(sha(staged(h.staging))).toBe(sha(h.data));
  });

  it("still discards on a size change when the recorded mtime is null", async () => {
    const h = setup({ size: 100_000, mtimeMs: null });
    await interrupted(h);
    h.session.setFile(REMOTE, makeData(90_000, 3));
    const res = await downloadFile(h.base({ file: { remotePath: "f.bin", size: 90_000, mtimeMs: null }, signal: new AbortController().signal }));
    expect(res.resumed).toBe(false);
    expect(h.partials.discards).toHaveLength(1);
  });

  it("throws PermanentError when the remote file vanished, dropping the partial", async () => {
    const h = setup({ size: 100_000 });
    await interrupted(h);
    await h.session.remove(REMOTE);
    await expect(downloadFile(h.base({ signal: new AbortController().signal }))).rejects.toBeInstanceOf(PermanentError);
    expect(h.partials.get(1, "f.bin")).toBeUndefined();
    expect(existsSync(h.staging)).toBe(false);
  });

  it("discards when the staging file is gone", async () => {
    const h = setup({ size: 100_000 });
    await interrupted(h);
    rmSync(h.staging);
    const res = await downloadFile(h.base({ signal: new AbortController().signal }));
    expect(res.resumed).toBe(false);
    expect(sha(staged(h.staging))).toBe(sha(h.data));
  });

  it("stats the remote path handed to the session exactly once on resume", async () => {
    const h = setup({ size: 100_000 });
    await interrupted(h);
    await downloadFile(h.base({ signal: new AbortController().signal }));
    expect(h.session.statCalls).toEqual([REMOTE]);
  });
});

describe("range completeness", () => {
  it("retries a stream that ends early from the last durable point and completes", async () => {
    let durableAtRetry = -1;
    let hp: ReturnType<typeof createMemoryPartials> | undefined;
    const h = setup({
      size: 40_000,
      behavior: (_c, n) => {
        if (n === 1) durableAtRetry = hp!.checkpoints.at(-1)?.snapshots[0]?.durableBytes ?? 0;
        return n === 0 ? { shortBy: 3000 } : undefined;
      },
    });
    hp = h.partials;
    const probe = await fsp.open(path.join(h.dir, "probe"), "w");
    vi.spyOn(Object.getPrototypeOf(probe), "sync").mockResolvedValue(undefined);
    await probe.close();
    await downloadFile(h.base({ rangeStreams: 1, checkpointBytes: 4096 }));
    expect(h.session.calls).toHaveLength(2);
    expect(h.backoffs).toEqual([0]);
    expect(staged(h.staging).equals(h.data)).toBe(true);
    expect(durableAtRetry).toBeGreaterThan(0);
    expect(h.session.calls[1]!.offset).toBe(Math.max(0, durableAtRetry - 1024));
  });

  it("fails with TransientNetwork after exhausting retries on short streams", async () => {
    const h = setup({ size: 10_000, behavior: () => ({ shortBy: 1 }) });
    await expect(downloadFile(h.base({ rangeStreams: 1, retries: 2 }))).rejects.toBeInstanceOf(TransientNetwork);
    expect(h.session.calls).toHaveLength(3);
    expect(h.backoffs).toEqual([0, 1]);
  });

  it("retries a transient stream error mid-range", async () => {
    const h = setup({ size: 40_000, behavior: onceFor((n) => n === 0, { failAfter: { bytes: 20_000, error: new TransientNetwork("reset") } }) });
    await downloadFile(h.base({ rangeStreams: 1 }));
    expect(staged(h.staging).equals(h.data)).toBe(true);
    expect(h.session.calls).toHaveLength(2);
  });

  it("treats a stream that sends more than the range as an error and keeps the neighbour intact", async () => {
    const h = setup({ size: 40_000, behavior: (c) => (c.offset === 0 ? { extra: 5000 } : undefined) });
    await expect(downloadFile(h.base({ rangeStreams: 2, retries: 3 }))).rejects.toBeInstanceOf(RangeOverrun);
    expect(h.backoffs).toEqual([]);
    const disk = staged(h.staging);
    for (let i = 20_000; i < 40_000; i++) expect(disk[i] === 0 || disk[i] === h.data[i]).toBe(true);
    expect(disk.length).toBe(40_000);
  });

  it("never judges completeness from the pre-sized staging file", async () => {
    const h = setup({ size: 10_000, behavior: () => ({ hang: true }) });
    await expect(downloadFile(h.base({ rangeStreams: 1, retries: 0, stallTimeoutMs: 20 }))).rejects.toBeInstanceOf(TransientNetwork);
    expect(statSync(h.staging).size).toBe(10_000);
    expect(h.partials.ranges(1)[0]!.durableBytes).toBe(0);
    expect(() => verifyComplete(h.partials, 1, 10_000)).toThrow();
  });
});

describe("stall watchdog and failures", () => {
  it("aborts a never-emitting stream and retries it", async () => {
    const h = setup({ size: 20_000, behavior: onceFor((n) => n === 0, { hang: true }) });
    await downloadFile(h.base({ rangeStreams: 1, stallTimeoutMs: 30 }));
    expect(h.session.calls).toHaveLength(2);
    expect(h.session.calls[0]!.signal.aborted).toBe(true);
    expect(h.backoffs).toEqual([0]);
    expect(staged(h.staging).equals(h.data)).toBe(true);
  });

  it("fails with TransientNetwork when every attempt stalls", async () => {
    const h = setup({ size: 20_000, behavior: () => ({ hang: true }) });
    await expect(downloadFile(h.base({ rangeStreams: 1, retries: 1, stallTimeoutMs: 20 }))).rejects.toThrow(/stalled/);
    expect(h.session.calls).toHaveLength(2);
  });

  it("does not count time spent waiting on the throttle as a stall", async () => {
    const h = setup({ size: 8192 });
    const slow = { take: () => new Promise<void>((r) => setTimeout(r, 120)) };
    await downloadFile(h.base({ rangeStreams: 1, stallTimeoutMs: 60, throttle: slow }));
    expect(h.session.calls).toHaveLength(1);
  });

  it("fails fast on a non-transient error and aborts sibling ranges", async () => {
    const h = setup({
      size: 40_000,
      behavior: (c) => (c.offset === 0 ? { failAfter: { bytes: 5000, error: new PermanentError("denied") } } : { hang: true }),
    });
    const t0 = Date.now();
    await expect(downloadFile(h.base({ rangeStreams: 2, retries: 5, stallTimeoutMs: 5000 }))).rejects.toThrow("denied");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(h.backoffs).toEqual([]);
    expect(h.session.calls.every((c) => c.signal.aborted)).toBe(true);
    expect(h.slots.freeForFiles()).toBe(h.slots.capacity);
  });

  it("does not retry a plain Error from the stream", async () => {
    const h = setup({ size: 10_000, behavior: () => ({ failAfter: { bytes: 100, error: new Error("boom") } }) });
    await expect(downloadFile(h.base({ rangeStreams: 1 }))).rejects.toThrow("boom");
    expect(h.session.calls).toHaveLength(1);
  });

  it("propagates an onProgress error", async () => {
    const h = setup();
    await expect(downloadFile(h.base({ onProgress: () => { throw new Error("ui"); } }))).rejects.toThrow("ui");
  });

  it("aborts during backoff promptly", async () => {
    const h = setup({ size: 10_000, behavior: () => ({ shortBy: 1 }) });
    const backoff = (_: number, s?: AbortSignal) => new Promise<void>((_r, rej) => s?.addEventListener("abort", () => rej(new Error("aborted in backoff"))));
    const p = downloadFile(h.base({ rangeStreams: 1, backoff }));
    setTimeout(() => h.ctrl.abort(), 30);
    await expect(p).rejects.toThrow(/abort/i);
  });
});

describe("interrupted promote and connection slots", () => {
  it("treats a file whose staging is gone and whose final file has the expected size as promoted: no stat, no download", async () => {
    const h = setup({ size: 3000 });
    const final = path.join(h.dir, "final.bin");
    writeFileSync(final, h.data);
    const row = h.partials.create({ jobId: 1, remotePath: "f.bin", remoteSize: 3000, remoteMtimeMs: 1000, stagingPath: h.staging }, [{ idx: 0, startByte: 0, endByte: 3000 }]);
    h.partials.setPromoting(row.id, final);
    const res = await downloadFile(h.base());
    expect(res).toMatchObject({ promoted: true, resumed: true });
    expect(h.session.calls).toHaveLength(0);
    expect(h.session.statCalls).toHaveLength(0);
    expect(h.partials.discards).toEqual([]);
  });

  it("still re-downloads when the final file has the wrong size", async () => {
    const h = setup({ size: 3000 });
    const final = path.join(h.dir, "final.bin");
    writeFileSync(final, "short");
    const row = h.partials.create({ jobId: 1, remotePath: "f.bin", remoteSize: 3000, remoteMtimeMs: 1000, stagingPath: h.staging }, [{ idx: 0, startByte: 0, endByte: 3000 }]);
    h.partials.setPromoting(row.id, final);
    const res = await downloadFile(h.base());
    expect(res.promoted).toBeUndefined();
    expect(staged(h.staging).equals(h.data)).toBe(true);
  });

  it("takes a connection slot for the partial-reuse stat and releases it", async () => {
    const h = setup({ size: 3000 });
    await downloadFile(h.base({ signal: new AbortController().signal }));
    const used: number[] = [];
    const acquireOne = h.slots.acquireOne.bind(h.slots);
    h.slots.acquireOne = async (sig) => { const r = await acquireOne(sig); used.push(1); return r; };
    const statSpy = h.session.stat.bind(h.session);
    let heldAtStat = -1;
    h.session.stat = async (p) => { heldAtStat = used.length; return statSpy(p); };
    await downloadFile(h.base());
    expect(heldAtStat).toBe(1);
  });
});

