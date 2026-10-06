import { existsSync, readFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostKeyChanged, TransientNetwork } from "../../src/errors.js";
import { makeData } from "../helpers/fake-session.js";
import { makeHarness, states } from "./executor-harness.js";

const read = (p: string) => readFileSync(p);
afterEach(() => vi.restoreAllMocks());

describe("executor happy paths", () => {
  it("syncs a single file through the full state sequence", async () => {
    const h = makeHarness();
    const data = makeData(50_000, 1);
    h.session.set("movie.mkv", data);
    const first = await h.exec();
    expect(first.state).toBe("succeeded");
    expect(existsSync(path.join(h.local, "movie.mkv"))).toBe(false);
    h.clock.t += 5000;
    const r = await h.exec();
    expect(r.state).toBe("succeeded");
    expect(read(path.join(h.local, "movie.mkv")).equals(data)).toBe(true);
    expect(states(h.events, r.runId)).toEqual(["connecting", "listing", "planning", "awaiting_space", "transferring", "verifying", "finalizing", "succeeded"]);
  });

  it("counts files and bytes correctly", async () => {
    const h = makeHarness();
    h.session.set("a.bin", makeData(30_000, 1));
    h.session.set("b.bin", makeData(12_345, 2));
    const r = await h.settled();
    expect(r.row).toMatchObject({ filesPlanned: 2, filesOk: 2, filesFailed: 0, bytesDone: 42_345, bytesTotal: 42_345, state: "succeeded" });
    expect(h.stores.runs.filesForRun(r.runId).map((f) => f.state)).toEqual(["done", "done"]);
  });

  it("commits ledger rows with size and mtime", async () => {
    const h = makeHarness();
    h.session.set("a.bin", makeData(2000, 1), 777);
    await h.settled();
    expect(h.stores.ledger.active(h.jobId).get("a.bin")).toMatchObject({ size: 2000, mtimeMs: 777 });
    expect(h.stores.partials.get(h.jobId, "a.bin")).toBeUndefined();
  });

  it("promotes a season pack as one directory with ledger rows for every file", async () => {
    const h = makeHarness();
    const files = { "Show.S01/e1.mkv": makeData(20_000, 1), "Show.S01/e2.mkv": makeData(21_000, 2), "Show.S01/sub/e1.srt": makeData(900, 3) };
    for (const [p, d] of Object.entries(files)) h.session.set(p, d);
    const r = await h.settled();
    expect(r.state).toBe("succeeded");
    for (const [p, d] of Object.entries(files)) expect(read(path.join(h.local, p)).equals(d)).toBe(true);
    expect([...h.stores.ledger.active(h.jobId).keys()].sort()).toEqual(Object.keys(files).sort());
    expect(h.stores.ledger.completedUnits(h.jobId).has("Show.S01")).toBe(true);
    expect(existsSync(path.join(h.local, ".harvest-staging", String(h.jobId), "Show.S01"))).toBe(false);
  });

  it("does not re-download a file the user deleted locally", async () => {
    const h = makeHarness();
    h.session.set("a.bin", makeData(20_000, 1));
    await h.settled();
    await fsp.rm(path.join(h.local, "a.bin"));
    const before = h.session.ranged.bytes;
    h.clock.t += 5000;
    const r = await h.exec();
    expect(r.state).toBe("succeeded");
    expect(h.session.ranged.bytes).toBe(before);
    expect(existsSync(path.join(h.local, "a.bin"))).toBe(false);
  });

  it("holds a growing file until it has settled across successive runs", async () => {
    const h = makeHarness({ job: { settleSeconds: 10 } });
    h.session.set("g.bin", makeData(10_000, 1));
    await h.exec();
    h.clock.t += 11_000;
    h.session.set("g.bin", makeData(15_000, 1));
    expect((await h.exec()).row.bytesDone).toBe(0);
    h.clock.t += 5000;
    expect((await h.exec()).row.bytesDone).toBe(0);
    expect(existsSync(path.join(h.local, "g.bin"))).toBe(false);
    h.clock.t += 6000;
    const r = await h.exec();
    expect(r.row.filesOk).toBe(1);
    expect(read(path.join(h.local, "g.bin")).length).toBe(15_000);
  });

  it("still syncs a pack when an .nfo and a Sample dir are excluded", async () => {
    const h = makeHarness({ job: { excludeGlobs: ["**/*.nfo", "**/Sample/**"] } });
    h.session.set("Pack/a.mkv", makeData(5000, 1));
    h.session.set("Pack/a.nfo", makeData(100, 2));
    h.session.set("Pack/Sample/s.mkv", makeData(300, 3));
    const r = await h.settled();
    expect(r.state).toBe("succeeded");
    expect(existsSync(path.join(h.local, "Pack/a.mkv"))).toBe(true);
    expect(existsSync(path.join(h.local, "Pack/a.nfo"))).toBe(false);
    expect(existsSync(path.join(h.local, "Pack/Sample"))).toBe(false);
  });

  it("promotes a file added to an already synced pack into the existing directory", async () => {
    const h = makeHarness();
    h.session.set("Pack/a.mkv", makeData(5000, 1));
    await h.settled();
    h.session.set("Pack/b.mkv", makeData(6000, 2));
    await h.exec();
    h.clock.t += 5000;
    const r = await h.exec();
    expect(r.row.filesOk).toBe(1);
    expect(read(path.join(h.local, "Pack/b.mkv")).length).toBe(6000);
    expect(read(path.join(h.local, "Pack/a.mkv")).length).toBe(5000);
    expect(h.stores.ledger.active(h.jobId).size).toBe(2);
    expect((await fsp.readdir(path.join(h.local, "Pack"))).sort()).toEqual(["a.mkv", "b.mkv"]);
  });

  it("uses per-file units when unitMode is file", async () => {
    const h = makeHarness({ job: { unitMode: "file" } });
    h.session.set("d/a.bin", makeData(3000, 1));
    h.session.set("d/b.bin", makeData(3000, 2));
    await h.settled();
    expect([...h.stores.ledger.completedUnits(h.jobId)].sort()).toEqual(["d/a.bin", "d/b.bin"]);
    expect(read(path.join(h.local, "d/a.bin")).length).toBe(3000);
  });

  it("downloads a large file in several ranges and verifies it", async () => {
    const h = makeHarness();
    const data = makeData(300_000, 9);
    h.session.set("big.bin", data);
    await h.settled();
    expect(read(path.join(h.local, "big.bin")).equals(data)).toBe(true);
  });

  it("runs files of a unit in parallel up to parallelFiles", async () => {
    let active = 0;
    let peak = 0;
    const h = makeHarness({ job: { parallelFiles: 2 }, deps: { fileGate: { run: async (fn) => { active++; peak = Math.max(peak, active); try { return await fn(); } finally { active--; } } } } });
    for (const n of ["a", "b", "c", "d"]) h.session.set(`P/${n}.bin`, makeData(20_000, n.charCodeAt(0)));
    const r = await h.settled();
    expect(r.state).toBe("succeeded");
    expect(peak).toBe(2);
  });

  it("emits run.progress events and an activity row per unit and run", async () => {
    const h = makeHarness();
    h.session.set("P/a.bin", makeData(20_000, 1));
    await h.settled();
    expect(h.events.some((e) => e.type === "run.progress" && e.bytesDone === 20_000 && e.bytesTotal === 20_000)).toBe(true);
    const sums = h.activity().map((a) => a.summary);
    expect(sums.some((s) => s.startsWith("Synced P"))).toBe(true);
    expect(sums.some((s) => s.startsWith("Run started"))).toBe(true);
    expect(sums.some((s) => s.includes("succeeded"))).toBe(true);
  });
});

describe("executor planning and observations", () => {
  it("persists observations and schedules one followup on first sighting", async () => {
    const h = makeHarness();
    h.session.set("a.bin", makeData(1000, 1));
    await h.exec();
    expect(h.stores.observations.all(h.jobId).has("a.bin")).toBe(true);
    expect(h.followups).toEqual([{ jobId: h.jobId, at: h.clock.t + 1000 }]);
  });

  it("removes observations of vanished files", async () => {
    const h = makeHarness();
    h.session.set("a.bin", makeData(1000, 1));
    await h.exec();
    h.session.files.clear();
    await h.exec();
    expect(h.stores.observations.all(h.jobId).size).toBe(0);
  });

  it("skips a hostile remote path and still syncs the rest", async () => {
    const h = makeHarness();
    h.session.files.set("/remote/../../harvest-escape-probe/passwd", { data: makeData(100, 1), mtimeMs: 1 });
    h.session.set("ok.bin", makeData(1000, 2));
    const r = await h.settled();
    expect(r.state).toBe("succeeded");
    expect(r.row.filesSkipped).toBeGreaterThanOrEqual(1);
    expect(existsSync(path.join(h.local, "ok.bin"))).toBe(true);
    expect(existsSync(path.join(h.local, "..", "..", "harvest-escape-probe"))).toBe(false);
  });

  it("succeeds with nothing to do on an empty listing", async () => {
    const h = makeHarness();
    const r = await h.exec();
    expect(r.state).toBe("succeeded");
    expect(h.activity().some((a) => a.summary.includes("Nothing to do"))).toBe(true);
  });
});

describe("executor failure handling", () => {
  it("fails the run on a listing error and never plans or deletes", async () => {
    const h = makeHarness({ job: { afterSync: "delete" } });
    h.session.set("a.bin", makeData(1000, 1));
    await h.exec();
    h.session.failList = new TransientNetwork("lsjson exited 3");
    h.clock.t += 5000;
    const r = await h.exec();
    expect(r.state).toBe("failed");
    expect(r.row.error).toContain("lsjson exited 3");
    expect(h.session.removed).toEqual([]);
    expect(h.stores.observations.all(h.jobId).get("a.bin")?.lastSeenAt).toBeLessThan(h.clock.t);
  });

  it("fails the run when the engine cannot connect", async () => {
    const h = makeHarness({ deps: { engine: { id: "rclone", capabilities: { hash: false, parallelRanges: true }, testConnection: async () => Promise.reject(new Error("x")), open: async () => Promise.reject(new TransientNetwork("connect refused")) } } });
    const r = await h.exec();
    expect(r.state).toBe("failed");
    expect(r.row.error).toContain("connect refused");
  });

  it("records a host key change loudly and fails", async () => {
    const h = makeHarness({ deps: { engine: { id: "rclone", capabilities: { hash: false, parallelRanges: true }, testConnection: async () => Promise.reject(new Error("x")), open: async () => Promise.reject(new HostKeyChanged("key mismatch")) } } });
    const r = await h.exec();
    expect(r.state).toBe("failed");
    expect(h.activity().some((a) => a.category === "host-key" && a.severity === "error")).toBe(true);
  });

  it("fails with a clear error when staging is on another device", async () => {
    const h = makeHarness({ deps: { sameDevice: async () => false } });
    h.session.set("a.bin", makeData(1000, 1));
    const r = await h.settled();
    expect(r.state).toBe("failed");
    expect(r.row.error).toMatch(/different filesystem/);
    expect(h.session.ranged.bytes).toBe(0);
  });

  it("one failing unit does not abort its siblings (partial)", async () => {
    const h = makeHarness({ job: { retries: 0 } });
    h.session.set("Bad/a.bin", makeData(5000, 1));
    h.session.set("Good/a.bin", makeData(5000, 2));
    const open = h.session.openRange.bind(h.session);
    h.session.openRange = (abs, off, count, signal) => {
      if (abs.includes("Bad")) throw new Error("permission denied");
      return open(abs, off, count, signal);
    };
    const r = await h.settled();
    expect(r.state).toBe("partial");
    expect(r.row).toMatchObject({ filesOk: 1, filesFailed: 1 });
    expect(existsSync(path.join(h.local, "Good/a.bin"))).toBe(true);
    expect(existsSync(path.join(h.local, "Bad"))).toBe(false);
    expect(h.activity().some((a) => a.category === "file" && a.summary.includes("permission denied"))).toBe(true);
  });

  it("marks the whole run failed when every unit fails", async () => {
    const h = makeHarness({ job: { retries: 0 } });
    h.session.set("A/a.bin", makeData(5000, 1));
    h.session.openRange = () => { throw new Error("boom"); };
    const r = await h.settled();
    expect(r.state).toBe("failed");
    expect(r.row.filesFailed).toBe(1);
  });

  it("holds sibling files of a unit when one file fails (unit not promoted)", async () => {
    const h = makeHarness({ job: { retries: 0 } });
    h.session.set("P/a.bin", makeData(5000, 1));
    h.session.set("P/b.bin", makeData(5000, 2));
    const open = h.session.openRange.bind(h.session);
    h.session.openRange = (abs, off, count, signal) => {
      if (abs.endsWith("b.bin")) throw new Error("nope");
      return open(abs, off, count, signal);
    };
    const r = await h.settled();
    expect(r.state).toBe("failed");
    expect(r.row).toMatchObject({ filesFailed: 1, filesSkipped: 1 });
    expect(existsSync(path.join(h.local, "P"))).toBe(false);
    expect(h.stores.ledger.active(h.jobId).size).toBe(0);
  });
});

describe("executor cancellation and resume", () => {
  it("cancel mid-download leaves a resumable partial and state cancelled", async () => {
    const ctrl = new AbortController();
    const h = makeHarness({ session: { onChunk: (sent) => void (sent >= 100_000 && ctrl.abort()) }, cfg: { checkpointBytes: 4096 } });
    const data = makeData(200_000, 5);
    h.session.set("big.bin", data);
    const r = await h.settled({ signal: ctrl.signal });
    expect(r.state).toBe("cancelled");
    expect(r.row.finishedAt).not.toBeNull();
    expect(h.stores.partials.get(h.jobId, "big.bin")).toBeDefined();
    expect(existsSync(path.join(h.local, ".harvest-staging", String(h.jobId), "big.bin"))).toBe(true);
    expect(h.stores.ledger.active(h.jobId).size).toBe(0);
    expect(existsSync(path.join(h.local, "big.bin"))).toBe(false);
  });

  it("a second run resumes the partial and re-fetches bounded bytes", async () => {
    const probe = await fsp.open(path.join(import.meta.dirname, "executor-harness.ts"), "r");
    vi.spyOn(Object.getPrototypeOf(probe) as { sync(): Promise<void> }, "sync").mockResolvedValue(undefined);
    await probe.close();
    const ctrl = new AbortController();
    let armed = true;
    const h = makeHarness({ session: { onChunk: (sent) => void (armed && sent >= 120_000 && ctrl.abort()) }, cfg: { checkpointBytes: 4096 } });
    h.db.pragma("synchronous = OFF");
    const data = makeData(200_000, 5);
    h.session.set("big.bin", data);
    await h.settled({ signal: ctrl.signal });
    armed = false;
    const durable = h.stores.partials.ranges(h.stores.partials.get(h.jobId, "big.bin")!.id).reduce((n, r) => n + r.durableBytes, 0);
    expect(durable).toBeGreaterThan(0);
    const before = h.session.ranged.bytes;
    h.clock.t += 5000;
    const r = await h.exec();
    expect(r.state).toBe("succeeded");
    expect(read(path.join(h.local, "big.bin")).equals(data)).toBe(true);
    // checkpoint progress depends on machine load, so bound by what was durable: size - durable + 3 margins
    expect(h.session.ranged.bytes - before).toBeLessThanOrEqual(200_000 - durable + 3 * 1024);
    expect(h.session.ranged.bytes - before).toBeLessThan(200_000);
    expect(r.row.bytesDone).toBe(200_000);
    const note = h.activity().find((a) => a.category === "transfer" && /^Resumed big\.bin/.test(a.summary));
    expect(note).toBeDefined();
    expect((note!.meta as { alreadyOnDisk: number }).alreadyOnDisk).toBe(durable);
    vi.restoreAllMocks();
  });

  it("a fresh download does not claim to be a resume", async () => {
    const h = makeHarness();
    h.session.set("big.bin", makeData(50_000, 5));
    expect((await h.settled()).state).toBe("succeeded");
    expect(h.activity().some((a) => /Resumed/.test(a.summary))).toBe(false);
  });

  it("an already aborted signal ends cancelled without downloading", async () => {
    const h = makeHarness();
    h.session.set("a.bin", makeData(1000, 1));
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await h.exec({ signal: ctrl.signal });
    expect(r.state).toBe("cancelled");
    expect(h.session.ranged.bytes).toBe(0);
  });
});

describe("executor dry run", () => {
  it("plans and records a summary but downloads and persists nothing", async () => {
    const h = makeHarness();
    h.session.set("a.bin", makeData(5000, 1));
    h.session.set("b.bin", makeData(5000, 2));
    await h.exec();
    h.clock.t += 5000;
    const obsBefore = JSON.stringify([...h.stores.observations.all(h.jobId)]);
    const followups = h.followups.length;
    const r = await h.exec({ dryRun: true });
    expect(r.state).toBe("succeeded");
    expect(h.session.ranged.bytes).toBe(0);
    expect(existsSync(path.join(h.local, ".harvest-staging"))).toBe(false);
    expect(JSON.stringify([...h.stores.observations.all(h.jobId)])).toBe(obsBefore);
    expect(h.followups.length).toBe(followups);
    const note = h.activity().filter((a) => a.runId === r.runId).find((a) => a.summary.includes("Dry run"));
    expect(note?.meta).toMatchObject({ plannedUnits: 2, keptUnits: 2, bytes: 10_000 });
    expect(h.stores.ledger.active(h.jobId).size).toBe(0);
  });

  it("does not start a settle clock for first-seen files", async () => {
    const h = makeHarness();
    h.session.set("a.bin", makeData(5000, 1));
    await h.exec({ dryRun: true });
    expect(h.stores.observations.all(h.jobId).size).toBe(0);
    const note = h.activity().find((a) => a.summary.includes("succeeded"));
    expect(note?.meta).toMatchObject({ skipped: { first_sighting: 1 } });
  });

  it("works when the local path does not exist yet", async () => {
    const h = makeHarness();
    h.stores.jobs.update(h.jobId, { localPath: path.join(h.local, "not", "yet") });
    h.session.set("a.bin", makeData(5000, 1));
    await h.exec();
    h.clock.t += 5000;
    expect((await h.exec({ dryRun: true })).state).toBe("succeeded");
    expect(existsSync(path.join(h.local, "not"))).toBe(false);
  });
});
