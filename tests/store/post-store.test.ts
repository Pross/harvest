import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

describe("post store", () => {
  it("returns defaults for a job without a row", () => {
    const { stores, jobId } = setup();
    expect(stores.post.get(jobId)).toEqual({ extract: "off", chmodFile: null, chmodDir: null });
  });

  it("upserts and reads back", () => {
    const { stores, jobId } = setup();
    stores.post.set(jobId, { extract: "keep", chmodFile: "644", chmodDir: "0755" });
    stores.post.set(jobId, { extract: "delete", chmodFile: null, chmodDir: "755" });
    expect(stores.post.get(jobId)).toEqual({ extract: "delete", chmodFile: null, chmodDir: "755" });
  });

  it("rejects an unknown mode and cascades with the job", () => {
    const { stores, jobId, db } = setup();
    expect(() => db.prepare("INSERT INTO job_post (job_id, extract) VALUES (?, 'zip')").run(jobId)).toThrow();
    stores.post.set(jobId, { extract: "keep", chmodFile: null, chmodDir: null });
    stores.jobs.delete(jobId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_post").get()).toEqual({ n: 0 });
  });

  it("throws for an unknown job", () => {
    const { stores } = setup();
    expect(() => stores.post.set(999, { extract: "keep", chmodFile: null, chmodDir: null })).toThrow();
  });
});
