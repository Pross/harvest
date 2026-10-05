import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

const base = (jobId: number, p = "a.mkv") => ({ jobId, remotePath: p, remoteSize: 100, remoteMtimeMs: 5, stagingPath: `/s/${p}` });
const ranges = [{ idx: 0, startByte: 0, endByte: 50 }, { idx: 1, startByte: 50, endByte: 100 }];

describe("partials store", () => {
  it("creates a partial with ranges and reads them back", () => {
    const { stores, jobId } = setup();
    const p = stores.partials.create(base(jobId), ranges);
    expect(p).toMatchObject({ promoteState: "downloading", finalPath: null });
    expect(stores.partials.get(jobId, "a.mkv")).toEqual(p);
    expect(stores.partials.ranges(p.id)).toEqual([
      { partialId: p.id, idx: 0, startByte: 0, endByte: 50, durableBytes: 0 },
      { partialId: p.id, idx: 1, startByte: 50, endByte: 100, durableBytes: 0 },
    ]);
  });

  it("throws on duplicate (job, remote_path) and leaves no stray ranges", () => {
    const { db, stores, jobId } = setup();
    stores.partials.create(base(jobId), ranges);
    expect(() => stores.partials.create(base(jobId), ranges)).toThrow();
    expect((db.prepare("SELECT COUNT(*) n FROM partial_ranges").get() as { n: number }).n).toBe(2);
  });

  it("create rolls back the partial when a range insert fails", () => {
    const { stores, jobId } = setup();
    expect(() => stores.partials.create(base(jobId), [ranges[0]!, ranges[0]!])).toThrow();
    expect(stores.partials.get(jobId, "a.mkv")).toBeUndefined();
  });

  it("returns undefined for an unknown partial", () => {
    const { stores, jobId } = setup();
    expect(stores.partials.get(jobId, "nope")).toBeUndefined();
  });

  it("checkpoint never decreases durable_bytes", () => {
    const { stores, jobId } = setup();
    const p = stores.partials.create(base(jobId), ranges);
    stores.partials.checkpoint(p.id, [{ idx: 0, durableBytes: 30 }]);
    stores.partials.checkpoint(p.id, [{ idx: 0, durableBytes: 10 }]);
    expect(stores.partials.ranges(p.id)[0]?.durableBytes).toBe(30);
  });

  it("checkpoint caps durable_bytes at the range length", () => {
    const { stores, jobId } = setup();
    const p = stores.partials.create(base(jobId), ranges);
    stores.partials.checkpoint(p.id, [{ idx: 1, durableBytes: 9999 }]);
    expect(stores.partials.ranges(p.id)[1]?.durableBytes).toBe(50);
  });

  it("checkpoint updates several ranges in one transaction", () => {
    const { stores, jobId } = setup();
    const p = stores.partials.create(base(jobId), ranges);
    stores.partials.checkpoint(p.id, [{ idx: 0, durableBytes: 5 }, { idx: 1, durableBytes: 7 }]);
    expect(stores.partials.ranges(p.id).map((r) => r.durableBytes)).toEqual([5, 7]);
  });

  it("setPromoting and listPromoting", () => {
    const { stores, jobId } = setup();
    const a = stores.partials.create(base(jobId, "a"), []);
    stores.partials.create(base(jobId, "b"), []);
    expect(stores.partials.listPromoting()).toEqual([]);
    stores.partials.setPromoting(a.id, "/final/a");
    expect(stores.partials.listPromoting()).toEqual([{ ...a, promoteState: "promoting", finalPath: "/final/a" }]);
    expect(() => stores.partials.setPromoting(999, "/x")).toThrow();
  });

  it("discard cascades to ranges", () => {
    const { db, stores, jobId } = setup();
    const p = stores.partials.create(base(jobId), ranges);
    stores.partials.discard(p.id);
    expect(stores.partials.get(jobId, "a.mkv")).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) n FROM partial_ranges").get() as { n: number }).n).toBe(0);
  });

  it("deleting the job cascades to partials", () => {
    const { stores, jobId } = setup();
    stores.partials.create(base(jobId), ranges);
    stores.jobs.delete(jobId);
    expect(stores.partials.listPromoting()).toEqual([]);
    expect(stores.partials.get(jobId, "a.mkv")).toBeUndefined();
  });
});

describe("listOlderThan", () => {
  it("returns only partials not updated since the cutoff", () => {
    const { db, stores, jobId } = setup();
    const old = stores.partials.create(base(jobId, "old.bin"), ranges);
    stores.partials.create(base(jobId, "new.bin"), ranges);
    db.prepare("UPDATE partials SET updated_at = 1000 WHERE id = ?").run(old.id);
    expect(stores.partials.listOlderThan(5000).map((p) => p.remotePath)).toEqual(["old.bin"]);
  });
});
