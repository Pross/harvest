import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

const obs = (p: string, lastSeenAt = 10) => ({ remotePath: p, size: 1, mtimeMs: 2, firstSeenAt: 1, lastChangedAt: 3, lastSeenAt });

describe("observation store", () => {
  it("upserts and reads back as a map", () => {
    const { stores, jobId } = setup();
    stores.observations.upsert(jobId, [obs("a"), obs("b")]);
    stores.observations.upsert(jobId, [{ ...obs("a"), size: 99, lastSeenAt: 20 }]);
    const all = stores.observations.all(jobId);
    expect(all.size).toBe(2);
    expect(all.get("a")).toEqual({ ...obs("a"), size: 99, lastSeenAt: 20 });
  });

  it("is scoped per job", () => {
    const { stores, jobId } = setup();
    const j2 = stores.jobs.create({ name: "j2", hostId: 1, remotePath: "/x", localPath: "/y" });
    stores.observations.upsert(jobId, [obs("a")]);
    expect(stores.observations.all(j2).size).toBe(0);
  });

  it("removes 2,000 paths (chunked under the variable limit)", () => {
    const { stores, jobId } = setup();
    const rows = Array.from({ length: 2100 }, (_, i) => obs(`p${i}`));
    stores.observations.upsert(jobId, rows);
    stores.observations.remove(jobId, rows.slice(0, 2000).map((r) => r.remotePath));
    expect([...stores.observations.all(jobId).keys()]).toEqual(rows.slice(2000).map((r) => r.remotePath));
  });

  it("remove with an empty list is a no-op", () => {
    const { stores, jobId } = setup();
    stores.observations.upsert(jobId, [obs("a")]);
    stores.observations.remove(jobId, []);
    expect(stores.observations.all(jobId).size).toBe(1);
  });

  it("purgeOlderThan removes stale rows only", () => {
    const { stores, jobId } = setup();
    stores.observations.upsert(jobId, [obs("old", 5), obs("new", 50)]);
    expect(stores.observations.purgeOlderThan(10)).toBe(1);
    expect([...stores.observations.all(jobId).keys()]).toEqual(["new"]);
  });
});
