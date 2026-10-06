import { describe, expect, it } from "vitest";
import { lastRunByJob } from "../../src/web/last-runs.js";
import { registerJobRoutes } from "../../src/web/routes-jobs.js";
import { makeHarness, req, session, type Harness } from "./harness.js";

function seedJob(h: Harness, name: string): number {
  const hostId = h.deps.stores.hosts.create({ name: `h-${name}`, protocol: "sftp", host: "example.org", port: 22, username: "u" });
  return h.deps.stores.jobs.create({ name, hostId, remotePath: "/r", localPath: `/data/${name}` });
}

function run(h: Harness, jobId: number, state: string, o: { dry?: boolean; bytes?: number } = {}): number {
  const id = h.deps.stores.runs.create(jobId, "manual", o.dry ?? false);
  h.deps.stores.runs.setState(id, state as never);
  if (o.bytes) h.deps.stores.runs.addProgress(id, { bytesDone: o.bytes });
  return id;
}

describe("last run per job", () => {
  it("ignores a newer dry run and shows the last real run", async () => {
    const h = await makeHarness();
    const job = seedJob(h, "movies");
    const real = run(h, job, "succeeded", { bytes: 1_073_741_824 });
    run(h, job, "succeeded", { dry: true });
    expect(lastRunByJob(h.deps, [job]).get(job)?.id).toBe(real);
  });

  it("ignores a newer run that was skipped because the job was busy", async () => {
    const h = await makeHarness();
    const job = seedJob(h, "movies");
    const real = run(h, job, "failed");
    run(h, job, "skipped_locked");
    expect(lastRunByJob(h.deps, [job]).get(job)?.id).toBe(real);
  });

  it("still shows cancelled, skipped_space, partial and in-flight runs, which say something about the job", async () => {
    const h = await makeHarness();
    for (const state of ["cancelled", "skipped_space", "partial", "transferring"]) {
      const job = seedJob(h, `job-${state}`);
      run(h, job, "succeeded");
      const newest = run(h, job, state);
      expect(lastRunByJob(h.deps, [job]).get(job)?.id).toBe(newest);
    }
  });

  it("falls back to the per-job lookup for a job outside the recent window and stays undefined when only dry runs exist", async () => {
    const h = await makeHarness();
    const old = seedJob(h, "old");
    const onlyDry = seedJob(h, "only-dry");
    const real = run(h, old, "succeeded");
    run(h, onlyDry, "succeeded", { dry: true });
    const busy = seedJob(h, "busy");
    for (let i = 0; i < 520; i++) run(h, busy, "succeeded");
    const last = lastRunByJob(h.deps, [old, onlyDry, busy]);
    expect(last.get(old)?.id).toBe(real);
    expect(last.get(onlyDry)).toBeUndefined();
    expect(last.get(busy)).toBeDefined();
  });

  it("is what the dashboard and the jobs list render", async () => {
    const h = await makeHarness({ routes: [registerJobRoutes] });
    const job = seedJob(h, "movies");
    run(h, job, "succeeded", { bytes: 1_073_741_824 });
    run(h, job, "succeeded", { dry: true });
    const { sid } = await session(h);
    const dash = (await req(h, { method: "GET", url: "/", sid })).body;
    expect(dash).toContain("1.00 GiB");
    const list = (await req(h, { method: "GET", url: "/jobs", sid })).body;
    expect(list).toContain('href="/runs/1"');
    expect(list).not.toContain('href="/runs/2"');
  });
});
