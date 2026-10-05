import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { RunState } from "../../src/domain.js";
import { createEventBus } from "../../src/run/events.js";
import { createRunManager, type ManagedRunManager } from "../../src/run/manager.js";
import type { RunJob } from "../../src/run/manager-types.js";
import { setup } from "../store/helpers.js";

type Gate = { runId: number; finish: (s?: RunState) => void; fail: (e: Error) => void; signal: AbortSignal };

function harness(max = 2, extra: Record<string, unknown> = {}) {
  const base = setup();
  const bus = createEventBus();
  const gates: Gate[] = [];
  const runJob: RunJob = (_job, runId, signal) =>
    new Promise<RunState>((resolve, reject) => {
      const gate: Gate = { runId, signal, finish: (s = "succeeded") => { base.stores.runs.setState(runId, s); resolve(s); }, fail: reject };
      signal.addEventListener("abort", () => { base.stores.runs.setState(runId, "cancelled"); resolve("cancelled"); }, { once: true });
      gates.push(gate);
    });
  const manager = createRunManager({ runJob, stores: base.stores, bus, logger: pino({ level: "silent" }), maxConcurrentRuns: max, jitterMs: () => 0, ...extra });
  return { ...base, bus, gates, manager, runJob };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const addJob = (h: ReturnType<typeof harness>, name: string): number => h.stores.jobs.create({ name, hostId: h.hostId, remotePath: "/r", localPath: "/l" });

describe("run manager", () => {
  let m: ManagedRunManager | undefined;
  afterEach(async () => { vi.useRealTimers(); await m?.stop(); });

  it("starts a run immediately when under the cap", async () => {
    const h = harness(); m = h.manager;
    const r = h.manager.trigger(h.jobId, "manual");
    expect(r.status).toBe("started");
    await flush();
    expect(h.gates).toHaveLength(1);
    expect(h.stores.runs.get((r as { runId: number }).runId)?.state).toBe("queued");
  });

  it("queues past the cap and runs FIFO", async () => {
    const h = harness(1); m = h.manager;
    const j2 = addJob(h, "b"); const j3 = addJob(h, "c");
    const a = h.manager.trigger(h.jobId, "manual");
    const b = h.manager.trigger(j2, "manual");
    const c = h.manager.trigger(j3, "manual");
    expect([a.status, b.status, c.status]).toEqual(["started", "queued", "queued"]);
    await flush();
    expect(h.gates).toHaveLength(1);
    h.gates[0]!.finish(); await flush();
    expect(h.gates.map((g) => g.runId)).toEqual([(a as { runId: number }).runId, (b as { runId: number }).runId]);
    h.gates[1]!.finish(); await flush();
    expect(h.gates).toHaveLength(3);
    expect(h.gates[2]!.runId).toBe((c as { runId: number }).runId);
  });

  it("never exceeds the global cap", async () => {
    const h = harness(2); m = h.manager;
    const jobs = [h.jobId, addJob(h, "b"), addJob(h, "c"), addJob(h, "d")];
    for (const j of jobs) h.manager.trigger(j, "manual");
    await flush();
    expect(h.gates).toHaveLength(2);
    h.gates[0]!.finish(); await flush();
    expect(h.gates).toHaveLength(3);
  });

  it("returns disabled for a disabled job without creating a run", () => {
    const h = harness(); m = h.manager;
    h.stores.jobs.update(h.jobId, { enabled: false });
    expect(h.manager.trigger(h.jobId, "manual")).toEqual({ status: "disabled" });
    expect(h.stores.runs.list(h.jobId, 10)).toHaveLength(0);
  });

  it("throws for an unknown job", () => {
    const h = harness(); m = h.manager;
    expect(() => h.manager.trigger(999, "manual")).toThrow(/not found/);
  });

  it.each(["cron", "interval", "manual"] as const)("records skipped_locked for a locked %s trigger", async (trig) => {
    const h = harness(); m = h.manager;
    h.manager.trigger(h.jobId, "manual");
    const r = h.manager.trigger(h.jobId, trig);
    expect(r.status).toBe("skipped_locked");
    const row = h.stores.runs.get((r as { runId: number }).runId)!;
    expect(row).toMatchObject({ state: "skipped_locked", trigger: trig });
    expect(row.error).toMatch(/already/);
    expect(row.finishedAt).not.toBeNull();
    expect(row.startedAt).toBeNull();
    await flush();
    expect(h.gates).toHaveLength(1);
  });

  it("coalesces skipped_locked rows to one per job per 10 minutes", () => {
    let t = 1_000_000;
    const h = harness(2, { now: () => t }); m = h.manager;
    h.manager.trigger(h.jobId, "manual");
    const a = h.manager.trigger(h.jobId, "cron") as { runId: number };
    const b = h.manager.trigger(h.jobId, "interval") as { runId: number };
    expect(b).toEqual({ status: "skipped_locked", runId: a.runId });
    expect(h.stores.runs.list(h.jobId, 10)).toHaveLength(2);
    t += 600_001;
    const c = h.manager.trigger(h.jobId, "cron") as { runId: number };
    expect(c.runId).not.toBe(a.runId);
    expect(h.stores.runs.list(h.jobId, 10)).toHaveLength(3);
  });

  it("a locked followup trigger sets rerun_pending instead of recording a row", () => {
    const h = harness(); m = h.manager;
    h.manager.trigger(h.jobId, "manual");
    expect(h.manager.trigger(h.jobId, "followup")).toEqual({ status: "rerun_pending" });
    expect(h.stores.jobs.get(h.jobId)!.rerunPending).toBe(true);
    expect(h.stores.runs.list(h.jobId, 10)).toHaveLength(1);
  });

  it("locks against a queued run of the same job too", () => {
    const h = harness(1); m = h.manager;
    const j2 = addJob(h, "b");
    h.manager.trigger(h.jobId, "manual");
    expect(h.manager.trigger(j2, "manual").status).toBe("queued");
    expect(h.manager.trigger(j2, "cron").status).toBe("skipped_locked");
  });

  it("webhook on a busy job sets rerun_pending and starts a follow-up after finish", async () => {
    const h = harness(); m = h.manager;
    h.manager.trigger(h.jobId, "manual"); await flush();
    expect(h.manager.trigger(h.jobId, "webhook")).toEqual({ status: "rerun_pending" });
    expect(h.stores.jobs.get(h.jobId)!.rerunPending).toBe(true);
    expect(h.stores.runs.list(h.jobId, 10)).toHaveLength(1);
    h.gates[0]!.finish(); await flush();
    expect(h.stores.jobs.get(h.jobId)!.rerunPending).toBe(false);
    const runs = h.stores.runs.list(h.jobId, 10);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ trigger: "followup", state: "queued" });
    expect(h.gates).toHaveLength(2);
  });

  it("repeated webhooks coalesce into one follow-up", async () => {
    const h = harness(); m = h.manager;
    h.manager.trigger(h.jobId, "manual");
    await flush();
    h.manager.trigger(h.jobId, "webhook"); h.manager.trigger(h.jobId, "webhook");
    h.gates[0]!.finish(); await flush();
    expect(h.stores.runs.list(h.jobId, 10)).toHaveLength(2);
  });

  it("a webhook on an idle job starts a normal run", () => {
    const h = harness(); m = h.manager;
    expect(h.manager.trigger(h.jobId, "webhook").status).toBe("started");
  });

  it("cancels a queued run: removed, marked cancelled, lock freed", () => {
    const h = harness(1); m = h.manager;
    const j2 = addJob(h, "b");
    h.manager.trigger(h.jobId, "manual");
    const q = h.manager.trigger(j2, "manual") as { runId: number };
    expect(h.manager.cancel(q.runId)).toBe(true);
    expect(h.stores.runs.get(q.runId)!.state).toBe("cancelled");
    expect(h.manager.active().map((a) => a.runId)).not.toContain(q.runId);
    expect(h.manager.trigger(j2, "manual").status).toBe("queued");
  });

  it("cancels a running run by aborting its signal", async () => {
    const h = harness(); m = h.manager;
    const r = h.manager.trigger(h.jobId, "manual") as { runId: number };
    await flush();
    expect(h.manager.cancel(r.runId)).toBe(true);
    expect(h.gates[0]!.signal.aborted).toBe(true);
    await flush();
    expect(h.stores.runs.get(r.runId)!.state).toBe("cancelled");
    expect(h.manager.active()).toHaveLength(0);
  });

  it("cancel returns false for unknown or finished runs", async () => {
    const h = harness(); m = h.manager;
    expect(h.manager.cancel(12345)).toBe(false);
    const r = h.manager.trigger(h.jobId, "manual") as { runId: number };
    await flush();
    h.gates[0]!.finish(); await flush();
    expect(h.manager.cancel(r.runId)).toBe(false);
  });

  it("gives each run its own AbortController", async () => {
    const h = harness(); m = h.manager;
    h.manager.trigger(h.jobId, "manual"); h.manager.trigger(addJob(h, "b"), "manual");
    await flush();
    h.manager.cancel(h.gates[0]!.runId);
    expect(h.gates[0]!.signal.aborted).toBe(true);
    expect(h.gates[1]!.signal.aborted).toBe(false);
  });

  it("marks the run failed and records activity when runJob throws", async () => {
    const h = harness(); m = h.manager;
    const r = h.manager.trigger(h.jobId, "manual") as { runId: number };
    await flush();
    h.gates[0]!.fail(new Error("kaboom")); await flush();
    expect(h.stores.runs.get(r.runId)).toMatchObject({ state: "failed", error: "kaboom" });
    const act = h.stores.activity.list({ limit: 5 });
    expect(act[0]).toMatchObject({ severity: "error", runId: r.runId });
    expect(act[0]!.summary).toContain("kaboom");
  });

  it("frees the job lock and the slot after a throw", async () => {
    const h = harness(1); m = h.manager;
    h.manager.trigger(h.jobId, "manual"); await flush();
    h.gates[0]!.fail(new Error("x")); await flush();
    expect(h.manager.trigger(h.jobId, "manual").status).toBe("started");
  });

  it("emits queued, skipped_locked and cancelled state events", () => {
    const h = harness(1); m = h.manager;
    const seen: string[] = [];
    h.bus.subscribe((e) => { if (e.type === "run.state") seen.push(e.state); });
    h.manager.trigger(h.jobId, "manual");
    h.manager.trigger(h.jobId, "cron");
    const q = h.manager.trigger(addJob(h, "b"), "manual") as { runId: number };
    h.manager.cancel(q.runId);
    expect(seen).toEqual(["queued", "skipped_locked", "queued", "cancelled"]);
  });

  it("active() reflects bus state and progress events", () => {
    const h = harness(); m = h.manager;
    const r = h.manager.trigger(h.jobId, "manual") as { runId: number };
    expect(h.manager.active()[0]).toMatchObject({ runId: r.runId, state: "queued", startedAt: null, bytesDone: 0 });
    h.bus.emit({ type: "run.state", runId: r.runId, jobId: h.jobId, state: "transferring" });
    h.bus.emit({ type: "run.progress", runId: r.runId, jobId: h.jobId, bytesDone: 5, bytesTotal: 10, speedBps: 2, activeFiles: [{ path: "a", bytes: 5, total: 10 }] });
    const a = h.manager.active()[0]!;
    expect(a).toMatchObject({ state: "transferring", bytesDone: 5, bytesTotal: 10, speedBps: 2, trigger: "manual" });
    expect(a.startedAt).not.toBeNull();
    expect(a.activeFiles).toEqual([{ path: "a", bytes: 5, total: 10 }]);
  });

  it("active() returns copies and drops finished runs", async () => {
    const h = harness(); m = h.manager;
    h.manager.trigger(h.jobId, "manual"); await flush();
    h.manager.active()[0]!.bytesDone = 99;
    expect(h.manager.active()[0]!.bytesDone).toBe(0);
    h.gates[0]!.finish(); await flush();
    expect(h.manager.active()).toEqual([]);
  });

  it("ignores events for unknown runs and other event types", () => {
    const h = harness(); m = h.manager;
    h.bus.emit({ type: "run.state", runId: 777, jobId: 1, state: "listing" });
    h.bus.emit({ type: "disk", jobId: 1 });
    expect(h.manager.active()).toEqual([]);
  });

  it("recoverOnBoot fails non-terminal runs and returns the count", () => {
    const h = harness(); m = h.manager;
    const a = h.stores.runs.create(h.jobId, "manual", false);
    const b = h.stores.runs.create(h.jobId, "cron", false); h.stores.runs.setState(b, "transferring");
    const c = h.stores.runs.create(h.jobId, "cron", false); h.stores.runs.setState(c, "succeeded");
    expect(h.manager.recoverOnBoot()).toBe(2);
    expect(h.stores.runs.get(a)).toMatchObject({ state: "failed", error: "interrupted by restart" });
    expect(h.stores.runs.get(c)!.state).toBe("succeeded");
    expect(h.manager.recoverOnBoot()).toBe(0);
  });

  it("stop() aborts in-flight runs, cancels queued ones and awaits", async () => {
    const h = harness(1);
    const j2 = addJob(h, "b");
    const a = h.manager.trigger(h.jobId, "manual") as { runId: number };
    const q = h.manager.trigger(j2, "manual") as { runId: number };
    await flush();
    await h.manager.stop();
    expect(h.gates[0]!.signal.aborted).toBe(true);
    expect(h.stores.runs.get(a.runId)!.state).toBe("cancelled");
    expect(h.stores.runs.get(q.runId)!.state).toBe("cancelled");
    expect(h.gates).toHaveLength(1);
  });

  it("stop() waits for a run that ends slowly", async () => {
    const h = harness();
    let finished = false;
    const slow: RunJob = (_j, _r, signal) => new Promise((res) => signal.addEventListener("abort", () => setTimeout(() => { finished = true; res("cancelled"); }, 20)));
    const mgr = createRunManager({ runJob: slow, stores: h.stores, bus: h.bus, logger: pino({ level: "silent" }), maxConcurrentRuns: 1 });
    mgr.trigger(h.jobId, "manual");
    await flush();
    await mgr.stop();
    expect(finished).toBe(true);
  });

  it("rejects triggers after stop", async () => {
    const h = harness();
    await h.manager.stop();
    expect(() => h.manager.trigger(h.jobId, "manual")).toThrow(/stopped/);
  });

  describe("follow-ups", () => {
    beforeEach(() => vi.useFakeTimers());

    it("fires a followup run at atMs plus jitter", async () => {
      const h = harness(2, { jitterMs: () => 5000, now: () => Date.now() }); m = h.manager;
      h.manager.scheduleFollowup(h.jobId, Date.now() + 10_000);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(h.gates).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.gates).toHaveLength(1);
      expect(h.stores.runs.list(h.jobId, 1)[0]!.trigger).toBe("followup");
    });

    it("fires immediately (plus jitter) when atMs is in the past", async () => {
      const h = harness(); m = h.manager;
      h.manager.scheduleFollowup(h.jobId, Date.now() - 5000);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.gates).toHaveLength(1);
    });

    it("coalesces: a later request does not add a second follow-up", () => {
      const h = harness(); m = h.manager;
      h.manager.scheduleFollowup(h.jobId, Date.now() + 1000);
      h.manager.scheduleFollowup(h.jobId, Date.now() + 5000);
      vi.advanceTimersByTime(10_000);
      expect(h.stores.runs.list(h.jobId, 10)).toHaveLength(1);
    });

    it("an earlier request replaces a later timer", async () => {
      const h = harness(); m = h.manager;
      h.manager.scheduleFollowup(h.jobId, Date.now() + 5000);
      h.manager.scheduleFollowup(h.jobId, Date.now() + 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.gates).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.stores.runs.list(h.jobId, 10)).toHaveLength(1);
    });

    it("keeps separate timers per job", async () => {
      const h = harness(); m = h.manager;
      const j2 = addJob(h, "b");
      h.manager.scheduleFollowup(h.jobId, Date.now()); h.manager.scheduleFollowup(j2, Date.now());
      await vi.advanceTimersByTimeAsync(1);
      expect(h.gates).toHaveLength(2);
    });

    it("uses a default jitter within 0..30s", async () => {
      const h = harness(2, { jitterMs: undefined }); m = h.manager;
      h.manager.scheduleFollowup(h.jobId, Date.now());
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.gates).toHaveLength(1);
    });

    it("a follow-up on a busy job sets rerun_pending and records no row", () => {
      const h = harness(); m = h.manager;
      h.manager.trigger(h.jobId, "manual");
      h.manager.scheduleFollowup(h.jobId, Date.now());
      vi.advanceTimersByTime(1);
      expect(h.stores.jobs.get(h.jobId)!.rerunPending).toBe(true);
      expect(h.stores.runs.list(h.jobId, 10)).toHaveLength(1);
    });

    it("stop() clears pending follow-up timers", async () => {
      const h = harness();
      h.manager.scheduleFollowup(h.jobId, Date.now() + 1000);
      await h.manager.stop();
      vi.advanceTimersByTime(60_000);
      expect(h.stores.runs.list(h.jobId, 10)).toHaveLength(0);
    });

    it("followupDelayFor defers the rerun_pending follow-up", async () => {
      vi.useRealTimers(); vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      const h = harness(2, { followupDelayFor: () => 4000 }); m = h.manager;
      h.manager.trigger(h.jobId, "manual"); h.manager.trigger(h.jobId, "webhook");
      await vi.advanceTimersByTimeAsync(1);
      h.gates[0]!.finish();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.gates).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(4000);
      expect(h.gates).toHaveLength(2);
    });
  });
});
