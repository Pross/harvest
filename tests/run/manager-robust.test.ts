import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { RunState } from "../../src/domain.js";
import { createEventBus, type EventBus } from "../../src/run/events.js";
import { createRunManager, type ManagedRunManager } from "../../src/run/manager.js";
import type { RunJob } from "../../src/run/manager-types.js";
import { setup } from "../store/helpers.js";

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function make(runJob: RunJob, max = 1, bus: EventBus = createEventBus(() => {})) {
  const base = setup();
  const manager = createRunManager({ runJob, stores: base.stores, bus, logger: pino({ level: "silent" }), maxConcurrentRuns: max, jitterMs: () => 0 });
  const addJob = (name: string): number => base.stores.jobs.create({ name, hostId: base.hostId, remotePath: "/r", localPath: "/l" });
  return { ...base, manager, bus, addJob };
}

/** A runJob that finishes instantly in `succeeded`, recording which runs it saw. */
const okJob = (seen: number[], stores: () => ReturnType<typeof setup>["stores"]): RunJob => async (_j, runId) => {
  seen.push(runId);
  stores().runs.setState(runId, "succeeded");
  return "succeeded";
};

describe("run manager robustness", () => {
  let m: ManagedRunManager | undefined;
  afterEach(async () => { vi.useRealTimers(); await m?.stop(); });

  it("a synchronous throw in runJob fails the run, frees the slot and lets the next run start (cap 1)", async () => {
    const seen: number[] = [];
    let first = true;
    let st!: ReturnType<typeof setup>["stores"];
    const runJob: RunJob = (job, runId, sig) => {
      if (first) { first = false; throw new Error("sync boom"); }
      return okJob(seen, () => st)(job, runId, sig);
    };
    const h = make(runJob); m = h.manager; st = h.stores;
    const j2 = h.addJob("b");
    const a = h.manager.trigger(h.jobId, "manual") as { runId: number };
    const b = h.manager.trigger(j2, "manual") as { runId: number };
    expect(b).toMatchObject({ status: "queued" });
    await flush();
    expect(h.stores.runs.get(a.runId)).toMatchObject({ state: "failed", error: "sync boom" });
    expect(seen).toEqual([b.runId]);
    expect(h.manager.busyJobIds().size).toBe(0);
    await h.manager.stop();
  });

  it("a queued job deleted before its run starts does not wedge the queue", async () => {
    const seen: number[] = [];
    let st!: ReturnType<typeof setup>["stores"];
    const h = make(okJob(seen, () => st)); m = h.manager; st = h.stores;
    const j2 = h.addJob("b"); const j3 = h.addJob("c");
    h.manager.trigger(h.jobId, "manual");
    h.manager.trigger(j2, "manual");
    const c = h.manager.trigger(j3, "manual") as { runId: number };
    h.db.prepare("DELETE FROM jobs WHERE id = ?").run(j2);
    await flush();
    expect(seen).toContain(c.runId);
    expect(h.manager.busyJobIds().size).toBe(0);
    await h.manager.stop();
  });

  it("a job row with bad JSON fails only its own run", async () => {
    const seen: number[] = [];
    let st!: ReturnType<typeof setup>["stores"];
    const h = make(okJob(seen, () => st)); m = h.manager; st = h.stores;
    const j2 = h.addJob("b");
    const a = h.manager.trigger(h.jobId, "manual") as { runId: number };
    const b = h.manager.trigger(j2, "manual") as { runId: number };
    h.db.prepare("UPDATE jobs SET include_globs = 'nope' WHERE id = ?").run(h.jobId);
    await flush();
    expect(h.stores.runs.get(a.runId)!.state).toBe("failed");
    expect(h.stores.runs.get(b.runId)!.state).toBe("succeeded");
    expect(h.stores.runs.get(a.runId)!.error).toMatch(/valid JSON/);
    await h.manager.stop();
  });

  it("stop() resolves after a failed start", async () => {
    const h = make(() => { throw new Error("x"); }); m = h.manager;
    h.manager.trigger(h.jobId, "manual");
    await expect(h.manager.stop()).resolves.toBeUndefined();
  });

  it("a throwing bus subscriber neither breaks other subscribers nor wedges trigger", async () => {
    const errors: unknown[] = [];
    const bus = createEventBus((e) => errors.push(e));
    bus.subscribe(() => { throw new Error("bad subscriber"); });
    const got: string[] = [];
    bus.subscribe((e) => { if (e.type === "run.state") got.push(e.state); });
    const seen: number[] = [];
    let st!: ReturnType<typeof setup>["stores"];
    const h = make(okJob(seen, () => st), 1, bus); m = h.manager; st = h.stores;
    expect(h.manager.trigger(h.jobId, "manual").status).toBe("started");
    await flush();
    expect(got).toContain("queued");
    expect(errors.length).toBeGreaterThan(0);
    expect(h.manager.trigger(h.jobId, "manual").status).toBe("started");
    await h.manager.stop();
  });

  it("trigger does not throw when the bus itself throws, and the run still starts", async () => {
    const bus: EventBus = { emit() { throw new Error("bus down"); }, subscribe: () => () => {} };
    const seen: number[] = [];
    let st!: ReturnType<typeof setup>["stores"];
    const h = make(okJob(seen, () => st), 1, bus); m = h.manager; st = h.stores;
    const r = h.manager.trigger(h.jobId, "manual");
    expect(r.status).toBe("started");
    await flush();
    expect(seen).toHaveLength(1);
    expect(h.manager.busyJobIds().size).toBe(0);
  });

  it("marks a run failed when runJob returns without a terminal state, and never overwrites a terminal one", async () => {
    const h = make(async () => "succeeded" as RunState); m = h.manager;
    const a = h.manager.trigger(h.jobId, "manual") as { runId: number };
    await flush();
    expect(h.stores.runs.get(a.runId)).toMatchObject({ state: "failed", error: "run ended without a terminal state" });
    const stamp = h.stores.runs.get(a.runId)!.finishedAt;
    let st2!: ReturnType<typeof setup>["stores"];
    const done: RunJob = async (_j, runId) => { st2.runs.setState(runId, "succeeded"); throw new Error("late"); };
    const h2 = make(done); st2 = h2.stores;
    const b = h2.manager.trigger(h2.jobId, "manual") as { runId: number };
    await flush();
    expect(h2.stores.runs.get(b.runId)!.state).toBe("succeeded");
    expect(stamp).not.toBeNull();
    await h2.manager.stop();
  });

  it("cancels a queued run whose job was disabled before it started", async () => {
    const seen: number[] = [];
    let st!: ReturnType<typeof setup>["stores"];
    const h = make(okJob(seen, () => st)); m = h.manager; st = h.stores;
    const j2 = h.addJob("b");
    h.manager.trigger(h.jobId, "manual");
    const q = h.manager.trigger(j2, "manual") as { runId: number };
    h.stores.jobs.update(j2, { enabled: false });
    await flush();
    expect(h.stores.runs.get(q.runId)).toMatchObject({ state: "cancelled", startedAt: null });
    expect(seen).not.toContain(q.runId);
    await h.manager.stop();
  });

  it("a user cancel does not immediately re-trigger a pending rerun", async () => {
    let abort!: () => void;
    let st!: ReturnType<typeof setup>["stores"];
    const runJob: RunJob = (_j, runId, sig) => new Promise((res) => {
      abort = () => {};
      sig.addEventListener("abort", () => { st.runs.setState(runId, "cancelled"); res("cancelled"); });
    });
    const h = make(runJob, 2); m = h.manager; st = h.stores;
    const a = h.manager.trigger(h.jobId, "manual") as { runId: number };
    await flush();
    h.manager.trigger(h.jobId, "webhook");
    h.manager.cancel(a.runId);
    await flush();
    expect(h.stores.runs.list(h.jobId, 10)).toHaveLength(1);
    expect(h.stores.jobs.get(h.jobId)!.rerunPending).toBe(false);
    void abort;
  });

  it("recoverOnBoot records one run.interrupted activity row and re-arms pending reruns", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const seen: number[] = [];
    let st!: ReturnType<typeof setup>["stores"];
    const h = make(okJob(seen, () => st), 2); m = h.manager; st = h.stores;
    const off = h.addJob("off"); const gone = h.addJob("gone");
    h.stores.jobs.setRerunPending(h.jobId, true);
    h.stores.jobs.setRerunPending(off, true);
    h.stores.jobs.update(off, { enabled: false });
    h.stores.runs.create(h.jobId, "manual", false); h.stores.runs.create(gone, "cron", false);
    expect(h.manager.recoverOnBoot()).toBe(2);
    const act = h.stores.activity.list({ limit: 10 }).filter((a) => a.category === "run.interrupted");
    expect(act).toHaveLength(1);
    expect(act[0]!.meta).toMatchObject({ count: 2 });
    expect(h.stores.jobs.get(off)!.rerunPending).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toHaveLength(1);
    expect(h.stores.runs.list(h.jobId, 5).some((r) => r.trigger === "followup")).toBe(true);
    expect(h.stores.jobs.get(h.jobId)!.rerunPending).toBe(false);
  });
});
