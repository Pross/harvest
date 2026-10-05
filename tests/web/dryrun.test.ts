import { describe, expect, it, vi } from "vitest";
import { registerDryRunRoutes } from "../../src/web/routes-dryrun.js";
import { registerJobRoutes } from "../../src/web/routes-jobs.js";
import { registerRunsRoutes } from "../../src/web/routes-runs.js";
import { makeHarness, req, session, type Harness } from "./harness.js";

const boot = () => makeHarness({ routes: [registerJobRoutes, registerRunsRoutes, registerDryRunRoutes] });

function seedJob(h: Harness, afterSync: "keep" | "delete" = "keep"): number {
  const hostId = h.deps.stores.hosts.create({ name: "h", protocol: "sftp", host: "example.org", port: 22, username: "u" });
  return h.deps.stores.jobs.create({ name: "Movies", hostId, remotePath: "/r", localPath: "/tmp/x", afterSync });
}

const post = async (h: Harness, url: string) => {
  const { sid, csrf } = await session(h);
  return req(h, { method: "POST", url, sid, payload: {}, headers: { "x-csrf-token": csrf } });
};

describe("dry run button and route", () => {
  it("job page has a Dry run button posting to the dry-run route", async () => {
    const h = await boot();
    const job = seedJob(h);
    const res = await req(h, { method: "GET", url: `/jobs/${job}`, sid: (await session(h)).sid });
    expect(res.body).toContain(`action="/jobs/${job}/dry-run"`);
  });

  it("triggers a manual dry run and redirects to the run page", async () => {
    const h = await boot();
    const job = seedJob(h);
    const trigger = vi.fn(() => ({ status: "started" as const, runId: 42 }));
    h.deps.manager.trigger = trigger;
    const res = await post(h, `/jobs/${job}/dry-run`);
    expect(trigger).toHaveBeenCalledWith(job, "manual", { dryRun: true });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/runs/42");
  });

  it("goes back to the job when the run is skipped or the job is disabled; 404 for unknown jobs", async () => {
    const h = await boot();
    const job = seedJob(h);
    expect((await post(h, `/jobs/${job}/dry-run`)).headers.location).toBe(`/jobs/${job}`);
    expect((await post(h, "/jobs/999/dry-run")).statusCode).toBe(404);
  });

  it("requires a CSRF token", async () => {
    const h = await boot();
    const job = seedJob(h);
    const res = await req(h, { method: "POST", url: `/jobs/${job}/dry-run`, sid: (await session(h)).sid, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});

describe("run detail for a dry run", () => {
  it("shows would-download units, would-skip reasons and the would-delete list", async () => {
    const h = await boot();
    const job = seedJob(h, "delete");
    const runs = h.deps.stores.runs;
    const id = runs.create(job, "manual", true);
    runs.setState(id, "succeeded");
    runs.recordFile({ runId: id, unitKey: "Show.S01", remotePath: "Show.S01/e1.mkv", size: 2048, state: "planned", bytes: 0, attempts: 0 });
    runs.recordFile({ runId: id, unitKey: "", remotePath: "old.mkv", size: 0, state: "would_skip", bytes: 0, attempts: 0, error: "already_synced" });
    runs.recordFile({ runId: id, unitKey: "", remotePath: "new.mkv", size: 0, state: "would_skip", bytes: 0, attempts: 0, error: "unsettled: size changed" });
    const body = (await req(h, { method: "GET", url: `/runs/${id}`, sid: (await session(h)).sid })).body;
    expect(body).toContain("Dry run plan");
    expect(body).toContain("Show.S01/e1.mkv");
    expect(body).toContain("2.00 KiB");
    expect(body).toContain("Already in the ledger");
    expect(body).toContain("Still changing (settle check)");
    expect(body).toContain("size changed");
    expect(body).toContain("Would delete from the remote");
  });

  it("omits the delete list when the job keeps remote files", async () => {
    const h = await boot();
    const job = seedJob(h);
    const id = h.deps.stores.runs.create(job, "manual", true);
    h.deps.stores.runs.setState(id, "succeeded");
    h.deps.stores.runs.recordFile({ runId: id, unitKey: "u", remotePath: "a.bin", size: 1, state: "planned", bytes: 0, attempts: 0 });
    const body = (await req(h, { method: "GET", url: `/runs/${id}`, sid: (await session(h)).sid })).body;
    expect(body).not.toContain("Would delete from the remote");
  });
});
