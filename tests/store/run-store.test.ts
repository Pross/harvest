import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

describe("run store", () => {
  it("creates a queued run", () => {
    const { stores, jobId } = setup();
    const id = stores.runs.create(jobId, "manual", true);
    expect(stores.runs.get(id)).toMatchObject({ state: "queued", dryRun: true, startedAt: null, finishedAt: null, trigger: "manual" });
  });

  it("sets started_at when leaving queued, once", () => {
    const { stores, jobId } = setup();
    const id = stores.runs.create(jobId, "cron", false);
    stores.runs.setState(id, "connecting");
    const first = stores.runs.get(id)!.startedAt;
    expect(first).not.toBeNull();
    stores.runs.setState(id, "listing");
    expect(stores.runs.get(id)).toMatchObject({ startedAt: first, finishedAt: null, state: "listing" });
  });

  it("sets finished_at and error on terminal states", () => {
    const { stores, jobId } = setup();
    const id = stores.runs.create(jobId, "cron", false);
    stores.runs.setState(id, "failed", "boom");
    expect(stores.runs.get(id)).toMatchObject({ state: "failed", error: "boom" });
    expect(stores.runs.get(id)!.finishedAt).not.toBeNull();
  });

  it("covers every terminal state", () => {
    const { stores, jobId } = setup();
    for (const s of ["succeeded", "partial", "failed", "cancelled", "skipped_locked", "skipped_space"] as const) {
      const id = stores.runs.create(jobId, "manual", false);
      stores.runs.setState(id, s);
      expect(stores.runs.get(id)!.finishedAt).not.toBeNull();
    }
  });

  it("setState throws for an unknown run", () => {
    const { stores } = setup();
    expect(() => stores.runs.setState(999, "listing")).toThrow();
  });

  it("addProgress increments atomically and accumulates", () => {
    const { stores, jobId } = setup();
    const id = stores.runs.create(jobId, "manual", false);
    stores.runs.addProgress(id, { bytesDone: 10, filesOk: 1 });
    stores.runs.addProgress(id, { bytesDone: 5, filesFailed: 2, filesSkipped: 3 });
    expect(stores.runs.get(id)).toMatchObject({ bytesDone: 15, filesOk: 1, filesFailed: 2, filesSkipped: 3 });
  });

  it("setPlanned stores totals", () => {
    const { stores, jobId } = setup();
    const id = stores.runs.create(jobId, "manual", false);
    stores.runs.setPlanned(id, 4, 400);
    expect(stores.runs.get(id)).toMatchObject({ filesPlanned: 4, bytesTotal: 400 });
  });

  it("failNonTerminal fails only non-terminal runs and returns the count", () => {
    const { stores, jobId } = setup();
    const a = stores.runs.create(jobId, "manual", false);
    const b = stores.runs.create(jobId, "manual", false);
    const c = stores.runs.create(jobId, "manual", false);
    stores.runs.setState(b, "transferring");
    stores.runs.setState(c, "succeeded");
    expect(stores.runs.failNonTerminal("interrupted by restart")).toBe(2);
    expect(stores.runs.get(a)).toMatchObject({ state: "failed", error: "interrupted by restart" });
    expect(stores.runs.get(a)!.finishedAt).not.toBeNull();
    expect(stores.runs.get(c)).toMatchObject({ state: "succeeded", error: null });
    expect(stores.runs.failNonTerminal("again")).toBe(0);
  });

  it("list and listRecent are newest first and limited", () => {
    const { stores, jobId } = setup();
    const j2 = stores.jobs.create({ name: "j2", hostId: 1, remotePath: "/x", localPath: "/y" });
    const ids = [stores.runs.create(jobId, "manual", false), stores.runs.create(jobId, "manual", false), stores.runs.create(j2, "manual", false)];
    expect(stores.runs.list(jobId, 10).map((r) => r.id)).toEqual([ids[1], ids[0]]);
    expect(stores.runs.listRecent(2).map((r) => r.id)).toEqual([ids[2], ids[1]]);
  });

  it("recordFile upserts by run and remote path", () => {
    const { stores, jobId } = setup();
    const runId = stores.runs.create(jobId, "manual", false);
    const f = { runId, unitKey: "U", remotePath: "U/a", size: 10, state: "downloading", bytes: 3, attempts: 1 };
    stores.runs.recordFile(f);
    stores.runs.recordFile({ ...f, state: "done", bytes: 10, attempts: 2 });
    stores.runs.recordFile({ ...f, remotePath: "U/b", state: "failed", error: "x" });
    const files = stores.runs.filesForRun(runId);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ state: "done", bytes: 10, attempts: 2, error: null });
    expect(files[0]!.finishedAt).not.toBeNull();
    expect(files[1]).toMatchObject({ state: "failed", error: "x" });
  });

  it("deleting a job cascades to runs and run files", () => {
    const { stores, jobId } = setup();
    const runId = stores.runs.create(jobId, "manual", false);
    stores.runs.recordFile({ runId, unitKey: "U", remotePath: "U/a", size: 1, state: "done", bytes: 1, attempts: 1 });
    stores.runs.setState(runId, "succeeded");
    stores.jobs.delete(jobId);
    expect(stores.runs.get(runId)).toBeUndefined();
    expect(stores.runs.filesForRun(runId)).toEqual([]);
  });
});

describe("run store purgeOlderThan", () => {
  it("deletes only finished runs before ts, cascading run_files", () => {
    const { stores, db, jobId } = setup();
    const old = stores.runs.create(jobId, "cron", false); stores.runs.setState(old, "failed", "x");
    const edge = stores.runs.create(jobId, "cron", false); stores.runs.setState(edge, "succeeded");
    const live = stores.runs.create(jobId, "cron", false);
    stores.runs.recordFile({ runId: old, unitKey: "u", remotePath: "a", size: 1, state: "done", bytes: 1, attempts: 1 });
    db.prepare("UPDATE runs SET finished_at = 100 WHERE id = ?").run(old);
    db.prepare("UPDATE runs SET finished_at = 200 WHERE id = ?").run(edge);
    expect(stores.runs.purgeOlderThan(200)).toBe(1);
    expect(stores.runs.get(old)).toBeUndefined();
    expect(stores.runs.filesForRun(old)).toEqual([]);
    expect(stores.runs.get(edge)).toBeDefined();
    expect(stores.runs.get(live)).toBeDefined();
  });
});

describe("run store state rules", () => {
  it("refuses to overwrite a terminal state or finished_at", () => {
    const { stores, jobId } = setup();
    const id = stores.runs.create(jobId, "manual", false);
    expect(stores.runs.setState(id, "succeeded")).toBe(true);
    const done = stores.runs.get(id)!;
    expect(stores.runs.setState(id, "failed", "late")).toBe(false);
    expect(stores.runs.get(id)).toMatchObject({ state: "succeeded", finishedAt: done.finishedAt, error: null });
    expect(() => stores.runs.setState(999, "failed")).toThrow(/not found/);
  });

  it("stamps started_at only for states that mean work began, and records created_at", () => {
    const { stores, jobId } = setup();
    const a = stores.runs.create(jobId, "manual", false);
    const b = stores.runs.create(jobId, "manual", false);
    const c = stores.runs.create(jobId, "manual", false);
    stores.runs.setState(a, "cancelled"); stores.runs.setState(b, "skipped_locked"); stores.runs.setState(c, "connecting");
    expect(stores.runs.get(a)!.startedAt).toBeNull();
    expect(stores.runs.get(b)!.startedAt).toBeNull();
    expect(stores.runs.get(c)!.startedAt).not.toBeNull();
    expect(stores.runs.get(a)!.createdAt).toBeGreaterThan(0);
  });

  it("recordFile upserts through the unique (run_id, remote_path) index", () => {
    const { stores, db, jobId } = setup();
    const runId = stores.runs.create(jobId, "manual", false);
    const f = { runId, unitKey: "U", remotePath: "U/a", size: 5 };
    stores.runs.recordFile({ ...f, state: "downloading", bytes: 1, attempts: 1 });
    stores.runs.recordFile({ ...f, state: "done", bytes: 5, attempts: 2 });
    const rows = stores.runs.filesForRun(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "done", bytes: 5, attempts: 2 });
    expect(rows[0]!.startedAt).not.toBeNull();
    expect(rows[0]!.finishedAt).not.toBeNull();
    expect(() => db.prepare("INSERT INTO run_files (run_id, unit_key, remote_path, size, state) VALUES (?, 'U', 'U/a', 1, 'x')").run(runId)).toThrow(/UNIQUE/);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM run_files WHERE run_id = ? AND remote_path = ?").all(runId, "U/a") as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/run_files_run_path/);
  });

  it("failNonTerminal records exactly one run.interrupted activity row", () => {
    const { stores, jobId } = setup();
    stores.runs.create(jobId, "manual", false); stores.runs.create(jobId, "cron", false);
    const ok = stores.runs.create(jobId, "cron", false); stores.runs.setState(ok, "succeeded");
    expect(stores.runs.failNonTerminal("restart")).toBe(2);
    const rows = stores.activity.list({ limit: 10 }).filter((a) => a.category === "run.interrupted");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "warn", meta: { count: 2 } });
    expect(stores.runs.failNonTerminal("again")).toBe(0);
    expect(stores.activity.list({ limit: 10 }).filter((a) => a.category === "run.interrupted")).toHaveLength(1);
  });

  it("busyJobIds lists jobs with non-terminal runs; purgeFilesOlderThan keeps run rows", () => {
    const { stores, db, jobId } = setup();
    const id = stores.runs.create(jobId, "manual", false);
    expect([...stores.runs.busyJobIds()]).toEqual([jobId]);
    stores.runs.recordFile({ runId: id, unitKey: "U", remotePath: "a", size: 1, state: "done", bytes: 1, attempts: 1 });
    stores.runs.setState(id, "succeeded");
    expect(stores.runs.busyJobIds().size).toBe(0);
    db.prepare("UPDATE run_files SET finished_at = 5").run();
    expect(stores.runs.purgeFilesOlderThan(10)).toBe(1);
    expect(stores.runs.get(id)).toBeDefined();
  });
});
