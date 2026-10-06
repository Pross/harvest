import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_EXCLUDES } from "../../src/domain.js";
import type { TriggerResult } from "../../src/run/manager-types.js";
import { parseHumanRate, parseHumanSize, sizeToInput } from "../../src/web/job-schemas.js";
import { registerBrowseRoutes } from "../../src/web/routes-browse.js";
import { registerHostRoutes } from "../../src/web/routes-hosts.js";
import { registerJobMirrorRoutes } from "../../src/web/routes-job-mirror.js";
import { registerJobRoutes } from "../../src/web/routes-jobs.js";
import { makeHarness, req, session, type Harness } from "./harness.js";

let base: string;
let root: string;
let cfgDir: string;
let dl: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harvest-jobs-")));
  root = path.join(base, "root");
  cfgDir = path.join(root, "appconfig");
  dl = path.join(root, "downloads");
  for (const d of [dl, path.join(root, "other"), cfgDir, path.join(base, "outside")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, "afile"), "x");
  fs.symlinkSync(path.join(base, "outside"), path.join(root, "escape"));
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const form = (o: Record<string, string>): string => new URLSearchParams(o).toString();
type Ctx = { h: Harness; sid: string; csrf: string; sftp: number; ftp: number; changed: ReturnType<typeof vi.fn>; trigger: ReturnType<typeof vi.fn> };

async function setup(): Promise<Ctx> {
  const h = await makeHarness({ routes: [registerHostRoutes, registerJobRoutes, registerJobMirrorRoutes, registerBrowseRoutes], env: { BROWSE_ROOTS: root, CONFIG_DIR: cfgDir } });
  const changed = vi.fn();
  const trigger = vi.fn<(id: number, t: string) => TriggerResult>(() => ({ status: "started", runId: 7 }));
  h.deps.onJobsChanged = changed;
  h.deps.manager.trigger = trigger as unknown as typeof h.deps.manager.trigger;
  const sftp = h.deps.stores.hosts.create({ name: "sftp-box", protocol: "sftp", host: "s.example.org", port: 22, username: "u" });
  const ftp = h.deps.stores.hosts.create({ name: "ftp-box", protocol: "ftp", host: "f.example.org", port: 21, username: "u" });
  return { h, sftp, ftp, changed, trigger, ...(await session(h)) };
}
const post = (c: Ctx, url: string, data: Record<string, string> = {}) =>
  req(c.h, { method: "POST", url, sid: c.sid, payload: form({ _csrf: c.csrf, ...data }), headers: { "content-type": "application/x-www-form-urlencoded" } });
const get = (c: Ctx, url: string) => req(c.h, { method: "GET", url, sid: c.sid });
const flashOf = (res: { cookies: { name: string; value: string }[] }): string => {
  let v = res.cookies.find((x) => x.name === "harvest_flash")?.value ?? "";
  for (let i = 0; i < 3 && v.includes("%"); i++) v = decodeURIComponent(v);
  return v;
};
const payload = (c: Ctx, o: Record<string, string> = {}): Record<string, string> => ({
  name: "Movies", host_id: String(c.sftp), remote_path: "/downloads", local_path: dl, mode: "copy_new", unit_mode: "top_dir", after_sync: "keep",
  verify: "size", settle_seconds: "300", min_age_seconds: "0", min_size: "", max_size: "", include_globs: "", exclude_globs: DEFAULT_EXCLUDES.join("\n"),
  parallel_files: "2", range_streams: "4", retries: "3", min_free_bytes: "", bwlimit: "", schedule_kind: "manual", schedule_expr: "",
  changed_policy: "skip", enabled: "on", ...o,
});
const create = (c: Ctx, o: Record<string, string> = {}) => post(c, "/jobs", payload(c, o));
const job = (c: Ctx, id = 1) => c.h.deps.stores.jobs.get(id);

describe("human size parsing", () => {
  it.each([["500MB", 524_288_000], ["2GB", 2 * 1024 ** 3], ["1.5 GiB", 1.5 * 1024 ** 3], ["20gb", 20 * 1024 ** 3], ["1024", 1024], ["3k", 3072], ["1TB", 1024 ** 4], ["0", 0]])("parses %s", (s, n) => {
    expect(parseHumanSize(s)).toBe(n);
  });
  it.each(["", "abc", "-1", "5XB", "MB", "1..5MB", "1 2MB", "10MB/s"])("rejects %j", (s) => expect(parseHumanSize(s)).toBeUndefined());
  it("parses rates with or without /s", () => {
    expect(parseHumanRate("10MB/s")).toBe(10 * 1024 ** 2);
    expect(parseHumanRate("500 KB/s")).toBe(500 * 1024);
    expect(parseHumanRate("2m")).toBe(2 * 1024 ** 2);
    expect(parseHumanRate("fast")).toBeUndefined();
  });
  it("formats sizes back to exact units", () => {
    expect([sizeToInput(null), sizeToInput(2 * 1024 ** 3), sizeToInput(500 * 1024 ** 2), sizeToInput(1500), sizeToInput(1024)]).toEqual(["", "2GB", "500MB", "1500", "1KB"]);
  });
});

describe("job form", () => {
  it("prefills excludes from DEFAULT_EXCLUDES and the documented defaults", async () => {
    const c = await setup();
    const body = (await get(c, "/jobs/new")).body;
    for (const g of DEFAULT_EXCLUDES) expect(body).toContain(g);
    expect(body).toContain('name="settle_seconds" value="300"');
    expect(body).toContain('name="parallel_files" value="2"');
    expect(body).toContain('name="range_streams" value="4"');
    expect(body).toContain('name="retries" value="3"');
    expect(body).toMatch(/<option value="copy_new" selected/);
    expect(body).toMatch(/<option value="top_dir" selected/);
  });

  it("offers mirror mode with its confirmation field, plus the browse and preview hooks", async () => {
    const c = await setup();
    const body = (await get(c, "/jobs/new")).body;
    expect(body).toMatch(/<option value="mirror">Mirror \(deletes local files/);
    expect(body).toContain('name="mirror_confirm"');
    expect(body).toMatch(/<option value="delete_after_days">/);
    expect(body).toMatch(/<option value="move">/);
    expect(body).toContain('name="after_days"');
    expect(body).toContain('name="move_to"');
    expect(body).toContain('hx-get="/browse/remote"');
    expect(body).toContain('hx-get="/browse/local"');
    expect(body).toContain('hx-get="/jobs/schedule-preview"');
    expect(body).toContain("Delete and move act only after the local copy is verified");
    expect(body).not.toMatch(/<script(?![^>]*src=)[^>]*>/);
  });
});

describe("job create", () => {
  it("creates a job, stores parsed values and notifies the scheduler", async () => {
    const c = await setup();
    const res = await create(c, { min_size: "500MB", max_size: "2GB", min_free_bytes: "20GB", bwlimit: "10MB/s", include_globs: "*.mkv\n\n*.mp4\n*.mkv", trust_mtime: "on", min_age_seconds: "60" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/jobs/1");
    expect(c.changed).toHaveBeenCalledTimes(1);
    expect(job(c)).toMatchObject({
      name: "Movies", hostId: c.sftp, remotePath: "/downloads", localPath: dl, mode: "copy_new", unitMode: "top_dir", afterSync: "keep", verify: "size",
      settleSeconds: 300, minAgeSeconds: 60, minSize: 524_288_000, maxSize: 2 * 1024 ** 3, minFreeBytes: 20 * 1024 ** 3, bwlimitBps: 10 * 1024 ** 2,
      includeGlobs: ["*.mkv", "*.mp4"], excludeGlobs: [...DEFAULT_EXCLUDES], trustMtime: true, enabled: true, parallelFiles: 2, rangeStreams: 4,
      retries: 3, scheduleKind: "manual", scheduleExpr: null, changedPolicy: "skip",
    });
  });

  it("stores the realpath of the local path and strips trailing slashes from the remote path", async () => {
    const c = await setup();
    fs.symlinkSync(path.join(root, "other"), path.join(root, "linked-other"));
    await create(c, { local_path: path.join(root, "linked-other"), remote_path: "/downloads///" });
    fs.unlinkSync(path.join(root, "linked-other"));
    expect(job(c)).toMatchObject({ localPath: path.join(root, "other"), remotePath: "/downloads" });
  });

  it("keeps enabled off when the checkbox is missing", async () => {
    const c = await setup();
    const p = payload(c);
    delete (p as Record<string, string | undefined>)["enabled"];
    await post(c, "/jobs", p);
    expect(job(c)?.enabled).toBe(false);
  });

  it("requires the name and rejects duplicates", async () => {
    const c = await setup();
    expect((await create(c, { name: "  " })).body).toContain("Name is required");
    await create(c);
    const dup = await create(c, { name: "movies" });
    expect(dup.statusCode).toBe(400);
    expect(dup.body).toContain("already exists");
    expect(c.h.deps.stores.jobs.list()).toHaveLength(1);
  });

  it("requires an existing host", async () => {
    const c = await setup();
    for (const host_id of ["", "999", "abc"]) {
      const res = await create(c, { host_id });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("Choose a host");
    }
  });

  it("redisplays typed values with inline errors and creates nothing", async () => {
    const c = await setup();
    const res = await create(c, { name: "My <job>", retries: "99" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("My &lt;job&gt;");
    expect(res.body).toContain("Enter a whole number from 0 to 10");
    expect(c.h.deps.stores.jobs.list()).toHaveLength(0);
    expect(c.changed).not.toHaveBeenCalled();
  });

  it.each([
    ["parallel_files", "0"], ["parallel_files", "17"], ["range_streams", "0"], ["range_streams", "9"], ["retries", "-1"], ["retries", "11"],
    ["settle_seconds", "abc"], ["settle_seconds", ""], ["min_age_seconds", "-5"], ["retries", "1.5"],
  ])("rejects %s = %j", async (field, value) => {
    const c = await setup();
    const res = await create(c, { [field]: value });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Enter a whole number from");
  });

  it.each([["parallel_files", "1"], ["parallel_files", "16"], ["range_streams", "8"], ["retries", "0"], ["retries", "10"]])("accepts %s = %s", async (field, value) => {
    const c = await setup();
    expect((await create(c, { [field]: value })).statusCode).toBe(303);
  });

  it.each([["min_size", "abc"], ["max_size", "5 parsecs"], ["min_free_bytes", "-3GB"], ["bwlimit", "fast"]])("rejects bad human value %s = %j", async (field, value) => {
    const c = await setup();
    const res = await create(c, { [field]: value });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("enter a size like");
  });

  it("treats zero and blank limits as unset and rejects min greater than max", async () => {
    const c = await setup();
    await create(c, { min_size: "0", max_size: "", bwlimit: "0", min_free_bytes: "" });
    expect(job(c)).toMatchObject({ minSize: null, maxSize: null, bwlimitBps: null, minFreeBytes: null });
    const res = await create(c, { name: "b", min_size: "2GB", max_size: "1GB" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("must not be smaller than the minimum");
  });

  it("validates glob patterns", async () => {
    const c = await setup();
    const longGlob = "a".repeat(301);
    for (const bad of [longGlob, "ok\u0001bad"]) {
      const res = await create(c, { include_globs: bad });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("Invalid pattern");
    }
    expect((await create(c, { exclude_globs: "" })).statusCode).toBe(303);
    expect(job(c)?.excludeGlobs).toEqual([]);
  });

  it("rejects unknown modes and unknown post-sync actions", async () => {
    const c = await setup();
    expect((await create(c, { mode: "sync-everything" })).body).toContain("Choose copy new files or mirror");
    const res = await create(c, { after_sync: "archive" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Choose keep, delete");
  });

  it("stores delete_after_days with its days and clears the move target", async () => {
    const c = await setup();
    expect((await create(c, { after_sync: "delete_after_days", after_days: "14", move_to: "/junk" })).statusCode).toBe(303);
    expect(job(c)).toMatchObject({ afterSync: "delete_after_days", afterDays: 14, moveTo: null });
  });

  it("requires 1 to 3650 days for delete_after_days", async () => {
    const c = await setup();
    for (const after_days of ["", "0", "3651", "abc", "1.5"]) {
      const res = await create(c, { after_sync: "delete_after_days", after_days });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("whole number of days from 1 to 3650");
    }
  });

  it("stores a normalized move target and rejects unsafe ones", async () => {
    const c = await setup();
    expect((await create(c, { after_sync: "move", move_to: "/done//sub/" })).statusCode).toBe(303);
    expect(job(c)).toMatchObject({ afterSync: "move", moveTo: "/done/sub", afterDays: null });
    for (const move_to of ["", "done", "/", "/downloads", "/downloads/done", "/a/../b"]) {
      const res = await create(c, { name: `m${move_to}`, after_sync: "move", move_to });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('class="field-error"');
    }
  });

  it("accepts after_sync delete and warns about it when editing", async () => {
    const c = await setup();
    expect((await create(c, { after_sync: "delete" })).statusCode).toBe(303);
    expect(job(c)?.afterSync).toBe("delete");
    expect((await get(c, "/jobs/1")).body).toContain("Remote files will be deleted after each verified copy");
  });

  it("rejects checksum on ftp hosts and accepts it on sftp", async () => {
    const c = await setup();
    const bad = await create(c, { host_id: String(c.ftp), verify: "checksum" });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain("FTP and FTPS servers provide no file hashes");
    expect((await create(c, { verify: "checksum" })).statusCode).toBe(303);
  });

  it("disables the checksum option for an ftp host on the edit page", async () => {
    const c = await setup();
    await create(c, { host_id: String(c.ftp) });
    expect((await get(c, "/jobs/1")).body).toMatch(/<option value="checksum" disabled>Checksum \(unavailable/);
    await create(c, { name: "sftp job" });
    expect((await get(c, "/jobs/2")).body).not.toMatch(/<option value="checksum" disabled/);
  });
});

describe("schedule validation", () => {
  it("stores valid cron and interval schedules", async () => {
    const c = await setup();
    await create(c, { schedule_kind: "cron", schedule_expr: "0 3 * * *" });
    await create(c, { name: "b", schedule_kind: "interval", schedule_expr: "6h" });
    expect(job(c, 1)).toMatchObject({ scheduleKind: "cron", scheduleExpr: "0 3 * * *" });
    expect(job(c, 2)).toMatchObject({ scheduleKind: "interval", scheduleExpr: "6h" });
  });

  it.each([["cron", "not a cron"], ["cron", "61 * * * *"], ["cron", ""], ["interval", "30s"], ["interval", "soon"], ["interval", ""]])("shows an inline error for %s %j", async (kind, expr) => {
    const c = await setup();
    const res = await create(c, { schedule_kind: kind, schedule_expr: expr });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/field-error[^<]*<|field-error">[^<]+/);
    expect(res.body).toMatch(/invalid|required|minimum|never/i);
    expect(c.h.deps.stores.jobs.list()).toHaveLength(0);
  });

  it("drops the expression for manual jobs and rejects unknown kinds", async () => {
    const c = await setup();
    await create(c, { schedule_kind: "manual", schedule_expr: "garbage" });
    expect(job(c)).toMatchObject({ scheduleKind: "manual", scheduleExpr: null });
    expect((await create(c, { name: "b", schedule_kind: "weekly" })).statusCode).toBe(400);
  });

  it("previews cron with human text and three next runs", async () => {
    const c = await setup();
    const res = await get(c, "/jobs/schedule-preview?schedule_kind=cron&schedule_expr=" + encodeURIComponent("0 3 * * *"));
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<html");
    expect(res.body).toContain("At 03:00");
    expect(res.body.match(/<time /g)).toHaveLength(3);
  });

  it("previews intervals, manual and errors", async () => {
    const c = await setup();
    expect((await get(c, "/jobs/schedule-preview?schedule_kind=interval&schedule_expr=6h")).body).toContain("every 6 hours");
    expect((await get(c, "/jobs/schedule-preview?schedule_kind=manual")).body).toContain("manual only");
    const bad = await get(c, "/jobs/schedule-preview?schedule_kind=cron&schedule_expr=nope");
    expect(bad.body).toContain("field-error");
    expect((await get(c, "/jobs/schedule-preview?schedule_kind=cron&schedule_expr=")).body).toContain("required");
  });
});

describe("local path validation (server side)", () => {
  const cases: [string, (c: Ctx) => string, string][] = [
    ["outside every root", () => path.join(base, "outside"), "inside one of the allowed folders"],
    ["a symlink out of the root", () => path.join(root, "escape"), "inside one of the allowed folders"],
    ["dot-dot tricks", () => `${dl}/../other`, ".."],
    ["a relative path", () => "downloads", "absolute"],
    ["a missing directory", () => path.join(root, "missing"), "does not exist"],
    ["a file", () => path.join(root, "afile"), "not a directory"],
    ["the config directory", () => cfgDir, "config directory"],
    ["a folder inside the config directory", () => { fs.mkdirSync(path.join(cfgDir, "db"), { recursive: true }); return path.join(cfgDir, "db"); }, "config directory"],
    ["a folder containing the config directory", () => root, "config directory"],
  ];
  it.each(cases)("rejects %s", async (_name, pick, message) => {
    const c = await setup();
    const res = await create(c, { local_path: pick(c) });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(message);
    expect(c.h.deps.stores.jobs.list()).toHaveLength(0);
  });

  it.skipIf(process.getuid?.() === 0)("rejects a directory that is not writable", async () => {
    const c = await setup();
    const ro = path.join(root, "readonly");
    fs.mkdirSync(ro);
    fs.chmodSync(ro, 0o500);
    const res = await create(c, { local_path: ro });
    fs.chmodSync(ro, 0o755);
    fs.rmdirSync(ro);
    expect(res.body).toContain("not writable");
  });

  it("revalidates the local path on update", async () => {
    const c = await setup();
    await create(c);
    const res = await post(c, "/jobs/1", payload(c, { local_path: path.join(root, "escape") }));
    expect(res.statusCode).toBe(400);
    expect(job(c)?.localPath).toBe(dl);
  });
});

describe("job edit, ledger reset, delete", () => {
  it("updates a job and shows the detail page with runs and links", async () => {
    const c = await setup();
    await create(c);
    const runId = c.h.deps.stores.runs.create(1, "manual", false);
    c.h.deps.stores.runs.setState(runId, "transferring");
    c.h.deps.stores.runs.setState(runId, "succeeded");
    const page = (await get(c, "/jobs/1")).body;
    expect(page).toContain("Recent runs");
    expect(page).toContain("st-succeeded");
    expect(page).toContain('href="/runs?job=1"');
    expect(page).toContain('href="/jobs/1/ledger"');
    expect(page).toContain("sftp-box");
    expect(page).toContain("Run now");
    c.changed.mockClear();
    const res = await post(c, "/jobs/1", payload(c, { name: "Renamed", retries: "5", schedule_kind: "interval", schedule_expr: "1h" }));
    expect(res.statusCode).toBe(303);
    expect(job(c)).toMatchObject({ name: "Renamed", retries: 5, scheduleExpr: "1h" });
    expect(c.changed).toHaveBeenCalledTimes(1);
  });

  it("404s unknown jobs and re-renders invalid updates with 400", async () => {
    const c = await setup();
    await create(c);
    expect((await get(c, "/jobs/99")).statusCode).toBe(404);
    expect((await get(c, "/jobs/abc")).statusCode).toBe(404);
    expect((await post(c, "/jobs/99", payload(c))).statusCode).toBe(404);
    const bad = await post(c, "/jobs/1", payload(c, { retries: "99" }));
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain("Edit job");
  });

  it("lets a job keep its own name on update", async () => {
    const c = await setup();
    await create(c);
    expect((await post(c, "/jobs/1", payload(c))).statusCode).toBe(303);
  });

  function spyForget(c: Ctx): number[] {
    const calls: number[] = [];
    const orig = c.h.deps.stores.ledger.forgetAll.bind(c.h.deps.stores.ledger);
    c.h.deps.stores.ledger.forgetAll = (id: number) => { calls.push(id); orig(id); };
    return calls;
  }

  it("needs confirmation to change the remote path, then resets the ledger", async () => {
    const c = await setup();
    await create(c);
    const calls = spyForget(c);
    const refused = await post(c, "/jobs/1", payload(c, { remote_path: "/other" }));
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain("resets this job's ledger");
    expect(job(c)?.remotePath).toBe("/downloads");
    expect(calls).toEqual([]);
    const ok = await post(c, "/jobs/1", payload(c, { remote_path: "/other", confirm_ledger_reset: "on" }));
    expect(ok.statusCode).toBe(303);
    expect(flashOf(ok)).toContain("ledger was reset");
    expect(job(c)?.remotePath).toBe("/other");
    expect(calls).toEqual([1]);
  });

  it("needs confirmation to change the host too", async () => {
    const c = await setup();
    await create(c);
    const calls = spyForget(c);
    expect((await post(c, "/jobs/1", payload(c, { host_id: String(c.ftp) }))).statusCode).toBe(400);
    expect(job(c)?.hostId).toBe(c.sftp);
    await post(c, "/jobs/1", payload(c, { host_id: String(c.ftp), confirm_ledger_reset: "on" }));
    expect(job(c)?.hostId).toBe(c.ftp);
    expect(calls).toEqual([1]);
  });

  it("does not reset the ledger for other changes, even if the box is ticked", async () => {
    const c = await setup();
    await create(c);
    const calls = spyForget(c);
    await post(c, "/jobs/1", payload(c, { retries: "4", confirm_ledger_reset: "on" }));
    expect(calls).toEqual([]);
  });

  it("deletes a job and notifies the scheduler", async () => {
    const c = await setup();
    await create(c);
    c.changed.mockClear();
    const res = await post(c, "/jobs/1/delete");
    expect(res.statusCode).toBe(303);
    expect(flashOf(res)).toContain("deleted");
    expect(job(c)).toBeUndefined();
    expect(c.changed).toHaveBeenCalledTimes(1);
    expect((await post(c, "/jobs/1/delete")).statusCode).toBe(404);
  });

  it("refuses to delete a running job", async () => {
    const c = await setup();
    await create(c);
    c.h.active.push({ runId: 1, jobId: 1, state: "transferring", trigger: "manual", startedAt: Date.now(), bytesDone: 0, bytesTotal: 0, speedBps: 0, activeFiles: [] });
    c.changed.mockClear();
    const res = await post(c, "/jobs/1/delete");
    expect(flashOf(res)).toContain("is running");
    expect(job(c)).toBeDefined();
    expect(c.changed).not.toHaveBeenCalled();
  });
});

describe("list, run now, toggle", () => {
  it("lists host, paths, schedule text, last run status and actions", async () => {
    const c = await setup();
    await create(c, { schedule_kind: "cron", schedule_expr: "0 3 * * *" });
    await create(c, { name: "Manual one" });
    const runId = c.h.deps.stores.runs.create(1, "cron", false);
    c.h.deps.stores.runs.setState(runId, "failed", "boom");
    const body = (await get(c, "/jobs")).body;
    expect(body).toContain("sftp-box");
    expect(body).toContain("/downloads");
    expect(body).toContain(dl);
    expect(body).toContain("At 03:00");
    expect(body).toContain("manual only");
    expect(body).toContain("st-failed");
    expect(body).toContain("no runs");
    expect(body).toContain('action="/jobs/1/run"');
    expect(body).toContain('action="/jobs/1/toggle"');
  });

  it("shows the empty state", async () => {
    const c = await setup();
    expect((await get(c, "/jobs")).body).toContain("No jobs yet");
  });

  it("run now triggers a manual run and shows the result message", async () => {
    const c = await setup();
    await create(c);
    const res = await post(c, "/jobs/1/run");
    expect(c.trigger).toHaveBeenCalledWith(1, "manual");
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/jobs");
    expect(flashOf(res)).toBe("ok:Run #7 started.");
    const detail = await post(c, "/jobs/1/run", { next: "detail" });
    expect(detail.headers.location).toBe("/jobs/1");
  });

  it.each<[TriggerResult, string]>([
    [{ status: "queued", runId: 8 }, "Run #8 queued"],
    [{ status: "skipped_locked", runId: 9 }, "already running"],
    [{ status: "rerun_pending" }, "run again when it finishes"],
    [{ status: "disabled" }, "disabled"],
  ])("maps trigger result %j", async (result, text) => {
    const c = await setup();
    await create(c);
    c.trigger.mockReturnValue(result);
    expect(flashOf(await post(c, "/jobs/1/run"))).toContain(text);
  });

  it("404s run and toggle for unknown jobs and never triggers", async () => {
    const c = await setup();
    expect((await post(c, "/jobs/5/run")).statusCode).toBe(404);
    expect((await post(c, "/jobs/5/toggle")).statusCode).toBe(404);
    expect(c.trigger).not.toHaveBeenCalled();
  });

  it("toggles enabled and notifies the scheduler", async () => {
    const c = await setup();
    await create(c);
    c.changed.mockClear();
    expect(flashOf(await post(c, "/jobs/1/toggle"))).toContain("disabled");
    expect(job(c)?.enabled).toBe(false);
    expect(flashOf(await post(c, "/jobs/1/toggle"))).toContain("enabled");
    expect(job(c)?.enabled).toBe(true);
    expect(c.changed).toHaveBeenCalledTimes(2);
  });

  it("inherits CSRF and Origin enforcement on every mutation", async () => {
    const c = await setup();
    await create(c);
    for (const url of ["/jobs/1/run", "/jobs/1/toggle", "/jobs/1/delete", "/jobs/1", "/jobs"]) {
      const noToken = await req(c.h, { method: "POST", url, sid: c.sid, payload: form(payload(c)), headers: { "content-type": "application/x-www-form-urlencoded" } });
      expect(noToken.statusCode).toBe(403);
      const evil = await req(c.h, { method: "POST", url, sid: c.sid, origin: "http://evil.example", payload: form({ _csrf: c.csrf, ...payload(c) }), headers: { "content-type": "application/x-www-form-urlencoded" } });
      expect(evil.statusCode).toBe(403);
    }
    expect(c.trigger).not.toHaveBeenCalled();
    expect(job(c)).toBeDefined();
  });
});

describe("mirror mode", () => {
  const mirror = (o: Record<string, string> = {}) => ({ mode: "mirror", mirror_confirm: "Movies", ...o });

  it("needs the job name typed in before a job can be created in mirror mode", async () => {
    const c = await setup();
    const none = await create(c, { mode: "mirror" });
    expect(none.statusCode).toBe(400);
    expect(none.body).toContain("Type the job name here to confirm");
    expect((await create(c, mirror({ mirror_confirm: "movies2" }))).statusCode).toBe(400);
    expect(job(c)).toBeUndefined();
    expect((await create(c, mirror({ mirror_confirm: "  movies " }))).statusCode).toBe(303);
    c.h.deps.stores.jobs.delete(1);
    const ok = await create(c, mirror());
    expect(ok.statusCode).toBe(303);
    expect(job(c)).toMatchObject({ mode: "mirror", mirrorArmedAt: null });
    expect(flashOf(ok)).toContain("not armed");
  });

  it("only works with after-sync keep", async () => {
    const c = await setup();
    for (const after_sync of ["delete", "delete_after_days", "move"]) {
      const res = await create(c, mirror({ after_sync, after_days: "5", move_to: "/done" }));
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("Mirror mode needs");
    }
    expect(job(c)).toBeUndefined();
  });

  it("says at the top of the page that a rejected mirror save changed nothing, and why", async () => {
    const c = await setup();
    await create(c);
    const noName = await post(c, "/jobs/1", payload(c, { mode: "mirror" }));
    expect(noName.statusCode).toBe(400);
    expect(noName.body.indexOf('id="form-errors"')).toBeGreaterThan(-1);
    expect(noName.body.indexOf('id="form-errors"')).toBeLessThan(noName.body.indexOf("Webhook triggers"));
    expect(noName.body).toContain("Not saved.");
    expect(noName.body).toContain('href="#mirror_confirm"');
    expect(noName.body).toContain("Type the job name here to confirm");
    expect(job(c)?.mode).toBe("copy_new");
    const afterSync = await post(c, "/jobs/1", payload(c, mirror({ after_sync: "delete" })));
    expect(afterSync.body).toContain('href="#after_sync"');
    expect(afterSync.body).toContain("Mirror mode needs");
    const created = await create(c, { name: "Other", mode: "mirror" });
    expect(created.body).toContain('id="form-errors"');
  });

  it("shows no error summary on a normal page or a successful save", async () => {
    const c = await setup();
    await create(c);
    expect((await get(c, "/jobs/1")).body).not.toContain("form-errors");
    expect((await get(c, "/jobs/new")).body).not.toContain("form-errors");
    expect((await post(c, "/jobs/1", payload(c))).statusCode).toBe(303);
  });

  it("asks for the name again only when switching an existing job to mirror", async () => {
    const c = await setup();
    await create(c);
    const refused = await post(c, "/jobs/1", payload(c, { mode: "mirror" }));
    expect(refused.statusCode).toBe(400);
    expect(job(c)?.mode).toBe("copy_new");
    expect((await post(c, "/jobs/1", payload(c, mirror()))).statusCode).toBe(303);
    expect(job(c)?.mode).toBe("mirror");
    expect((await post(c, "/jobs/1", payload(c, { mode: "mirror", retries: "4" }))).statusCode).toBe(303);
    expect(job(c)?.retries).toBe(4);
  });

  it("keeps the job armed across harmless edits and disarms it when mode or local path change", async () => {
    const c = await setup();
    await create(c, mirror());
    c.h.deps.stores.jobs.update(1, { mirrorArmedAt: 123 });
    await post(c, "/jobs/1", payload(c, { mode: "mirror", retries: "5", settle_seconds: "10" }));
    expect(job(c)?.mirrorArmedAt).toBe(123);
    await post(c, "/jobs/1", payload(c, { mode: "mirror", local_path: path.join(root, "other") }));
    expect(job(c)).toMatchObject({ mirrorArmedAt: null, localPath: path.join(root, "other") });
    c.h.deps.stores.jobs.update(1, { mirrorArmedAt: 456 });
    await post(c, "/jobs/1", payload(c, { mode: "copy_new", local_path: path.join(root, "other") }));
    expect(job(c)).toMatchObject({ mode: "copy_new", mirrorArmedAt: null });
  });

  it("disarms when the remote path changes, together with the ledger reset", async () => {
    const c = await setup();
    await create(c, mirror());
    c.h.deps.stores.jobs.update(1, { mirrorArmedAt: 789 });
    await post(c, "/jobs/1", payload(c, { mode: "mirror", remote_path: "/elsewhere", confirm_ledger_reset: "on" }));
    expect(job(c)).toMatchObject({ remotePath: "/elsewhere", mirrorArmedAt: null });
  });

  it("shows the arming state on the job page", async () => {
    const c = await setup();
    await create(c, mirror());
    expect((await get(c, "/jobs/1")).body).toContain("not armed: run a dry run");
    c.h.deps.stores.jobs.update(1, { mirrorArmedAt: 1_700_000_000_000 });
    const body = (await get(c, "/jobs/1")).body;
    expect(body).toContain("mirror (armed 2023-11-14 22:13:20 UTC)");
    expect(body).not.toContain("&lt;time");
  });
});

describe("mirror safety limits", () => {
  const mirror = (o: Record<string, string> = {}) => ({ mode: "mirror", mirror_confirm: "Movies", ...o });

  it("offers the permission only on mirror jobs, and shows when it is active", async () => {
    const c = await setup();
    await create(c);
    expect((await get(c, "/jobs/1")).body).not.toContain("Mirror safety limits");
    await post(c, "/jobs/1", payload(c, mirror()));
    const page = (await get(c, "/jobs/1")).body;
    expect(page).toContain("Mirror safety limits");
    expect(page).toContain('action="/jobs/1/mirror-allow"');
    expect(page).toContain("Allow one large delete");
    c.h.deps.stores.jobs.update(1, { mirrorAllowLargeAt: Date.now() });
    const active = (await get(c, "/jobs/1")).body;
    expect(active).toContain('action="/jobs/1/mirror-disallow"');
    expect(active).toContain("used up by that run");
  });

  it("needs the checkbox, and only works for mirror jobs", async () => {
    const c = await setup();
    await create(c);
    const copy = await post(c, "/jobs/1/mirror-allow", { confirm: "on" });
    expect(flashOf(copy)).toContain("Only mirror jobs");
    expect(job(c)?.mirrorAllowLargeAt).toBeNull();
    await post(c, "/jobs/1", payload(c, mirror()));
    expect(flashOf(await post(c, "/jobs/1/mirror-allow"))).toContain("Tick the box");
    expect(job(c)?.mirrorAllowLargeAt).toBeNull();
    const ok = await post(c, "/jobs/1/mirror-allow", { confirm: "on" });
    expect(ok.statusCode).toBe(303);
    expect(job(c)?.mirrorAllowLargeAt).not.toBeNull();
    await post(c, "/jobs/1/mirror-disallow");
    expect(job(c)?.mirrorAllowLargeAt).toBeNull();
  });

  it("is revoked by editing the mode or paths, and kept by harmless edits", async () => {
    const c = await setup();
    await create(c, mirror());
    c.h.deps.stores.jobs.update(1, { mirrorArmedAt: 1, mirrorAllowLargeAt: 2 });
    await post(c, "/jobs/1", payload(c, { mode: "mirror", retries: "5" }));
    expect(job(c)).toMatchObject({ mirrorArmedAt: 1, mirrorAllowLargeAt: 2 });
    await post(c, "/jobs/1", payload(c, { mode: "copy_new" }));
    expect(job(c)).toMatchObject({ mirrorArmedAt: null, mirrorAllowLargeAt: null });
  });

  it("404s unknown jobs and enforces CSRF", async () => {
    const c = await setup();
    expect((await post(c, "/jobs/99/mirror-allow", { confirm: "on" })).statusCode).toBe(404);
    await create(c, mirror());
    const noToken = await req(c.h, { method: "POST", url: "/jobs/1/mirror-allow", sid: c.sid, payload: form({ confirm: "on" }), headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(noToken.statusCode).toBe(403);
    expect(job(c)?.mirrorAllowLargeAt).toBeNull();
  });
});
