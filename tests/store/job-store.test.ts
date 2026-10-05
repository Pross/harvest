import { describe, expect, it } from "vitest";
import { DEFAULT_EXCLUDES } from "../../src/domain.js";
import { JobBusyError } from "../../src/store/errors.js";
import { setup } from "./helpers.js";

describe("job store", () => {
  it("seeds defaults and exclude globs", () => {
    const { stores, jobId } = setup();
    const job = stores.jobs.get(jobId)!;
    expect(job).toMatchObject({
      name: "j", enabled: true, mode: "copy_new", unitMode: "top_dir", afterSync: "keep", verify: "size", settleSeconds: 300,
      trustMtime: false, rerunPending: false, parallelFiles: 2, rangeStreams: 4, retries: 3, scheduleKind: "manual", changedPolicy: "skip",
      includeGlobs: [], minSize: null, bwlimitBps: null,
    });
    expect(job.excludeGlobs).toEqual([...DEFAULT_EXCLUDES]);
  });

  it("keeps explicit excludes (even empty) and other options", () => {
    const { stores, hostId } = setup();
    const id = stores.jobs.create({ name: "k", hostId, remotePath: "/a", localPath: "/b", excludeGlobs: [], includeGlobs: ["*.mkv"], enabled: false, trustMtime: true, minSize: 5 });
    expect(stores.jobs.get(id)).toMatchObject({ excludeGlobs: [], includeGlobs: ["*.mkv"], enabled: false, trustMtime: true, minSize: 5 });
  });

  it("returns undefined for a missing job", () => {
    expect(setup().stores.jobs.get(999)).toBeUndefined();
  });

  it("throws when stored globs are not a string array", () => {
    const { db, stores, jobId } = setup();
    db.prepare("UPDATE jobs SET include_globs = '[1,2]' WHERE id = ?").run(jobId);
    expect(() => stores.jobs.get(jobId)).toThrow(/array of strings/);
    db.prepare("UPDATE jobs SET include_globs = '{oops' WHERE id = ?").run(jobId);
    expect(() => stores.jobs.get(jobId)).toThrow(/valid JSON/);
  });

  it("update patches only given fields, including nulling", () => {
    const { stores, jobId } = setup();
    stores.jobs.update(jobId, { enabled: false, minSize: 9, includeGlobs: ["a"] });
    stores.jobs.update(jobId, { minSize: null });
    expect(stores.jobs.get(jobId)).toMatchObject({ enabled: false, minSize: null, includeGlobs: ["a"], name: "j" });
    expect(() => stores.jobs.update(999, { enabled: true })).toThrow();
  });

  it("setRerunPending toggles", () => {
    const { stores, jobId } = setup();
    stores.jobs.setRerunPending(jobId, true);
    expect(stores.jobs.get(jobId)!.rerunPending).toBe(true);
    stores.jobs.setRerunPending(jobId, false);
    expect(stores.jobs.get(jobId)!.rerunPending).toBe(false);
  });

  it("scheduledJobs returns enabled non-manual jobs", () => {
    const { stores, hostId } = setup();
    const mk = (name: string, extra: object) => stores.jobs.create({ name, hostId, remotePath: "/a", localPath: "/b", ...extra });
    const cron = mk("c", { scheduleKind: "cron", scheduleExpr: "* * * * *" });
    mk("off", { scheduleKind: "interval", scheduleExpr: "60", enabled: false });
    expect(stores.jobs.scheduledJobs().map((j) => j.id)).toEqual([cron]);
    expect(stores.jobs.list().map((j) => j.name)).toEqual(["c", "j", "off"]);
  });

  it("rejects a job with an unknown host", () => {
    const { stores } = setup();
    expect(() => stores.jobs.create({ name: "z", hostId: 999, remotePath: "/a", localPath: "/b" })).toThrow();
  });
});

describe("job store additions", () => {
  const pending = (stores: ReturnType<typeof setup>["stores"], jobId: number) => {
    const run = stores.runs.create(jobId, "manual", false);
    stores.runs.setState(run, "succeeded");
    stores.ledger.commitUnit(jobId, "a", run, [{ remotePath: "a", size: 1, mtimeMs: 1 }], "pending", 5);
  };

  it("changing remotePath or hostId resets pending and failed remote actions; other edits do not", () => {
    const { stores, hostId, jobId } = setup();
    pending(stores, jobId);
    stores.jobs.update(jobId, { name: "renamed", remotePath: "/r" });
    expect(stores.ledger.get(jobId, "a")!.remoteAction).toBe("pending");
    stores.jobs.update(jobId, { remotePath: "/elsewhere" });
    expect(stores.ledger.get(jobId, "a")).toMatchObject({ remoteAction: "none", remoteActionAt: null });
    pending(stores, jobId);
    const h2 = stores.hosts.create({ name: "h2", protocol: "ftp", host: "x", port: 21, username: "u" });
    stores.jobs.update(jobId, { hostId: h2 });
    expect(stores.ledger.get(jobId, "a")!.remoteAction).toBe("none");
    void hostId;
  });

  it("delete refuses while a run is non-terminal and returns orphaned staging paths", () => {
    const { stores, jobId } = setup();
    const run = stores.runs.create(jobId, "manual", false);
    expect(() => stores.jobs.delete(jobId)).toThrow(JobBusyError);
    stores.runs.setState(run, "failed");
    stores.partials.create({ jobId, remotePath: "x", remoteSize: 1, remoteMtimeMs: null, stagingPath: "/stage/x" }, []);
    expect(stores.jobs.delete(jobId)).toEqual(["/stage/x"]);
    expect(stores.jobs.get(jobId)).toBeUndefined();
  });

  it("scheduledJobs skips rows with bad JSON and reports them; one bad row does not hide the rest", () => {
    const { stores, db, hostId } = setup();
    const mk = (name: string) => stores.jobs.create({ name, hostId, remotePath: "/a", localPath: "/b", scheduleKind: "interval", scheduleExpr: "5m" });
    const good = mk("good"); const bad = mk("bad");
    db.prepare("UPDATE jobs SET exclude_globs = '{oops' WHERE id = ?").run(bad);
    expect(stores.jobs.scheduledJobs().map((j) => j.id)).toEqual([good]);
    const checked = stores.jobs.scheduledJobsChecked();
    expect(checked.bad).toHaveLength(1);
    expect(checked.bad[0]).toMatchObject({ id: bad, name: "bad" });
  });

  it("rerunPendingIds reads the flag from SQL", () => {
    const { stores, db, jobId } = setup();
    stores.jobs.setRerunPending(jobId, true);
    db.prepare("UPDATE jobs SET include_globs = 'bad'").run();
    expect(stores.jobs.rerunPendingIds()).toEqual([jobId]);
  });
});
