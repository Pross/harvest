import { describe, expect, it, vi } from "vitest";
import type { RunState, RunTrigger } from "../../src/domain.js";
import { registerRunsRoutes } from "../../src/web/routes-runs.js";
import { makeHarness, req, session, type Harness } from "./harness.js";

const boot = () => makeHarness({ routes: [registerRunsRoutes] });

function seedJob(h: Harness, name: string): number {
  const hostId = h.deps.stores.hosts.create({ name: `h-${name}`, protocol: "sftp", host: "example.org", port: 22, username: "u" });
  return h.deps.stores.jobs.create({ name, hostId, remotePath: "/r", localPath: "/tmp/x" });
}

function seedRun(h: Harness, jobId: number, state: RunState = "succeeded", trigger: RunTrigger = "manual"): number {
  const id = h.deps.stores.runs.create(jobId, trigger, false);
  if (state !== "queued") h.deps.stores.runs.setState(id, state);
  return id;
}

const get = async (h: Harness, url: string) => {
  const { sid } = await session(h);
  return req(h, { method: "GET", url, sid });
};

const post = async (h: Harness, url: string, payload: Record<string, unknown> = {}) => {
  const { sid, csrf } = await session(h);
  return req(h, { method: "POST", url, sid, payload, headers: { "x-csrf-token": csrf } });
};

describe("runs list", () => {
  it("shows an empty state", async () => {
    const h = await boot();
    const res = await get(h, "/runs");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("No runs found.");
  });

  it("lists runs with badge, trigger, job link and nav", async () => {
    const h = await boot();
    const job = seedJob(h, "Movies");
    const id = seedRun(h, job, "failed", "cron");
    const res = await get(h, "/runs");
    expect(res.body).toContain(`href="/runs/${id}"`);
    expect(res.body).toContain("st-failed");
    expect(res.body).toContain("cron");
    expect(res.body).toContain(`href="/jobs/${job}"`);
    expect(res.body).toContain("Movies");
    expect(res.body).toContain('aria-current="page"');
  });

  it("shows duration, bytes and average speed for finished runs", async () => {
    const h = await boot();
    const job = seedJob(h, "Movies");
    const id = seedRun(h, job);
    h.deps.stores.runs.addProgress(id, { bytesDone: 10 * 1024 * 1024, filesOk: 2 });
    h.deps.db.prepare("UPDATE runs SET started_at = 1000000, finished_at = 1010000, files_planned = 3 WHERE id = ?").run(id);
    const res = await get(h, "/runs");
    expect(res.body).toContain("10s");
    expect(res.body).toContain("10.0 MiB");
    expect(res.body).toContain("1.00 MiB/s");
    expect(res.body).toContain("2/3");
  });

  it("filters by job", async () => {
    const h = await boot();
    const a = seedJob(h, "Alpha");
    const b = seedJob(h, "Beta");
    const ra = seedRun(h, a);
    const rb = seedRun(h, b);
    const res = await get(h, `/runs?job=${a}`);
    expect(res.body).toContain(`href="/runs/${ra}"`);
    expect(res.body).not.toContain(`href="/runs/${rb}"`);
  });

  it("filters by state", async () => {
    const h = await boot();
    const job = seedJob(h, "Alpha");
    const ok = seedRun(h, job, "succeeded");
    const bad = seedRun(h, job, "failed");
    const res = await get(h, "/runs?state=failed");
    expect(res.body).toContain(`href="/runs/${bad}"`);
    expect(res.body).not.toContain(`href="/runs/${ok}"`);
  });

  it("ignores an invalid state or job filter instead of failing", async () => {
    const h = await boot();
    const job = seedJob(h, "Alpha");
    const id = seedRun(h, job);
    const res = await get(h, "/runs?state=bogus&job=abc&before=-4&limit=zzz");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`href="/runs/${id}"`);
  });

  it("paginates with keyset links and keeps filters", async () => {
    const h = await boot();
    const job = seedJob(h, "Alpha");
    const ids = [1, 2, 3, 4, 5].map(() => seedRun(h, job));
    const first = await get(h, `/runs?limit=2&job=${job}`);
    expect(first.body).toContain(`href="/runs/${ids[4]}"`);
    expect(first.body).toContain(`href="/runs/${ids[3]}"`);
    expect(first.body).not.toContain(`href="/runs/${ids[2]}"`);
    const link = /href="(\/runs\?before=[^"]+)"/.exec(first.body)?.[1]?.replace(/&amp;/g, "&") ?? "";
    expect(link).toContain(`before=${ids[3]}`);
    expect(link).toContain(`job=${job}`);
    const second = await get(h, link);
    expect(second.body).toContain(`href="/runs/${ids[2]}"`);
    expect(second.body).not.toContain(`href="/runs/${ids[4]}"`);
  });

  it("has no Older link on the last page", async () => {
    const h = await boot();
    const job = seedJob(h, "Alpha");
    seedRun(h, job);
    seedRun(h, job);
    expect((await get(h, "/runs?limit=2")).body).not.toContain(">Older<");
  });

  it("escapes job names", async () => {
    const h = await boot();
    const job = seedJob(h, "<b>x</b>");
    seedRun(h, job);
    const res = await get(h, "/runs");
    expect(res.body).not.toContain("<b>x</b>");
    expect(res.body).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("run detail", () => {
  it("404s for unknown and non-numeric ids", async () => {
    const h = await boot();
    expect((await get(h, "/runs/999")).statusCode).toBe(404);
    expect((await get(h, "/runs/abc")).statusCode).toBe(404);
    expect((await get(h, "/runs/999/live")).statusCode).toBe(404);
  });

  it("shows summary, files, sizes and attempts", async () => {
    const h = await boot();
    const job = seedJob(h, "Movies");
    const id = seedRun(h, job);
    h.deps.stores.runs.recordFile({ runId: id, unitKey: "A", remotePath: "A/one.mkv", size: 2048, state: "done", bytes: 2048, attempts: 2 });
    const res = await get(h, `/runs/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("A/one.mkv");
    expect(res.body).toContain("2.00 KiB");
    expect(res.body).toContain("Files (1)");
    expect(res.body).toContain("st-succeeded");
  });

  it("escapes file error text and the run error", async () => {
    const h = await boot();
    const job = seedJob(h, "Movies");
    const id = seedRun(h, job, "failed");
    h.deps.stores.runs.setState(id, "failed", "boom <img src=x onerror=alert(1)>");
    h.deps.stores.runs.recordFile({ runId: id, unitKey: "A", remotePath: "A/<i>.mkv", size: 1, state: "failed", bytes: 0, attempts: 3, error: "bad <script>alert(1)</script>" });
    const res = await get(h, `/runs/${id}`);
    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(res.body).not.toContain("<img src=x");
    expect(res.body).toContain("A/&lt;i&gt;.mkv");
  });

  it("filters files by state", async () => {
    const h = await boot();
    const job = seedJob(h, "Movies");
    const id = seedRun(h, job);
    h.deps.stores.runs.recordFile({ runId: id, unitKey: "A", remotePath: "good.mkv", size: 1, state: "done", bytes: 1, attempts: 1 });
    h.deps.stores.runs.recordFile({ runId: id, unitKey: "B", remotePath: "bad.mkv", size: 1, state: "failed", bytes: 0, attempts: 3, error: "x" });
    const res = await get(h, `/runs/${id}?state=failed`);
    expect(res.body).toContain("bad.mkv");
    expect(res.body).not.toContain("good.mkv");
    expect(res.body).toContain('value="done"');
  });

  it("renders a timeline from activity rows of this run only", async () => {
    const h = await boot();
    const job = seedJob(h, "Movies");
    const id = seedRun(h, job);
    const other = seedRun(h, job);
    h.deps.stores.activity.record({ category: "run.state", jobId: job, runId: id, summary: "entered listing" });
    h.deps.stores.activity.record({ category: "run.state", jobId: job, runId: other, summary: "other run event" });
    const res = await get(h, `/runs/${id}`);
    expect(res.body).toContain("entered listing");
    expect(res.body).not.toContain("other run event");
  });

  it("live runs get SSE refresh and a cancel button, finished runs do not", async () => {
    const h = await boot();
    const job = seedJob(h, "Movies");
    const live = seedRun(h, job, "transferring");
    const done = seedRun(h, job, "succeeded");
    const a = (await get(h, `/runs/${live}`)).body;
    expect(a).toContain('sse-connect="/events"');
    expect(a).toContain(`hx-get="/runs/${live}/live"`);
    expect(a).toContain('hx-trigger="sse:run-state"');
    expect(a).toContain(`action="/runs/${live}/cancel"`);
    const b = (await get(h, `/runs/${done}`)).body;
    expect(b).not.toContain("sse-connect");
    expect(b).not.toContain("/cancel");
  });

  it("serves the live fragment without layout", async () => {
    const h = await boot();
    const job = seedJob(h, "Movies");
    const id = seedRun(h, job, "transferring");
    const res = await get(h, `/runs/${id}/live`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<html");
    expect(res.body).toContain("transferring");
  });
});

describe("cancel run", () => {
  it("calls manager.cancel for a non-terminal run and redirects", async () => {
    const h = await boot();
    const cancel = vi.fn(() => true);
    h.deps.manager.cancel = cancel;
    const id = seedRun(h, seedJob(h, "Movies"), "transferring");
    const res = await post(h, `/runs/${id}/cancel`);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/runs/${id}`);
    expect(cancel).toHaveBeenCalledWith(id);
  });

  it("rejects terminal runs without calling the manager", async () => {
    const h = await boot();
    const cancel = vi.fn(() => true);
    h.deps.manager.cancel = cancel;
    const id = seedRun(h, seedJob(h, "Movies"), "succeeded");
    const res = await post(h, `/runs/${id}/cancel`);
    expect(res.statusCode).toBe(303);
    expect(cancel).not.toHaveBeenCalled();
    expect(decodeURIComponent(res.cookies.find((c) => c.name === "harvest_flash")?.value ?? "")).toContain("already finished");
  });

  it("reports when the manager no longer knows the run", async () => {
    const h = await boot();
    const id = seedRun(h, seedJob(h, "Movies"), "queued");
    const res = await post(h, `/runs/${id}/cancel`);
    expect(decodeURIComponent(res.cookies.find((c) => c.name === "harvest_flash")?.value ?? "")).toContain("no longer active");
  });

  it("404s for an unknown run", async () => {
    const h = await boot();
    expect((await post(h, "/runs/999/cancel")).statusCode).toBe(404);
  });

  it("requires a CSRF token and a same-site Origin", async () => {
    const h = await boot();
    const cancel = vi.fn(() => true);
    h.deps.manager.cancel = cancel;
    const id = seedRun(h, seedJob(h, "Movies"), "transferring");
    const { sid, csrf } = await session(h);
    expect((await req(h, { method: "POST", url: `/runs/${id}/cancel`, sid, payload: {} })).statusCode).toBe(403);
    expect((await req(h, { method: "POST", url: `/runs/${id}/cancel`, sid, origin: "http://evil.example", headers: { "x-csrf-token": csrf } })).statusCode).toBe(403);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    const h = await boot();
    expect((await req(h, { method: "GET", url: "/runs" })).statusCode).toBe(303);
  });
});
