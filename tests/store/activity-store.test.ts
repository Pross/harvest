import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

describe("activity store", () => {
  it("records with defaults and parses meta", () => {
    const { stores } = setup();
    stores.activity.record({ category: "run", summary: "hi", meta: { a: 1 } });
    stores.activity.record({ category: "run", summary: "no meta" });
    const rows = stores.activity.list({ limit: 10 });
    expect(rows[1]).toMatchObject({ severity: "info", jobId: null, runId: null, meta: { a: 1 } });
    expect(rows[0]?.meta).toBeNull();
  });

  it("paginates by keyset, newest first", () => {
    const { stores } = setup();
    for (let i = 1; i <= 7; i++) stores.activity.record({ category: "c", summary: `s${i}` });
    const p1 = stores.activity.list({ limit: 3 });
    const p2 = stores.activity.list({ limit: 3, beforeId: p1[2]!.id });
    const p3 = stores.activity.list({ limit: 3, beforeId: p2[2]!.id });
    expect([...p1, ...p2, ...p3].map((r) => r.summary)).toEqual(["s7", "s6", "s5", "s4", "s3", "s2", "s1"]);
  });

  it("filters by job and severity", () => {
    const { stores, jobId } = setup();
    stores.activity.record({ category: "c", summary: "a", jobId, severity: "error" });
    stores.activity.record({ category: "c", summary: "b", jobId, severity: "warn" });
    stores.activity.record({ category: "c", summary: "c" });
    expect(stores.activity.list({ limit: 10, jobId }).map((r) => r.summary)).toEqual(["b", "a"]);
    expect(stores.activity.list({ limit: 10, severity: "error" }).map((r) => r.summary)).toEqual(["a"]);
  });

  it("purgeOlderThan deletes by timestamp", () => {
    const { db, stores } = setup();
    stores.activity.record({ category: "c", summary: "old" });
    stores.activity.record({ category: "c", summary: "new" });
    db.prepare("UPDATE activity SET ts = 5 WHERE summary = 'old'").run();
    expect(stores.activity.purgeOlderThan(100)).toBe(1);
    expect(stores.activity.list({ limit: 10 }).map((r) => r.summary)).toEqual(["new"]);
  });

  it("rejects an invalid severity", () => {
    const { stores } = setup();
    expect(() => stores.activity.record({ category: "c", summary: "x", severity: "bad" as "info" })).toThrow();
  });
});

describe("activity store additions", () => {
  it("record returns the inserted id", () => {
    const { stores } = setup();
    const a = stores.activity.record({ category: "c", summary: "1" });
    const b = stores.activity.record({ category: "c", summary: "2" });
    expect(b).toBe(a + 1);
    expect(stores.activity.list({ limit: 1 })[0]!.id).toBe(b);
  });

  it("a corrupt meta_json row comes back as the raw string instead of failing the list", () => {
    const { db, stores } = setup();
    stores.activity.record({ category: "c", summary: "ok", meta: { a: 1 } });
    stores.activity.record({ category: "c", summary: "bad" });
    db.prepare("UPDATE activity SET meta_json = '{broken' WHERE summary = 'bad'").run();
    const rows = stores.activity.list({ limit: 10 });
    expect(rows.find((r) => r.summary === "bad")!.meta).toBe("{broken");
    expect(rows.find((r) => r.summary === "ok")!.meta).toEqual({ a: 1 });
  });
});
