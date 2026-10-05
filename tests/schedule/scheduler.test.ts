import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { RunManager } from "../../src/run/manager-types.js";
import { createScheduler } from "../../src/schedule/scheduler.js";
import { setup } from "../store/helpers.js";

function harness(tz?: string) {
  const base = setup();
  const calls: { jobId: number; trigger: string }[] = [];
  const manager: RunManager = {
    trigger: (jobId, trigger) => { calls.push({ jobId, trigger }); return { status: "started", runId: 1 }; },
    cancel: () => false, active: () => [], stop: async () => {},
  };
  const scheduler = createScheduler({ stores: base.stores, manager, logger: pino({ level: "silent" }), tz });
  const add = (name: string, kind: "cron" | "interval", expr: string, enabled = true): number =>
    base.stores.jobs.create({ name, hostId: base.hostId, remotePath: "/r", localPath: "/l", scheduleKind: kind, scheduleExpr: expr, enabled });
  return { ...base, calls, manager, scheduler, add };
}

describe("scheduler", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") }));
  afterEach(() => vi.useRealTimers());

  it("fires an interval job repeatedly", () => {
    const h = harness();
    const id = h.add("a", "interval", "5m");
    h.scheduler.start();
    vi.advanceTimersByTime(5 * 60_000);
    expect(h.calls).toEqual([{ jobId: id, trigger: "interval" }]);
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.calls).toHaveLength(3);
    h.scheduler.stop();
  });

  it("fires a cron job with the cron trigger", () => {
    const h = harness("UTC");
    const id = h.add("a", "cron", "0 * * * *");
    h.scheduler.start();
    vi.advanceTimersByTime(60 * 60_000);
    expect(h.calls).toEqual([{ jobId: id, trigger: "cron" }]);
    h.scheduler.stop();
  });

  it("does nothing for manual or disabled jobs", () => {
    const h = harness();
    h.stores.jobs.create({ name: "m", hostId: h.hostId, remotePath: "/r", localPath: "/l" });
    h.add("d", "interval", "1m", false);
    h.scheduler.start();
    vi.advanceTimersByTime(3_600_000);
    expect(h.calls).toEqual([]);
    expect(h.scheduler.nextRuns()).toEqual([]);
    h.scheduler.stop();
  });

  it("nextRuns lists cron and interval jobs", () => {
    const h = harness("UTC");
    const c = h.add("c", "cron", "0 6 * * *");
    const i = h.add("i", "interval", "2h");
    h.scheduler.start();
    const runs = h.scheduler.nextRuns();
    expect(runs.map((r) => r.jobId)).toEqual([c, i]);
    expect(runs[0]!.next?.toISOString()).toBe("2026-01-01T06:00:00.000Z");
    expect(runs[1]!.next?.toISOString()).toBe("2026-01-01T02:00:00.000Z");
    h.scheduler.stop();
  });

  it("interval nextRuns advances after each fire", () => {
    const h = harness();
    h.add("i", "interval", "1h");
    h.scheduler.start();
    vi.advanceTimersByTime(3_600_000);
    expect(h.scheduler.nextRuns()[0]!.next?.toISOString()).toBe("2026-01-01T02:00:00.000Z");
    h.scheduler.stop();
  });

  it("stop clears every timer", () => {
    const h = harness();
    h.add("i", "interval", "1m"); h.add("c", "cron", "* * * * *");
    h.scheduler.start();
    h.scheduler.stop();
    vi.advanceTimersByTime(3_600_000);
    expect(h.calls).toEqual([]);
    expect(h.scheduler.nextRuns()).toEqual([]);
  });

  it("reload picks up new, changed and removed jobs", () => {
    const h = harness();
    const a = h.add("a", "interval", "1m");
    h.scheduler.start();
    const b = h.add("b", "interval", "2m");
    h.stores.jobs.update(a, { enabled: false });
    h.scheduler.reload();
    vi.advanceTimersByTime(2 * 60_000);
    expect(h.calls).toEqual([{ jobId: b, trigger: "interval" }]);
    h.scheduler.stop();
  });

  it("reload does not double-fire a job", () => {
    const h = harness();
    h.add("a", "interval", "1m");
    h.scheduler.start();
    h.scheduler.reload(); h.scheduler.reload();
    vi.advanceTimersByTime(60_000);
    expect(h.calls).toHaveLength(1);
    h.scheduler.stop();
  });

  it("reload before start schedules nothing", () => {
    const h = harness();
    h.add("a", "interval", "1m");
    h.scheduler.reload();
    expect(h.scheduler.nextRuns()).toEqual([]);
  });

  it("skips invalid expressions, logs activity, keeps valid jobs", () => {
    const h = harness();
    const bad = h.add("bad", "cron", "nonsense");
    const bad2 = h.add("bad2", "interval", "5s");
    const ok = h.add("ok", "interval", "1m");
    expect(() => h.scheduler.start()).not.toThrow();
    vi.advanceTimersByTime(60_000);
    expect(h.calls).toEqual([{ jobId: ok, trigger: "interval" }]);
    const warn = h.stores.activity.list({ limit: 10, severity: "warn" });
    expect(warn.map((w) => w.jobId).sort()).toEqual([bad, bad2].sort());
    h.scheduler.stop();
  });

  it("a throwing trigger is recorded and the timer keeps running", () => {
    const h = harness();
    const id = h.add("a", "interval", "1m");
    let n = 0;
    h.manager.trigger = () => { n++; throw new Error("boom"); };
    h.scheduler.start();
    vi.advanceTimersByTime(3 * 60_000);
    expect(n).toBe(3);
    expect(h.stores.activity.list({ limit: 5, severity: "error" })[0]).toMatchObject({ jobId: id, category: "schedule" });
    h.scheduler.stop();
  });

  it("reload keeps unchanged interval timers running instead of restarting them", () => {
    const h = harness();
    const a = h.add("a", "interval", "10m");
    const b = h.add("b", "interval", "10m");
    h.scheduler.start();
    vi.advanceTimersByTime(9 * 60_000);
    h.stores.jobs.update(b, { scheduleExpr: "20m" });
    h.scheduler.reload();
    vi.advanceTimersByTime(60_000);
    expect(h.calls).toEqual([{ jobId: a, trigger: "interval" }]);
    vi.advanceTimersByTime(18 * 60_000);
    expect(h.calls.filter((c) => c.jobId === b)).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(h.calls.filter((c) => c.jobId === b)).toHaveLength(1);
    h.scheduler.stop();
  });

  it("reload registers new jobs and drops disabled or deleted ones", () => {
    const h = harness();
    const a = h.add("a", "interval", "10m");
    h.scheduler.start();
    const b = h.add("b", "interval", "5m");
    h.scheduler.reload();
    expect(h.scheduler.nextRuns().map((r) => r.jobId).sort()).toEqual([a, b]);
    h.stores.jobs.update(a, { enabled: false });
    h.scheduler.reload();
    expect(h.scheduler.nextRuns().map((r) => r.jobId)).toEqual([b]);
    h.scheduler.stop();
  });

  it("one unreadable job row does not stop the others, and is reported once", () => {
    const h = harness();
    const good = h.add("good", "interval", "5m");
    const bad = h.add("bad", "interval", "5m");
    h.db.prepare("UPDATE jobs SET include_globs = 'x' WHERE id = ?").run(bad);
    h.scheduler.start();
    h.scheduler.reload(); h.scheduler.reload();
    expect(h.scheduler.nextRuns().map((r) => r.jobId)).toEqual([good]);
    const warns = h.stores.activity.list({ limit: 10, severity: "warn" }).filter((a) => a.jobId === bad);
    expect(warns).toHaveLength(1);
    h.scheduler.stop();
  });

  it("an invalid schedule is warned about once across reloads, and again once it changes", () => {
    const h = harness();
    const id = h.add("a", "interval", "30d");
    h.scheduler.start();
    h.scheduler.reload(); h.scheduler.reload();
    const warns = () => h.stores.activity.list({ limit: 10, severity: "warn" }).filter((a) => a.jobId === id);
    expect(warns()).toHaveLength(1);
    expect(warns()[0]!.summary).toMatch(/maximum/);
    expect(h.scheduler.nextRuns()).toEqual([]);
    h.stores.jobs.update(id, { scheduleExpr: "40d" });
    h.scheduler.reload();
    expect(warns()).toHaveLength(2);
    h.stores.jobs.update(id, { scheduleExpr: "1h" });
    h.scheduler.reload();
    expect(h.scheduler.nextRuns()).toHaveLength(1);
    h.scheduler.stop();
  });
});
