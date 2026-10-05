import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { warnInsecureConfig } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { buildLogger } from "../../src/logger.js";
import { parseHostForm, sanitizeSummary } from "../../src/web/host-schemas.js";
import { safeSlice, setFlash, wellFormed } from "../../src/web/helpers.js";
import { NEW_JOB_VALUES, globProblem, parseJobForm } from "../../src/web/job-schemas.js";
import { listLocal } from "../../src/web/local-browse.js";
import { registerJobRoutes } from "../../src/web/routes-jobs.js";
import { registerLedgerRoutes } from "../../src/web/routes-ledger.js";
import { registerSettingsRoutes } from "../../src/web/routes-settings.js";
import { SETTINGS_KEYS, readSettings, writeSettings } from "../../src/web/settings-schema.js";
import { registerHostRoutes } from "../../src/web/routes-hosts.js";
import { makeHarness, req, session } from "./harness.js";

const jobBody = (o: Record<string, string>) => ({ ...NEW_JOB_VALUES, name: "j", remote_path: "/r", local_path: "/data", host_id: "1", ...o });
const flashOf = (res: { cookies: { name: string; value: string }[] }) => decodeURIComponent(res.cookies.find((c) => c.name === "harvest_flash")?.value ?? "");
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

describe("glob validation", () => {
  it("rejects regex groups, extglobs, backslashes and catastrophic stars", () => {
    for (const bad of ["(a+)+$", "+(a)", "*(a|b)", "?(x)", "@(x)", "!(x)", "a\\b", "a*a*a*a*b", "{1..99999}", "**/**/**/x", "a".repeat(201)]) {
      expect(globProblem(bad), bad).not.toBeNull();
    }
  });

  it("keeps plain globs", () => {
    for (const ok of ["*", "**", "**/*.mkv", "?x", "[abc]*", "{a,b}*", "**/*.!qB", "*foo*bar*", "**/.incomplete/**"]) {
      expect(globProblem(ok), ok).toBeNull();
    }
  });

  it("rejects the catastrophic pattern at save time, quickly", () => {
    const t = Date.now();
    const r = parseJobForm(jobBody({ include_globs: "(a+)+$" }));
    expect(r.ok).toBe(false);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it("caps globs per list at 50 and the schedule at 200 characters", () => {
    const many = Array.from({ length: 51 }, (_, i) => `f${i}*`).join("\n");
    expect(parseJobForm(jobBody({ include_globs: many })).ok).toBe(false);
    expect(parseJobForm(jobBody({ include_globs: many.split("\n").slice(0, 50).join("\n") })).ok).toBe(true);
    const long = parseJobForm(jobBody({ schedule_kind: "cron", schedule_expr: "*".repeat(201) }));
    expect(long.ok).toBe(false);
  });
});

describe("host form and text safety", () => {
  it("rejects a host that starts with a dash", () => {
    const r = parseHostForm({ name: "n", protocol: "sftp", host: "-oProxyCommand=x", username: "u" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors["host"]).toContain("dash");
  });

  it("never cuts a surrogate pair or throws on lone surrogates", () => {
    const text = "a".repeat(159) + "\u{1F600}tail";
    expect(sanitizeSummary(text, {}).endsWith("\ud83d")).toBe(false);
    expect(safeSlice(text, 160)).toBe("a".repeat(159));
    expect(() => encodeURIComponent(wellFormed("x\ud800y"))).not.toThrow();
    expect(wellFormed("x\ud800y")).toBe("x�y");
  });

  it("sets the flash cookie Secure with COOKIE_SECURE and survives a lone surrogate", async () => {
    const h = await makeHarness({ env: { COOKIE_SECURE: "true" }, routes: [(app) => {
      app.get("/flash", async (_r, reply) => { setFlash(reply, "ok", "bad \ud800 text"); return reply.send("x"); });
    }] });
    const { sid } = await session(h);
    const res = await req(h, { method: "GET", url: "/flash", sid });
    expect(res.statusCode).toBe(200);
    const c = res.cookies.find((x) => x.name === "harvest_flash");
    expect(c?.secure).toBe(true);
  });
});

describe("settings and job hooks that throw after the write", () => {
  it("writes both settings keys in one transaction", async () => {
    const h = await makeHarness();
    const real = h.deps.stores.settings.setJson.bind(h.deps.stores.settings);
    vi.spyOn(h.deps.stores.settings, "setJson").mockImplementation((k, v) => {
      if (k === SETTINGS_KEYS.retention) throw new Error("disk full");
      real(k, v);
    });
    const next = { bwlimitGlobalBps: 1000, bwProfiles: [], retention: readSettings(h.deps.stores).retention };
    expect(() => writeSettings(h.deps.db, h.deps.stores, next)).toThrow("disk full");
    vi.restoreAllMocks();
    expect(readSettings(h.deps.stores).bwlimitGlobalBps).toBeNull();
  });

  it("flashes saved-but-not-applied when onSettingsChanged throws", async () => {
    const h = await makeHarness({ routes: [registerSettingsRoutes] });
    h.deps.onSettingsChanged = () => { throw new Error("corrupt"); };
    const { sid, csrf } = await session(h);
    const res = await req(h, { method: "POST", url: "/settings", sid, headers: { "x-csrf-token": csrf },
      payload: { bwlimit: "5M", activityDays: "90", runDays: "180", observationDays: "30" } });
    expect(res.statusCode).toBe(303);
    expect(flashOf(res)).toContain("not applied");
    expect(readSettings(h.deps.stores).bwlimitGlobalBps).toBe(5 * 1024 * 1024);
  });

  it("opens the settings page and saves over corrupt stored settings", async () => {
    const h = await makeHarness({ routes: [registerSettingsRoutes] });
    h.deps.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTINGS_KEYS.retention, "{not json");
    const { sid, csrf } = await session(h);
    expect((await req(h, { method: "GET", url: "/settings", sid })).statusCode).toBe(200);
    const res = await req(h, { method: "POST", url: "/settings", sid, headers: { "x-csrf-token": csrf },
      payload: { bwlimit: "", activityDays: "90", runDays: "180", observationDays: "30" } });
    expect(res.statusCode).toBe(303);
  });

  it("flashes saved-but-not-applied when the scheduler reload throws", async () => {
    const h = await makeHarness({ routes: [registerHostRoutes, registerJobRoutes] });
    h.deps.onJobsChanged = () => { throw new Error("reload failed"); };
    const hostId = h.deps.stores.hosts.create({ name: "h", protocol: "ftp", host: "x.test", port: 21, username: "u" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hv-data-"));
    const cfg = loadConfig({ BROWSE_ROOTS: dir, CONFIG_DIR: "/tmp/harvest-web-test" });
    Object.assign(h.deps.config, { BROWSE_ROOTS: cfg.BROWSE_ROOTS });
    const { sid, csrf } = await session(h);
    const res = await req(h, { method: "POST", url: "/jobs", sid, payload: form({ _csrf: csrf, ...jobBody({ host_id: String(hostId), local_path: dir }) }),
      headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(res.statusCode).toBe(303);
    expect(flashOf(res)).toContain("not applied");
    expect(h.deps.stores.jobs.list()).toHaveLength(1);
  });
});

describe("ledger JSON bodies", () => {
  it.each(['"just a string"', "[1,2]", "42", "null", "true"])("forget-all with body %s is a 400, not a 500", async (body) => {
    const h = await makeHarness({ routes: [registerLedgerRoutes] });
    const hostId = h.deps.stores.hosts.create({ name: "h", protocol: "sftp", host: "x.test", port: 22, username: "u" });
    const jobId = h.deps.stores.jobs.create({ name: "J", hostId, remotePath: "/r", localPath: "/tmp/x" });
    const { sid, csrf } = await session(h);
    const res = await req(h, { method: "POST", url: `/jobs/${jobId}/ledger/forget-all`, sid, payload: body, headers: { "content-type": "application/json", "x-csrf-token": csrf } });
    expect(res.statusCode).toBe(400);
  });
});

describe("store refusals", () => {
  it("explains that a job with a queued run cannot be deleted, and a host in use", async () => {
    const h = await makeHarness({ routes: [registerHostRoutes, registerJobRoutes] });
    const hostId = h.deps.stores.hosts.create({ name: "h", protocol: "sftp", host: "x.test", port: 22, username: "u" });
    const jobId = h.deps.stores.jobs.create({ name: "J", hostId, remotePath: "/r", localPath: "/tmp/x" });
    h.deps.stores.runs.create(jobId, "manual", false);
    const { sid, csrf } = await session(h);
    const post = (url: string) => req(h, { method: "POST", url, sid, headers: { "x-csrf-token": csrf } });
    const job = await post(`/jobs/${jobId}/delete`);
    expect(job.statusCode).toBe(303);
    expect(flashOf(job)).toContain("Cancel the run first");
    const host = await post(`/hosts/${hostId}/delete`);
    expect(flashOf(host)).toContain("is used by 1 job (J)");
  });
});

describe("DNS rebinding advice, health and caching", () => {
  it("extends the AUTH_MODE=none banner when ALLOWED_HOSTS is unset", async () => {
    const h = await makeHarness({ user: false, env: { AUTH_MODE: "none" } });
    const body = (await req(h, { method: "GET", url: "/" })).body;
    expect(body).toContain("Authentication is disabled");
    expect(body).toContain("ALLOWED_HOSTS");
    expect(body).toContain("PUBLIC_URL");
    const h2 = await makeHarness({ user: false, env: { AUTH_MODE: "none", ALLOWED_HOSTS: "harvest.test" } });
    expect((await req(h2, { method: "GET", url: "/" })).body).not.toContain("DNS rebinding");
  });

  it("logs a loud startup warning", () => {
    const lines: string[] = [];
    const logger = buildLogger("info", false, { write: (s: string) => { lines.push(s); } } as never);
    warnInsecureConfig(loadConfig({ AUTH_MODE: "none" }), logger);
    warnInsecureConfig(loadConfig({ TRUST_PROXY: "true" }), logger);
    warnInsecureConfig(loadConfig({ AUTH_MODE: "none", ALLOWED_HOSTS: "a.test", TRUST_PROXY: "1" }), logger);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("ALLOWED_HOSTS");
    expect(lines[1]).toContain("X-Forwarded-For");
  });

  it("/healthz checks the database, ignores ALLOWED_HOSTS and needs no session", async () => {
    const h = await makeHarness({ env: { ALLOWED_HOSTS: "harvest.test" } });
    const ok = await req(h, { method: "GET", url: "/healthz", headers: { host: "other.test" } });
    expect(ok.statusCode).toBe(200);
    h.deps.db.close();
    const bad = await req(h, { method: "GET", url: "/healthz" });
    expect(bad.statusCode).toBe(503);
  });

  it("marks authenticated HTML no-store but not the login page", async () => {
    const h = await makeHarness();
    expect((await req(h, { method: "GET", url: "/login" })).headers["cache-control"]).toBeUndefined();
    const { sid } = await session(h);
    expect((await req(h, { method: "GET", url: "/", sid })).headers["cache-control"]).toBe("no-store");
  });
});

describe("local browse and dashboard", () => {
  let dir = "";
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ""; });

  it("hides a CONFIG_DIR nested inside a browse root", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hv-root-"));
    fs.mkdirSync(path.join(dir, "config"));
    fs.mkdirSync(path.join(dir, "media"));
    const config = loadConfig({ BROWSE_ROOTS: dir, CONFIG_DIR: path.join(dir, "config") });
    const l = await listLocal(dir, config);
    expect(l.ok && l.kind === "dir" && l.dirs.map((d) => d.name)).toEqual(["media"]);
    const inside = await listLocal(path.join(dir, "config"), config);
    expect(inside.ok).toBe(false);
  });

  it("loads last runs without one query per job when runs are recent", async () => {
    const h = await makeHarness();
    const hostId = h.deps.stores.hosts.create({ name: "h", protocol: "sftp", host: "x.test", port: 22, username: "u" });
    for (const n of ["a", "b", "c"]) {
      const jobId = h.deps.stores.jobs.create({ name: n, hostId, remotePath: "/r", localPath: "/tmp/x" });
      h.deps.stores.runs.create(jobId, "manual", false);
    }
    const spy = vi.spyOn(h.deps.stores.runs, "list");
    const { sid } = await session(h);
    expect((await req(h, { method: "GET", url: "/", sid })).statusCode).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });
});
