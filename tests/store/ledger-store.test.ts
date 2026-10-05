import { describe, expect, it } from "vitest";
import { file, setup } from "./helpers.js";

describe("ledger store", () => {
  it("commitUnit writes ledger rows, unit row and clears partials", () => {
    const { stores, jobId } = setup();
    stores.partials.create({ jobId, remotePath: "Show/a.mkv", remoteSize: 10, remoteMtimeMs: 1, stagingPath: "/s/a" }, [{ idx: 0, startByte: 0, endByte: 10 }]);
    stores.ledger.commitUnit(jobId, "Show", 1, [{ ...file("Show/a.mkv"), hash: "abc" }], "none", null);
    expect(stores.ledger.active(jobId).get("Show/a.mkv")?.size).toBe(10);
    expect(stores.ledger.completedUnits(jobId).has("Show")).toBe(true);
    expect(stores.partials.get(jobId, "Show/a.mkv")).toBeUndefined();
    expect(stores.ledger.listActive(jobId, { limit: 10, offset: 0 }).rows[0]?.hash).toBe("abc");
  });

  it("commitUnit is atomic: a mid-transaction failure persists nothing", () => {
    const { db, stores, jobId } = setup();
    stores.partials.create({ jobId, remotePath: "U/a", remoteSize: 1, remoteMtimeMs: null, stagingPath: "/s" }, []);
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON ledger_units BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => stores.ledger.commitUnit(jobId, "U", 1, [file("U/a"), file("U/b")], "none", null)).toThrow(/boom/);
    expect(stores.ledger.active(jobId).size).toBe(0);
    expect(stores.partials.get(jobId, "U/a")).toBeDefined();
  });

  it("commitUnit fails midway through files (bad value) and rolls back earlier rows", () => {
    const { stores, jobId } = setup();
    const bad = { remotePath: "U/b", size: undefined as unknown as number, mtimeMs: null };
    expect(() => stores.ledger.commitUnit(jobId, "U", 1, [file("U/a"), bad], "none", null)).toThrow();
    expect(stores.ledger.active(jobId).size).toBe(0);
    expect(stores.ledger.completedUnits(jobId).size).toBe(0);
  });

  it("resync upserts the existing row, clears forgotten_at and resets remote_action", () => {
    const { db, stores, jobId } = setup();
    stores.ledger.commitUnit(jobId, "f", 1, [file("f", 5)], "pending", 100);
    stores.ledger.forgetFile(jobId, "f");
    expect(stores.ledger.active(jobId).size).toBe(0);
    stores.ledger.commitUnit(jobId, "f", 2, [file("f", 7)], "none", null);
    const rows = db.prepare("SELECT * FROM ledger").all() as { size: number; forgotten_at: number | null; remote_action: string; run_id: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ size: 7, forgotten_at: null, remote_action: "none", run_id: 2 });
  });

  it("forgetFile is soft and keeps history", () => {
    const { db, stores, jobId } = setup();
    stores.ledger.commitUnit(jobId, "f", 1, [file("f")], "none", null);
    stores.ledger.forgetFile(jobId, "f");
    expect(stores.ledger.active(jobId).has("f")).toBe(false);
    expect((db.prepare("SELECT forgotten_at FROM ledger").get() as { forgotten_at: number }).forgotten_at).toBeGreaterThan(0);
  });

  it("forgetUnit matches the key and its children but not siblings", () => {
    const { stores, jobId } = setup();
    stores.ledger.commitUnit(jobId, "Show.S01", 1, [file("Show.S01/e1.mkv"), file("Show.S01/sub/e2.mkv")], "none", null);
    stores.ledger.commitUnit(jobId, "Show.S010", 1, [file("Show.S010/e1.mkv")], "none", null);
    stores.ledger.commitUnit(jobId, "Show.S01.mkv", 1, [file("Show.S01.mkv")], "none", null);
    stores.ledger.forgetUnit(jobId, "Show.S01");
    expect([...stores.ledger.active(jobId).keys()].sort()).toEqual(["Show.S01.mkv", "Show.S010/e1.mkv"]);
    expect([...stores.ledger.completedUnits(jobId)].sort()).toEqual(["Show.S01.mkv", "Show.S010"]);
  });

  it("forgetUnit treats LIKE wildcards literally and matches a single-file unit by equality", () => {
    const { stores, jobId } = setup();
    stores.ledger.commitUnit(jobId, "a_b", 1, [file("a_b")], "none", null);
    stores.ledger.commitUnit(jobId, "axb", 1, [file("axb/x")], "none", null);
    stores.ledger.forgetUnit(jobId, "a_b");
    expect([...stores.ledger.active(jobId).keys()]).toEqual(["axb/x"]);
    stores.ledger.commitUnit(jobId, "a%", 1, [file("a%/y")], "none", null);
    stores.ledger.forgetUnit(jobId, "a%");
    expect([...stores.ledger.active(jobId).keys()]).toEqual(["axb/x"]);
  });

  it("forgetAll only affects the given job", () => {
    const { stores, jobId } = setup();
    const other = stores.jobs.create({ name: "j2", hostId: 1, remotePath: "/x", localPath: "/y" });
    stores.ledger.commitUnit(jobId, "a", 1, [file("a")], "none", null);
    stores.ledger.commitUnit(other, "a", 1, [file("a")], "none", null);
    stores.ledger.forgetAll(jobId);
    expect(stores.ledger.active(jobId).size).toBe(0);
    expect(stores.ledger.completedUnits(jobId).size).toBe(0);
    expect(stores.ledger.active(other).size).toBe(1);
  });

  it("duePendingActions returns pending and failed rows that are due, and markRemoteAction updates them", () => {
    const { stores, jobId } = setup();
    stores.ledger.commitUnit(jobId, "due", 1, [file("due")], "pending", 100);
    stores.ledger.commitUnit(jobId, "later", 1, [file("later")], "pending", 900);
    stores.ledger.commitUnit(jobId, "none", 1, [file("none")], "none", null);
    expect(stores.ledger.duePendingActions(500).map((r) => r.remotePath)).toEqual(["due"]);
    stores.ledger.markRemoteAction(jobId, "due", "failed", 200);
    expect(stores.ledger.duePendingActions(500)[0]?.remoteAction).toBe("failed");
    stores.ledger.markRemoteAction(jobId, "due", "done");
    expect(stores.ledger.duePendingActions(500)).toHaveLength(0);
    expect(() => stores.ledger.markRemoteAction(jobId, "missing", "done")).toThrow();
  });

  it("listActive paginates, searches and counts", () => {
    const { stores, jobId } = setup();
    for (let i = 0; i < 5; i++) stores.ledger.commitUnit(jobId, `f${i}`, 1, [file(`dir/f${i}.mkv`)], "none", null);
    stores.ledger.commitUnit(jobId, "x", 1, [file("other_100%.txt")], "none", null);
    expect(stores.ledger.listActive(jobId, { limit: 2, offset: 0 })).toMatchObject({ total: 6 });
    expect(stores.ledger.listActive(jobId, { limit: 2, offset: 4 }).rows).toHaveLength(2);
    expect(stores.ledger.listActive(jobId, { limit: 10, offset: 0, search: "dir/f" }).total).toBe(5);
    expect(stores.ledger.listActive(jobId, { limit: 10, offset: 0, search: "100%" }).total).toBe(1);
  });
});

describe("ledger forgottenPaths", () => {
  it("returns only forgotten rows and drops a path once it is recommitted", () => {
    const { stores, jobId } = setup();
    stores.ledger.commitUnit(jobId, "U", 1, [file("U/a"), file("U/b")], "none", null);
    expect(stores.ledger.forgottenPaths(jobId).size).toBe(0);
    stores.ledger.forgetFile(jobId, "U/a");
    expect([...stores.ledger.forgottenPaths(jobId)]).toEqual(["U/a"]);
    stores.ledger.commitUnit(jobId, "U", 2, [file("U/a")], "none", null);
    expect(stores.ledger.forgottenPaths(jobId).size).toBe(0);
  });
});

describe("ledger store additions", () => {
  it("forgetUnit is case-sensitive and treats % and _ literally", () => {
    const { stores, jobId } = setup();
    stores.ledger.commitUnit(jobId, "Show", 1, [file("Show/a.mkv")], "none", null);
    stores.ledger.commitUnit(jobId, "show", 1, [file("show/b.mkv")], "none", null);
    stores.ledger.commitUnit(jobId, "a%b", 1, [file("a%b/x"), file("axb/x")], "none", null);
    stores.ledger.commitUnit(jobId, "c_d", 1, [file("c_d/x"), file("cxd/x")], "none", null);
    stores.ledger.forgetUnit(jobId, "Show");
    stores.ledger.forgetUnit(jobId, "a%b");
    stores.ledger.forgetUnit(jobId, "c_d");
    expect([...stores.ledger.active(jobId).keys()].sort()).toEqual(["axb/x", "cxd/x", "show/b.mkv"]);
  });

  it("get returns the active row only", () => {
    const { stores, jobId } = setup();
    stores.ledger.commitUnit(jobId, "a", 1, [file("a", 7)], "pending", 5);
    expect(stores.ledger.get(jobId, "a")).toMatchObject({ size: 7, remoteAction: "pending", remoteActionAt: 5 });
    stores.ledger.forgetFile(jobId, "a");
    expect(stores.ledger.get(jobId, "a")).toBeUndefined();
  });

  it("a failed mark backs off 24 hours unless `at` is given; null remote_action_at is due at once", () => {
    const { stores, db, jobId } = setup();
    stores.ledger.commitUnit(jobId, "a", 1, [file("a")], "pending", 1);
    const before = Date.now();
    stores.ledger.markRemoteAction(jobId, "a", "failed");
    const at = stores.ledger.get(jobId, "a")!.remoteActionAt!;
    expect(at).toBeGreaterThanOrEqual(before + 86_400_000);
    expect(stores.ledger.duePendingActions(before + 1000)).toEqual([]);
    stores.ledger.markRemoteAction(jobId, "a", "failed", 3);
    expect(stores.ledger.get(jobId, "a")!.remoteActionAt).toBe(3);
    db.prepare("UPDATE ledger SET remote_action_at = NULL").run();
    expect(stores.ledger.duePendingActions(0)).toHaveLength(1);
    stores.ledger.markRemoteAction(jobId, "a", "skipped");
    expect(stores.ledger.duePendingActions(1e15)).toEqual([]);
  });
});

describe("ledger remote_raw", () => {
  it("persists remoteRaw from commitUnit and clears it on a recommit without one", () => {
    const { stores, jobId } = setup();
    const run = stores.runs.create(jobId, "manual", false);
    const nfd = "é.mkv";
    stores.ledger.commitUnit(jobId, "é.mkv", run, [{ remotePath: "é.mkv", size: 1, mtimeMs: 1, remoteRaw: nfd }], "pending", 1);
    expect(stores.ledger.get(jobId, "é.mkv")?.remoteRaw).toBe(nfd);
    expect(stores.ledger.duePendingActions(2)[0]?.remoteRaw).toBe(nfd);
    stores.ledger.commitUnit(jobId, "é.mkv", run, [{ remotePath: "é.mkv", size: 1, mtimeMs: 1 }], "none", null);
    expect(stores.ledger.get(jobId, "é.mkv")?.remoteRaw).toBeNull();
  });
});
