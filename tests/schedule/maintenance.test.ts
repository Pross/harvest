import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { TransferEngine } from "../../src/engine/types.js";
import { createSlots } from "../../src/run/connection-slots.js";
import { runMaintenance, startMaintenance, type MaintenanceDeps } from "../../src/schedule/maintenance.js";
import { createFakeSession, type FakeSession } from "../helpers/fake-session.js";
import { file, setup } from "../store/helpers.js";

const DAY = 86_400_000;
const NOW = Date.now();

function harness(init: Record<string, Buffer> = {}, overrides: Partial<MaintenanceDeps> = {}) {
  const base = setup();
  base.stores.jobs.update(base.jobId, { afterSync: "delete" });
  const session: FakeSession = createFakeSession({ files: init, mtimeMs: 1000 });
  const moves: [string, string][] = [];
  session.move = async (a, b) => { moves.push([a, b]); };
  let opens = 0;
  const closeSpy = vi.fn(async () => {});
  session.close = closeSpy;
  const engine: TransferEngine = {
    id: "rclone", capabilities: { hash: false, parallelRanges: true },
    testConnection: async () => ({ ok: true, rootListing: [] }),
    open: async () => { opens++; return session; },
  };
  const removed: string[] = [];
  const deps: MaintenanceDeps = {
    stores: base.stores, engine, logger: pino({ level: "silent" }),
    slotsFor: (h) => createSlots(h.maxConnections),
    purgeSessions: (now) => base.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now).changes,
    stalePartials: (ts) => (base.db.prepare("SELECT id FROM partials WHERE updated_at < ?").all(ts) as { id: number }[])
      .map((r) => base.db.prepare("SELECT * FROM partials WHERE id = ?").get(r.id) as never)
      .map((r: Record<string, unknown>) => ({
        id: r.id as number, jobId: r.job_id as number, remotePath: r.remote_path as string, remoteSize: r.remote_size as number,
        remoteMtimeMs: r.remote_mtime_ms as number | null, stagingPath: r.staging_path as string,
        promoteState: r.promote_state as "downloading" | "promoting", finalPath: r.final_path as string | null,
      })),
    removeFile: async (p) => { removed.push(p); },
    ...overrides,
  };
  const commit = (jobId: number, rel: string, action: "none" | "pending", at: number | null, size = 10) => {
    const run = base.stores.runs.create(jobId, "manual", false);
    base.stores.ledger.commitUnit(jobId, rel, run, [{ ...file(rel, size) }], action, at);
  };
  return { ...base, session, deps, commit, opens: () => opens, closeSpy, removed, moves };
}

const data = Buffer.alloc(10);
const row = (h: ReturnType<typeof harness>, rel: string) =>
  h.db.prepare("SELECT remote_action FROM ledger WHERE job_id = ? AND remote_path = ?").get(h.jobId, rel) as { remote_action: string };

describe("maintenance: remote actions", () => {
  it("removes an unchanged file whose action is failed and marks it done", async () => {
    const h = harness({ "/r/a.mkv": data });
    h.commit(h.jobId, "a.mkv", "pending", NOW - 1);
    h.stores.ledger.markRemoteAction(h.jobId, "a.mkv", "failed", NOW - 1);
    const res = await runMaintenance(h.deps, NOW);
    expect(res.remoteDone).toBe(1);
    expect(h.session.files.has("/r/a.mkv")).toBe(false);
    expect(row(h, "a.mkv").remote_action).toBe("done");
  });

  it("handles pending rows only once remote_action_at has passed", async () => {
    const h = harness({ "/r/a": data, "/r/b": data });
    h.commit(h.jobId, "a", "pending", NOW);
    h.commit(h.jobId, "b", "pending", NOW + 1);
    await runMaintenance(h.deps, NOW);
    expect(row(h, "a").remote_action).toBe("done");
    expect(row(h, "b").remote_action).toBe("pending");
    expect(h.session.files.has("/r/b")).toBe(true);
  });

  it("ignores rows with action none or done", async () => {
    const h = harness({ "/r/a": data });
    h.commit(h.jobId, "a", "none", null);
    const res = await runMaintenance(h.deps, NOW);
    expect(res.remoteDone).toBe(0);
    expect(h.opens()).toBe(0);
  });

  it("marks failed with a warning when the size changed", async () => {
    const h = harness({ "/r/a": Buffer.alloc(99) });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    const res = await runMaintenance(h.deps, NOW);
    expect(res).toMatchObject({ remoteSkipped: 1, remoteFailed: 0 });
    expect(h.session.files.has("/r/a")).toBe(true);
    expect(row(h, "a").remote_action).toBe("skipped");
    expect(h.stores.activity.list({ limit: 10, severity: "warn" })[0]!.summary).toContain("changed");
    expect((await runMaintenance(h.deps, NOW + 3 * DAY)).remoteSkipped).toBe(0);
    expect(h.stores.activity.list({ limit: 10, severity: "warn" })).toHaveLength(1);
  });

  it("marks failed when mtime changed and both are known", async () => {
    const h = harness({ "/r/a": data });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    h.session.setMtime(5555);
    await runMaintenance(h.deps, NOW);
    expect(row(h, "a").remote_action).toBe("skipped");
    expect(h.session.files.has("/r/a")).toBe(true);
  });

  it("ignores mtime when the remote reports none", async () => {
    const h = harness({ "/r/a": data });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    h.session.setMtime(null);
    await runMaintenance(h.deps, NOW);
    expect(row(h, "a").remote_action).toBe("done");
    expect(h.session.files.has("/r/a")).toBe(false);
  });

  it("marks a missing remote file done with a note", async () => {
    const h = harness({});
    h.commit(h.jobId, "gone", "pending", NOW - 1);
    const res = await runMaintenance(h.deps, NOW);
    expect(res.remoteDone).toBe(1);
    expect(row(h, "gone").remote_action).toBe("done");
    expect(h.stores.activity.list({ limit: 10 }).some((a) => a.summary.includes("already gone"))).toBe(true);
  });

  it("marks failed when remove throws and continues with other rows", async () => {
    const h = harness({ "/r/a": data, "/r/b": data });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    h.commit(h.jobId, "b", "pending", NOW - 1);
    const orig = h.session.remove.bind(h.session);
    h.session.remove = async (p) => { if (p.endsWith("/a")) throw new Error("permission denied"); return orig(p); };
    const res = await runMaintenance(h.deps, NOW);
    expect(res).toMatchObject({ remoteDone: 1, remoteFailed: 1 });
    expect(row(h, "a").remote_action).toBe("failed");
    expect(row(h, "b").remote_action).toBe("done");
  });

  it("skips a disabled job with an activity note", async () => {
    const h = harness({ "/r/a": data });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    h.stores.jobs.update(h.jobId, { enabled: false });
    const res = await runMaintenance(h.deps, NOW);
    expect(res.remoteSkipped).toBe(1);
    expect(h.opens()).toBe(0);
    expect(row(h, "a").remote_action).toBe("pending");
    expect(h.stores.activity.list({ limit: 10 }).some((a) => a.summary.includes("disabled"))).toBe(true);
  });

  it("skips rows of a deleted host without crashing", async () => {
    const h = harness({ "/r/a": data });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    h.db.pragma("foreign_keys = OFF");
    h.db.prepare("DELETE FROM hosts WHERE id = ?").run(h.hostId);
    const res = await runMaintenance(h.deps, NOW);
    expect(res.remoteSkipped).toBe(1);
    expect(h.stores.activity.list({ limit: 10 }).some((a) => a.summary.includes("host was deleted"))).toBe(true);
  });

  it("opens one session per host and closes it", async () => {
    const h = harness({ "/r/a": data, "/q/b": data });
    const j2 = h.stores.jobs.create({ name: "j2", hostId: h.hostId, remotePath: "/q", localPath: "/l2" });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    h.commit(j2, "b", "pending", NOW - 1);
    await runMaintenance(h.deps, NOW);
    expect(h.opens()).toBe(1);
    expect(h.closeSpy).toHaveBeenCalledTimes(1);
  });

  it("opens a session per distinct host", async () => {
    const h = harness({ "/r/a": data, "/r/b": data });
    const host2 = h.stores.hosts.create({ name: "h2", protocol: "ftp", host: "x", port: 21, username: "u" });
    const j2 = h.stores.jobs.create({ name: "j2", hostId: host2, remotePath: "/r", localPath: "/l2" });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    h.commit(j2, "b", "pending", NOW - 1);
    await runMaintenance(h.deps, NOW);
    expect(h.opens()).toBe(2);
  });

  it("closes the session when engine work throws", async () => {
    const h = harness({ "/r/a": data });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    h.session.stat = async () => { throw new Error("net down"); };
    await runMaintenance(h.deps, NOW);
    expect(h.closeSpy).toHaveBeenCalled();
    expect(row(h, "a").remote_action).toBe("failed");
  });

  it("moves instead of deleting when the job uses move", async () => {
    const h = harness({ "/r/dir/a": data });
    h.stores.jobs.update(h.jobId, { afterSync: "move", moveTo: "/done" });
    h.commit(h.jobId, "dir/a", "pending", NOW - 1);
    await runMaintenance(h.deps, NOW);
    expect(h.moves).toEqual([["/r/dir/a", "/done/dir/a"]]);
    expect(h.session.files.has("/r/dir/a")).toBe(true);
    expect(row(h, "dir/a").remote_action).toBe("done");
  });

  it("executes delete_after_days only after the delay has passed", async () => {
    const h = harness({ "/r/a": data });
    h.stores.jobs.update(h.jobId, { afterSync: "delete_after_days", afterDays: 2 });
    h.commit(h.jobId, "a", "pending", NOW + 2 * DAY);
    await runMaintenance(h.deps, NOW + DAY);
    expect(h.session.files.has("/r/a")).toBe(true);
    const res = await runMaintenance(h.deps, NOW + 2 * DAY);
    expect(res.remoteDone).toBe(1);
    expect(h.session.files.has("/r/a")).toBe(false);
    expect(row(h, "a").remote_action).toBe("done");
  });

  it("skips delete_after_days when the remote file changed and does not retry", async () => {
    const h = harness({ "/r/a": Buffer.alloc(11) });
    h.stores.jobs.update(h.jobId, { afterSync: "delete_after_days", afterDays: 1 });
    h.commit(h.jobId, "a", "pending", NOW - 1, 10);
    const res = await runMaintenance(h.deps, NOW);
    expect(res.remoteSkipped).toBe(1);
    expect(h.session.files.has("/r/a")).toBe(true);
    expect(row(h, "a").remote_action).toBe("skipped");
  });

  it("gives a moved file a numeric suffix when the destination exists", async () => {
    const h = harness({ "/r/dir/a.mkv": data, "/done/dir/a.mkv": data, "/done/dir/a.1.mkv": data });
    h.stores.jobs.update(h.jobId, { afterSync: "move", moveTo: "/done/" });
    h.commit(h.jobId, "dir/a.mkv", "pending", NOW - 1);
    await runMaintenance(h.deps, NOW);
    expect(h.moves).toEqual([["/r/dir/a.mkv", "/done/dir/a.2.mkv"]]);
  });

  it("fails the row instead of moving into the synced tree", async () => {
    const h = harness({ "/r/a": data });
    h.stores.jobs.update(h.jobId, { afterSync: "move", moveTo: "/r/done" });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    const res = await runMaintenance(h.deps, NOW);
    expect(res.remoteFailed).toBe(1);
    expect(h.moves).toEqual([]);
    expect(row(h, "a").remote_action).toBe("failed");
  });

  it("does not retry forgotten ledger rows", async () => {
    const h = harness({ "/r/a": data });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    h.stores.ledger.forgetFile(h.jobId, "a");
    const res = await runMaintenance(h.deps, NOW);
    expect(res.remoteDone).toBe(0);
    expect(h.session.files.has("/r/a")).toBe(true);
  });
});

describe("maintenance: staging cleanup", () => {
  const mkPartial = (h: ReturnType<typeof harness>, rel: string, updatedAt: number) => {
    const p = h.stores.partials.create({ jobId: h.jobId, remotePath: rel, remoteSize: 10, remoteMtimeMs: 1, stagingPath: `/stage/${rel}` }, [{ idx: 0, startByte: 0, endByte: 10 }]);
    h.db.prepare("UPDATE partials SET updated_at = ? WHERE id = ?").run(updatedAt, p.id);
    return p;
  };

  it("discards partials older than 7 days and deletes their staged file", async () => {
    const h = harness();
    mkPartial(h, "old", NOW - 8 * DAY);
    mkPartial(h, "new", NOW - 6 * DAY);
    const res = await runMaintenance(h.deps, NOW);
    expect(res.stagingDiscarded).toBe(1);
    expect(h.removed).toEqual(["/stage/old"]);
    expect(h.stores.partials.get(h.jobId, "old")).toBeUndefined();
    expect(h.stores.partials.get(h.jobId, "new")).toBeDefined();
  });

  it("keeps a partial exactly at the 7 day boundary", async () => {
    const h = harness();
    mkPartial(h, "edge", NOW - 7 * DAY);
    expect((await runMaintenance(h.deps, NOW)).stagingDiscarded).toBe(0);
  });

  it("never touches a partial that is mid-promote", async () => {
    const h = harness();
    const p = mkPartial(h, "promo", NOW - 30 * DAY);
    h.stores.partials.setPromoting(p.id, "/final/promo");
    h.db.prepare("UPDATE partials SET updated_at = ? WHERE id = ?").run(NOW - 30 * DAY, p.id);
    expect((await runMaintenance(h.deps, NOW)).stagingDiscarded).toBe(0);
    expect(h.removed).toEqual([]);
  });

  it("keeps the row when deleting the file fails", async () => {
    const h = harness({}, { removeFile: async () => { throw new Error("EBUSY"); } });
    mkPartial(h, "old", NOW - 9 * DAY);
    const res = await runMaintenance(h.deps, NOW);
    expect(res).toMatchObject({ errors: 1, stagingDiscarded: 0 });
    expect(h.stores.partials.get(h.jobId, "old")).toBeDefined();
  });

  it("uses the real filesystem by default", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harvest-maint-"));
    const h = harness({}, { removeFile: undefined });
    await fs.writeFile(path.join(dir, "f"), "x");
    const p = h.stores.partials.create({ jobId: h.jobId, remotePath: "f", remoteSize: 1, remoteMtimeMs: 1, stagingPath: path.join(dir, "f") }, []);
    h.db.prepare("UPDATE partials SET updated_at = ? WHERE id = ?").run(NOW - 10 * DAY, p.id);
    await runMaintenance(h.deps, NOW);
    await expect(fs.stat(path.join(dir, "f"))).rejects.toThrow();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("maintenance: retention", () => {
  it("purges activity older than 90 days only", async () => {
    const h = harness();
    h.stores.activity.record({ category: "x", summary: "old" });
    h.stores.activity.record({ category: "x", summary: "edge" });
    h.stores.activity.record({ category: "x", summary: "fresh" });
    h.db.prepare("UPDATE activity SET ts = ? WHERE summary = 'old'").run(NOW - 90 * DAY - 1);
    h.db.prepare("UPDATE activity SET ts = ? WHERE summary = 'edge'").run(NOW - 90 * DAY);
    h.db.prepare("UPDATE activity SET ts = ? WHERE summary = 'fresh'").run(NOW);
    const res = await runMaintenance(h.deps, NOW);
    expect(res.activityPurged).toBe(1);
    const left = h.stores.activity.list({ limit: 20 }).map((a) => a.summary);
    expect(left).toContain("edge");
    expect(left).not.toContain("old");
  });

  it("purges run_files older than 180 days but keeps the run summaries until 730 days", async () => {
    const h = harness();
    const old = h.stores.runs.create(h.jobId, "cron", false); h.stores.runs.setState(old, "succeeded");
    const ancient = h.stores.runs.create(h.jobId, "cron", false); h.stores.runs.setState(ancient, "succeeded");
    const queued = h.stores.runs.create(h.jobId, "cron", false);
    const f = (runId: number) => h.stores.runs.recordFile({ runId, unitKey: "u", remotePath: "a", size: 1, state: "done", bytes: 1, attempts: 1 });
    f(old); f(ancient);
    h.db.prepare("UPDATE run_files SET finished_at = ?, started_at = ? WHERE run_id = ?").run(NOW - 180 * DAY - 1, NOW - 181 * DAY, old);
    h.db.prepare("UPDATE runs SET finished_at = ? WHERE id = ?").run(NOW - 180 * DAY - 1, old);
    h.db.prepare("UPDATE runs SET finished_at = ? WHERE id = ?").run(NOW - 730 * DAY - 1, ancient);
    const res = await runMaintenance(h.deps, NOW);
    expect(res).toMatchObject({ runFilesPurged: 1, runsPurged: 1 });
    expect(h.stores.runs.get(old)).toBeDefined();
    expect(h.stores.runs.filesForRun(old)).toEqual([]);
    expect(h.stores.runs.get(ancient)).toBeUndefined();
    expect(h.stores.runs.get(queued)).toBeDefined();
  });

  it("purges observations not seen for 30 days", async () => {
    const h = harness();
    const ob = (p: string, seen: number) => ({ remotePath: p, size: 1, mtimeMs: 1, firstSeenAt: 1, lastChangedAt: 1, lastSeenAt: seen });
    h.stores.observations.upsert(h.jobId, [ob("old", NOW - 30 * DAY - 1), ob("edge", NOW - 30 * DAY), ob("new", NOW)]);
    const res = await runMaintenance(h.deps, NOW);
    expect(res.observationsPurged).toBe(1);
    expect([...h.stores.observations.all(h.jobId).keys()].sort()).toEqual(["edge", "new"]);
  });

  it("purges expired sessions through the injected function", async () => {
    const h = harness();
    const cols = h.db.prepare("PRAGMA table_info(sessions)").all() as { name: string; notnull: number }[];
    expect(cols.map((c) => c.name)).toContain("expires_at");
    h.db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'h', 1)").run();
    const ins = h.db.prepare("INSERT INTO sessions (id, user_id, csrf_token, created_at, expires_at) VALUES (?, 1, 't', 1, ?)");
    ins.run("a", NOW - 1); ins.run("b", NOW); ins.run("c", NOW + 1000);
    const res = await runMaintenance(h.deps, NOW);
    expect(res.sessionsPurged).toBe(1);
  });

  it("honors custom retention values", async () => {
    const h = harness({}, { retention: { activityDays: 1 } });
    h.stores.activity.record({ category: "x", summary: "two days" });
    h.db.prepare("UPDATE activity SET ts = ?").run(NOW - 2 * DAY);
    expect((await runMaintenance(h.deps, NOW)).activityPurged).toBe(1);
  });

  it("records one summary activity row when work happened", async () => {
    const h = harness({ "/r/a": data });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    h.stores.activity.record({ category: "x", summary: "old" });
    h.db.prepare("UPDATE activity SET ts = ?").run(NOW - 100 * DAY);
    await runMaintenance(h.deps, NOW);
    const rows = h.stores.activity.list({ limit: 20 }).filter((a) => a.category === "maintenance");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toContain("remoteDone=1");
    expect(rows[0]!.meta).toMatchObject({ remoteDone: 1, activityPurged: 1 });
  });

  it("records nothing when there is nothing to do", async () => {
    const h = harness();
    const res = await runMaintenance(h.deps, NOW);
    expect(Object.values(res).every((n) => n === 0)).toBe(true);
    expect(h.stores.activity.list({ limit: 5 })).toEqual([]);
  });
});

describe("startMaintenance", () => {
  afterEach(() => vi.useRealTimers());

  it("runs once after the boot delay and not before", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    const h = harness();
    const purge = vi.fn(() => 0);
    const stop = startMaintenance({ ...h.deps, purgeSessions: purge, tz: "UTC" }, { bootDelayMs: 5000 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(purge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(purge).toHaveBeenCalledTimes(1);
    stop();
  });

  it("runs daily at 03:30 in the configured timezone", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    const h = harness();
    const purge = vi.fn(() => 0);
    const stop = startMaintenance({ ...h.deps, purgeSessions: purge, tz: "UTC" }, { bootDelayMs: 999_999_999 });
    await vi.advanceTimersByTimeAsync(3 * 3_600_000 + 29 * 60_000);
    expect(purge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(purge).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(purge).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stop cancels both timers", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    const h = harness();
    const purge = vi.fn(() => 0);
    startMaintenance({ ...h.deps, purgeSessions: purge, tz: "UTC" }, { bootDelayMs: 1000 })();
    await vi.advanceTimersByTimeAsync(2 * 24 * 3_600_000);
    expect(purge).not.toHaveBeenCalled();
  });

  it("logs and records activity when a run fails, and keeps going", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    const h = harness();
    const boom = vi.fn(() => { throw new Error("db locked"); });
    const stop = startMaintenance({ ...h.deps, purgeSessions: boom }, { bootDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(20);
    expect(boom).toHaveBeenCalled();
    // The pass ends with real file-system work (staging sweep), which fake timers do not drive.
    await vi.waitFor(() => expect(h.stores.activity.list({ limit: 5 })[0]).toMatchObject({ severity: "error", category: "maintenance" }));
    stop();
  });
});

describe("maintenance: robustness", () => {
  const mkPartial = (h: ReturnType<typeof harness>, jobId: number, rel: string, updatedAt: number) => {
    const p = h.stores.partials.create({ jobId, remotePath: rel, remoteSize: 10, remoteMtimeMs: 1, stagingPath: `/stage/${jobId}/${rel}` }, []);
    h.db.prepare("UPDATE partials SET updated_at = ? WHERE id = ?").run(updatedAt, p.id);
  };

  it("keeps staging of a job with a non-terminal run (run store default) and of busyJobs()", async () => {
    const h = harness();
    const j2 = h.stores.jobs.create({ name: "j2", hostId: h.hostId, remotePath: "/q", localPath: "/l2" });
    const j3 = h.stores.jobs.create({ name: "j3", hostId: h.hostId, remotePath: "/q3", localPath: "/l3" });
    for (const j of [h.jobId, j2, j3]) mkPartial(h, j, "p", NOW - 30 * DAY);
    h.stores.runs.create(h.jobId, "manual", false);
    const res = await runMaintenance({ ...h.deps, busyJobs: () => new Set([j2]) }, NOW);
    expect(res.stagingDiscarded).toBe(1);
    expect(h.removed).toEqual([`/stage/${j3}/p`]);
  });

  it("one failing host does not stop other hosts or the retention purges", async () => {
    const h = harness({ "/r/a": data });
    const host2 = h.stores.hosts.create({ name: "h2", protocol: "ftp", host: "x", port: 21, username: "u" });
    const j2 = h.stores.jobs.create({ name: "j2", hostId: host2, remotePath: "/r", localPath: "/l2", afterSync: "delete" });
    h.commit(j2, "b", "pending", NOW - 1);
    h.commit(h.jobId, "a", "pending", NOW - 1);
    const open = h.deps.engine.open.bind(h.deps.engine);
    h.deps.engine.open = async (host) => { if (host.id === host2) throw new Error("connect refused"); return open(host); };
    h.stores.activity.record({ category: "x", summary: "old" });
    h.db.prepare("UPDATE activity SET ts = ? WHERE category = 'x'").run(NOW - 100 * DAY);
    const res = await runMaintenance(h.deps, NOW);
    expect(res).toMatchObject({ remoteDone: 1, errors: 1, activityPurged: 1 });
    expect(row(h, "a").remote_action).toBe("done");
  });

  it("a failing purge does not stop the other purges, and is rethrown after them", async () => {
    const h = harness();
    h.stores.observations.upsert(h.jobId, [{ remotePath: "o", size: 1, mtimeMs: 1, firstSeenAt: 1, lastChangedAt: 1, lastSeenAt: 1 }]);
    const deps = { ...h.deps, purgeSessions: () => { throw new Error("sessions locked"); } };
    h.stores.activity.record({ category: "x", summary: "old" });
    h.db.prepare("UPDATE activity SET ts = 1").run();
    await expect(runMaintenance(deps, NOW)).rejects.toThrow("sessions locked");
    expect(h.stores.observations.all(h.jobId).size).toBe(0);
    expect(h.stores.activity.list({ limit: 5 }).some((a) => a.category === "x")).toBe(false);
  });

  it("a rejecting slot acquisition fails that row only", async () => {
    const h = harness({ "/r/a": data, "/r/b": data });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    h.commit(h.jobId, "b", "pending", NOW - 1);
    let n = 0;
    const slots = createSlots(2);
    const deps = { ...h.deps, slotsFor: () => ({ ...slots, acquireOne: async (s: AbortSignal) => { if (n++ === 0) throw new Error("aborted"); return slots.acquireOne(s); } }) };
    const res = await runMaintenance(deps, NOW);
    expect(res).toMatchObject({ remoteFailed: 1, remoteDone: 1 });
  });

  it("failed rows back off 24 hours; rows with no remote_action_at are due immediately", async () => {
    const h = harness({ "/r/a": data, "/r/b": data });
    h.session.remove = async () => { throw new Error("denied"); };
    h.commit(h.jobId, "a", "pending", NOW - 1);
    await runMaintenance(h.deps, NOW);
    const at = (h.db.prepare("SELECT remote_action_at AS t FROM ledger WHERE remote_path = 'a'").get() as { t: number }).t;
    expect(at).toBe(NOW + DAY);
    expect((await runMaintenance(h.deps, NOW + 1000)).remoteFailed).toBe(0);
    expect((await runMaintenance(h.deps, NOW + DAY)).remoteFailed).toBe(1);
    h.commit(h.jobId, "b", "pending", null);
    expect((await runMaintenance(h.deps, NOW)).remoteFailed).toBe(1);
  });

  it("recovery bookkeeping that throws does not abort the pass", async () => {
    const h = harness({ "/r/a": data, "/r/b": data });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    h.commit(h.jobId, "b", "pending", NOW - 1);
    const orig = h.session.remove.bind(h.session);
    h.session.remove = async (p) => { h.db.prepare("DELETE FROM ledger WHERE remote_path = 'a'").run(); if (p.endsWith("/a")) throw new Error("x"); return orig(p); };
    const deps = { ...h.deps, stores: { ...h.stores, activity: Object.assign(Object.create(h.stores.activity), { record: () => { throw new Error("activity down"); } }) } as never };
    const res = await runMaintenance(deps, NOW);
    expect(res.remoteFailed).toBe(1);
    expect(h.session.files.has("/r/b")).toBe(false);
  });

  it("resets the row instead of acting when the job no longer deletes or moves", async () => {
    const h = harness({ "/r/a": data });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    h.stores.jobs.update(h.jobId, { afterSync: "keep" });
    await runMaintenance(h.deps, NOW);
    expect(row(h, "a").remote_action).toBe("none");
    expect(h.session.files.has("/r/a")).toBe(true);
  });

  it("never deletes when the job is set to move without a target", async () => {
    const h = harness({ "/r/a": data });
    h.stores.jobs.update(h.jobId, { afterSync: "move", moveTo: null });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    await runMaintenance(h.deps, NOW);
    expect(h.session.files.has("/r/a")).toBe(true);
    expect(row(h, "a").remote_action).toBe("failed");
  });

  it("records one activity per disabled job, not one per row", async () => {
    const h = harness({ "/r/a": data, "/r/b": data });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    h.commit(h.jobId, "b", "pending", NOW - 1);
    h.stores.jobs.update(h.jobId, { enabled: false });
    const res = await runMaintenance(h.deps, NOW);
    expect(res.remoteSkipped).toBe(2);
    expect(h.stores.activity.list({ limit: 10 }).filter((a) => a.summary.includes("disabled") && a.category === "maintenance" && a.jobId === h.jobId)).toHaveLength(1);
  });

  it("two overlapping passes share one run", async () => {
    const h = harness();
    const purge = vi.fn(() => 0);
    const deps = { ...h.deps, purgeSessions: purge };
    const [a, b] = await Promise.all([runMaintenance(deps, NOW), runMaintenance(deps, NOW)]);
    expect(purge).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    await runMaintenance(deps, NOW);
    expect(purge).toHaveBeenCalledTimes(2);
  });
});

describe("maintenance: NFD remote names", () => {
  const NFC = "café.mkv";
  const NFD = NFC.normalize("NFD");

  it("acts on the stored server spelling instead of the NFC key", async () => {
    const h = harness({ [`/r/${NFD}`]: data });
    const run = h.stores.runs.create(h.jobId, "manual", false);
    h.stores.ledger.commitUnit(h.jobId, NFC, run, [{ ...file(NFC, 10), remoteRaw: NFD }], "pending", NOW - 1);
    const res = await runMaintenance(h.deps, NOW);
    expect(res.remoteDone).toBe(1);
    expect(h.session.files.has(`/r/${NFD}`)).toBe(false);
    expect(row(h, NFC).remote_action).toBe("done");
  });

  it("leaves the row failed when the raw name is unknown and the parent listing still shows the name", async () => {
    const h = harness({ [`/r/${NFD}`]: data });
    h.session.list = async () => [{ path: NFD, size: 10, mtimeMs: 1000, isDir: false }];
    h.commit(h.jobId, NFC, "pending", NOW - 1);
    const res = await runMaintenance(h.deps, NOW);
    expect(res.remoteDone).toBe(0);
    expect(res.remoteFailed).toBe(1);
    expect(h.session.files.has(`/r/${NFD}`)).toBe(true);
    expect(row(h, NFC).remote_action).toBe("failed");
  });

  it("marks skipped with a warning when the raw name is unknown and the listing proves the name absent", async () => {
    const h = harness();
    h.session.list = async () => [];
    h.commit(h.jobId, NFC, "pending", NOW - 1);
    const res = await runMaintenance(h.deps, NOW);
    expect(res.remoteSkipped).toBe(1);
    expect(row(h, NFC).remote_action).toBe("skipped");
    expect(h.stores.activity.list({ limit: 10 }).some((a) => a.severity === "warn" && a.summary.includes("not in its parent listing"))).toBe(true);
  });
});

describe("maintenance shutdown", () => {
  it("stop() waits for the in-flight pass, and an aborted pass leaves unprocessed rows due", async () => {
    const ctl = new AbortController();
    const h = harness({ "/r/a": data, "/r/b": data }, { signal: ctl.signal });
    h.commit(h.jobId, "a", "pending", NOW - 1);
    h.commit(h.jobId, "b", "pending", NOW - 1);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const enteredP = new Promise<void>((r) => { entered = r; });
    h.session.remove = async (p) => { entered(); await gate; h.session.files.delete(p); };
    const stop = startMaintenance(h.deps, { bootDelayMs: 1 });
    await enteredP;
    ctl.abort();
    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(row(h, "a").remote_action).toBe("done");
    expect(row(h, "b").remote_action).toBe("pending");
    expect(h.session.files.has("/r/b")).toBe(true);
    expect(h.stores.activity.list({ limit: 20 }).some((a) => a.severity === "error")).toBe(false);
  });
});
