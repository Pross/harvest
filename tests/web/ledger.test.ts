import { describe, expect, it } from "vitest";
import type { UnitMode } from "../../src/domain.js";
import { registerLedgerRoutes } from "../../src/web/routes-ledger.js";
import { makeHarness, req, session, type Harness } from "./harness.js";

const boot = () => makeHarness({ routes: [registerLedgerRoutes] });

function seedJob(h: Harness, name = "Seedbox", unitMode: UnitMode = "top_dir"): number {
  const hostId = h.deps.stores.hosts.create({ name: `h-${name}`, protocol: "sftp", host: "example.org", port: 22, username: "u" });
  return h.deps.stores.jobs.create({ name, hostId, remotePath: "/r", localPath: "/tmp/x", unitMode });
}

function commit(h: Harness, jobId: number, unit: string, files: string[], action: "none" | "pending" = "none", size = 1024): void {
  const runId = h.deps.stores.runs.create(jobId, "manual", false);
  h.deps.stores.ledger.commitUnit(jobId, unit, runId, files.map((remotePath) => ({ remotePath, size, mtimeMs: 1 })), action, action === "pending" ? Date.now() : null);
}

const get = async (h: Harness, url: string) => {
  const { sid } = await session(h);
  return req(h, { method: "GET", url, sid });
};

const post = async (h: Harness, url: string, payload: Record<string, unknown> = {}) => {
  const { sid, csrf } = await session(h);
  return req(h, { method: "POST", url, sid, payload, headers: { "x-csrf-token": csrf } });
};

const active = (h: Harness, job: number): string[] => [...h.deps.stores.ledger.active(job).keys()].sort();
const flashOf = (res: { cookies: { name: string; value: string }[] }): string => decodeURIComponent(res.cookies.find((c) => c.name === "harvest_flash")?.value ?? "");
const activityOf = (h: Harness) => h.deps.stores.activity.list({ limit: 50 }).filter((a) => a.category === "ledger.forgot");

describe("ledger browser", () => {
  it("404s for an unknown job", async () => {
    const h = await boot();
    expect((await get(h, "/jobs/99/ledger")).statusCode).toBe(404);
    expect((await get(h, "/jobs/abc/ledger")).statusCode).toBe(404);
    expect((await post(h, "/jobs/99/ledger/forget", { path: "x", confirmed: "yes" })).statusCode).toBe(404);
    expect((await post(h, "/jobs/99/ledger/forget-all", { name: "x" })).statusCode).toBe(404);
  });

  it("shows an empty state", async () => {
    const h = await boot();
    const job = seedJob(h);
    const res = await get(h, `/jobs/${job}/ledger`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("The ledger is empty.");
    expect(res.body).toContain("0 active files");
  });

  it("lists entries with size, synced time and counts", async () => {
    const h = await boot();
    const job = seedJob(h);
    commit(h, job, "Show.S01", ["Show.S01/e1.mkv", "Show.S01/e2.mkv"], "none", 3 * 1024 * 1024);
    const b = (await get(h, `/jobs/${job}/ledger`)).body;
    expect(b).toContain("Show.S01/e1.mkv");
    expect(b).toContain("3.00 MiB");
    expect(b).toContain("<time");
    expect(b).toContain("2 active files");
  });

  it("shows pending and failed remote action badges", async () => {
    const h = await boot();
    const job = seedJob(h);
    commit(h, job, "A", ["A/p.mkv"], "pending");
    commit(h, job, "B", ["B/f.mkv"], "pending");
    h.deps.stores.ledger.markRemoteAction(job, "B/f.mkv", "failed");
    const b = (await get(h, `/jobs/${job}/ledger`)).body;
    expect(b).toContain("ra-pending");
    expect(b).toContain("ra-failed");
  });

  it("searches paths, escaping LIKE wildcards, and reports match counts", async () => {
    const h = await boot();
    const job = seedJob(h);
    commit(h, job, "Alpha", ["Alpha/one.mkv", "Alpha/two.mkv"]);
    commit(h, job, "Beta", ["Beta/100%_done.mkv"]);
    const a = (await get(h, `/jobs/${job}/ledger?q=alpha`)).body;
    expect(a).toContain("Alpha/one.mkv");
    expect(a).not.toContain("Beta/100");
    expect(a).toContain("3 active files");
    expect(a).toContain("2 match");
    const w = (await get(h, `/jobs/${job}/ledger?q=%25_`)).body;
    expect(w).toContain("Beta/100%_done.mkv");
    expect(w).not.toContain("Alpha/one.mkv");
    expect((await get(h, `/jobs/${job}/ledger?q=zzz`)).body).toContain("No ledger entries match.");
  });

  it("paginates and keeps the search term", async () => {
    const h = await boot();
    const job = seedJob(h);
    commit(h, job, "A", Array.from({ length: 5 }, (_, i) => `A/file${i}.mkv`));
    const p1 = (await get(h, `/jobs/${job}/ledger?limit=2&q=file`)).body;
    expect(p1).toContain("Page 1 of 3");
    const next = (/href="([^"]*page=2[^"]*)"/.exec(p1)?.[1] ?? "").replace(/&amp;/g, "&");
    expect(next).toContain("q=file");
    expect(p1).not.toContain("Newer");
    const p3 = (await get(h, `/jobs/${job}/ledger?limit=2&q=file&page=3`)).body;
    expect(p3).toContain("Page 3 of 3");
    expect(p3).not.toContain(">Older<");
    expect(p3).toContain("Newer");
  });

  it("escapes paths", async () => {
    const h = await boot();
    const job = seedJob(h);
    commit(h, job, "<b>x", ["<b>x/<script>.mkv"]);
    const b = (await get(h, `/jobs/${job}/ledger`)).body;
    expect(b).not.toContain("<script>.mkv");
    expect(b).toContain("&lt;script&gt;.mkv");
  });

  it("does not list forgotten entries", async () => {
    const h = await boot();
    const job = seedJob(h);
    commit(h, job, "A", ["A/x.mkv"]);
    h.deps.stores.ledger.forgetFile(job, "A/x.mkv");
    expect((await get(h, `/jobs/${job}/ledger`)).body).toContain("The ledger is empty.");
  });
});

describe("forget one file", () => {
  it("shows a confirm step that explains the consequence", async () => {
    const h = await boot();
    const job = seedJob(h);
    commit(h, job, "A", ["A/x.mkv"]);
    const res = await get(h, `/jobs/${job}/ledger?confirm=file&path=${encodeURIComponent("A/x.mkv")}`);
    expect(res.body).toContain("will be downloaded again on the next run");
    expect(res.body).toContain(`action="/jobs/${job}/ledger/forget"`);
    expect(res.body).toContain('name="confirmed" value="yes"');
  });

  it("forgets the file, records activity and flashes", async () => {
    const h = await boot();
    const job = seedJob(h);
    commit(h, job, "A", ["A/x.mkv", "A/y.mkv"]);
    const res = await post(h, `/jobs/${job}/ledger/forget`, { path: "A/x.mkv", confirmed: "yes" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/jobs/${job}/ledger`);
    expect(active(h, job)).toEqual(["A/y.mkv"]);
    expect(flashOf(res)).toContain("downloaded again");
    const rows = activityOf(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobId).toBe(job);
    expect(rows[0]?.meta).toMatchObject({ scope: "file", target: "A/x.mkv", count: 1 });
  });

  it("redirects to the confirm step when not confirmed, forgetting nothing", async () => {
    const h = await boot();
    const job = seedJob(h);
    commit(h, job, "A", ["A/x.mkv"]);
    const res = await post(h, `/jobs/${job}/ledger/forget`, { path: "A/x.mkv" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("confirm=file");
    expect(active(h, job)).toEqual(["A/x.mkv"]);
    expect(activityOf(h)).toHaveLength(0);
  });

  it("refuses a path that is not in the ledger and a missing path", async () => {
    const h = await boot();
    const job = seedJob(h);
    commit(h, job, "A", ["A/x.mkv"]);
    const res = await post(h, `/jobs/${job}/ledger/forget`, { path: "nope", confirmed: "yes" });
    expect(flashOf(res)).toContain("not in the ledger");
    expect(flashOf(await post(h, `/jobs/${job}/ledger/forget`, {}))).toContain("no path");
    expect(activityOf(h)).toHaveLength(0);
    expect(active(h, job)).toEqual(["A/x.mkv"]);
  });

  it("does not forget another job's file", async () => {
    const h = await boot();
    const a = seedJob(h, "A");
    const b = seedJob(h, "B");
    commit(h, a, "X", ["X/f.mkv"]);
    commit(h, b, "X", ["X/f.mkv"]);
    await post(h, `/jobs/${a}/ledger/forget`, { path: "X/f.mkv", confirmed: "yes" });
    expect(active(h, a)).toEqual([]);
    expect(active(h, b)).toEqual(["X/f.mkv"]);
  });
});

describe("forget unit", () => {
  it("forgets the whole unit using the job's unit mode", async () => {
    const h = await boot();
    const job = seedJob(h);
    commit(h, job, "Show.S01", ["Show.S01/e1.mkv", "Show.S01/e2.mkv"]);
    commit(h, job, "Other", ["Other/o.mkv"]);
    const res = await post(h, `/jobs/${job}/ledger/forget-unit`, { path: "Show.S01/e1.mkv", confirmed: "yes" });
    expect(res.statusCode).toBe(303);
    expect(active(h, job)).toEqual(["Other/o.mkv"]);
    expect(h.deps.stores.ledger.completedUnits(job).has("Show.S01")).toBe(false);
    expect(activityOf(h)[0]?.meta).toMatchObject({ scope: "unit", target: "Show.S01", count: 2 });
  });

  it("does not forget the sibling unit Show.S010 when forgetting Show.S01", async () => {
    const h = await boot();
    const job = seedJob(h);
    commit(h, job, "Show.S01", ["Show.S01/e1.mkv"]);
    commit(h, job, "Show.S010", ["Show.S010/e1.mkv"]);
    await post(h, `/jobs/${job}/ledger/forget-unit`, { path: "Show.S01/e1.mkv", confirmed: "yes" });
    expect(active(h, job)).toEqual(["Show.S010/e1.mkv"]);
    expect(h.deps.stores.ledger.completedUnits(job).has("Show.S010")).toBe(true);
  });

  it("in file unit mode a unit is just the file", async () => {
    const h = await boot();
    const job = seedJob(h, "Files", "file");
    commit(h, job, "d/a.mkv", ["d/a.mkv"]);
    commit(h, job, "d/b.mkv", ["d/b.mkv"]);
    await post(h, `/jobs/${job}/ledger/forget-unit`, { path: "d/a.mkv", confirmed: "yes" });
    expect(active(h, job)).toEqual(["d/b.mkv"]);
  });

  it("shows the unit confirm with its file count and offers the unit link only in top_dir mode", async () => {
    const h = await boot();
    const job = seedJob(h);
    commit(h, job, "Show.S01", ["Show.S01/e1.mkv", "Show.S01/e2.mkv"]);
    const page = (await get(h, `/jobs/${job}/ledger`)).body;
    expect(page).toContain("Forget Show.S01");
    const res = await get(h, `/jobs/${job}/ledger?confirm=unit&path=${encodeURIComponent("Show.S01/e1.mkv")}`);
    expect(res.body).toContain("2 files will be removed");
    expect(res.body).toContain(`action="/jobs/${job}/ledger/forget-unit"`);
    expect(res.body).toContain('name="path" value="Show.S01/e1.mkv"');
    const fileJob = seedJob(h, "Files", "file");
    commit(h, fileJob, "a.mkv", ["a.mkv"]);
    expect((await get(h, `/jobs/${fileJob}/ledger`)).body).not.toContain("Forget a.mkv");
  });

  it("refuses an unknown unit", async () => {
    const h = await boot();
    const job = seedJob(h);
    commit(h, job, "A", ["A/x.mkv"]);
    const res = await post(h, `/jobs/${job}/ledger/forget-unit`, { path: "Zzz/x.mkv", confirmed: "yes" });
    expect(flashOf(res)).toContain("not in the ledger");
    expect(activityOf(h)).toHaveLength(0);
  });
});

describe("forget all", () => {
  it("shows the typed-confirmation card", async () => {
    const h = await boot();
    const job = seedJob(h, "My Job");
    commit(h, job, "A", ["A/x.mkv"]);
    const b = (await get(h, `/jobs/${job}/ledger?confirm=all`)).body;
    expect(b).toContain("Type the job name");
    expect(b).toContain(`action="/jobs/${job}/ledger/forget-all"`);
    expect(b).toContain("downloaded again");
  });

  it("refuses a name mismatch with an inline error and forgets nothing", async () => {
    const h = await boot();
    const job = seedJob(h, "My Job");
    commit(h, job, "A", ["A/x.mkv"]);
    const res = await post(h, `/jobs/${job}/ledger/forget-all`, { name: "my job" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("The name does not match this job.");
    expect(active(h, job)).toEqual(["A/x.mkv"]);
    expect(activityOf(h)).toHaveLength(0);
  });

  it("forgets everything on an exact name match and records activity", async () => {
    const h = await boot();
    const job = seedJob(h, "My Job");
    const other = seedJob(h, "Other");
    commit(h, job, "A", ["A/x.mkv", "A/y.mkv"]);
    commit(h, other, "B", ["B/z.mkv"]);
    const res = await post(h, `/jobs/${job}/ledger/forget-all`, { name: "My Job" });
    expect(res.statusCode).toBe(303);
    expect(active(h, job)).toEqual([]);
    expect(active(h, other)).toEqual(["B/z.mkv"]);
    expect(activityOf(h)[0]?.meta).toMatchObject({ scope: "all", count: 2 });
    expect(activityOf(h)[0]?.category).toBe("ledger.forgot");
  });

  it("requires CSRF", async () => {
    const h = await boot();
    const job = seedJob(h, "My Job");
    commit(h, job, "A", ["A/x.mkv"]);
    const { sid } = await session(h);
    const res = await req(h, { method: "POST", url: `/jobs/${job}/ledger/forget-all`, sid, payload: { name: "My Job" } });
    expect(res.statusCode).toBe(403);
    expect(active(h, job)).toEqual(["A/x.mkv"]);
  });
});
