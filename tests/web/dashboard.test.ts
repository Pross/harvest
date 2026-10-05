import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActiveRun } from "../../src/run/manager-types.js";
import { makeHarness, req, session, type Harness } from "./harness.js";

function seedJob(h: Harness, name: string, localPath: string, schedule?: string): number {
  const hostId = h.deps.stores.hosts.create({ name: `h-${name}`, protocol: "sftp", host: "example.org", port: 22, username: "u" });
  return h.deps.stores.jobs.create({
    name, hostId, remotePath: "/r", localPath,
    ...(schedule ? { scheduleKind: "cron" as const, scheduleExpr: schedule } : {}),
  });
}

describe("dashboard", () => {
  it("renders with no data", async () => {
    const h = await makeHarness();
    const { sid } = await session(h);
    const res = await req(h, { method: "GET", url: "/", sid });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("No transfers running.");
    expect(res.body).toContain("Nothing scheduled.");
    expect(res.body).toContain("No jobs yet.");
    expect(res.body).toContain("<svg");
    expect(res.body).toContain("No local targets yet.");
  });

  it("renders context keys, nav and the generated-secret banner", async () => {
    const h = await makeHarness({ secretSource: "generated" });
    const { sid } = await session(h);
    const res = await req(h, { method: "GET", url: "/", sid });
    expect(res.body).toContain("APP_SECRET");
    expect(res.body).toContain('aria-current="page"');
    expect(res.body).toContain("admin");
    expect(res.body).toContain('action="/logout"');
    const plain = await makeHarness();
    const s2 = await session(plain);
    expect((await req(plain, { method: "GET", url: "/", sid: s2.sid })).body).not.toContain("generated");
  });

  it("renders active transfers, next runs, last runs, volume and disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-dash-"));
    const h = await makeHarness();
    const jobId = seedJob(h, "Seedbox <movies>", dir, "0 3 * * *");
    seedJob(h, "Broken target", "/definitely/not/here");
    const runId = h.deps.stores.runs.create(jobId, "manual", false);
    h.deps.stores.runs.setState(runId, "transferring");
    h.deps.stores.runs.addProgress(runId, { bytesDone: 5_000_000, filesOk: 2 });
    h.deps.stores.runs.setState(runId, "succeeded");
    const active: ActiveRun = {
      runId: 99, jobId, state: "transferring", trigger: "manual", startedAt: Date.now(), bytesDone: 50 * 1024 * 1024,
      bytesTotal: 100 * 1024 * 1024, speedBps: 5 * 1024 * 1024,
      activeFiles: [{ path: "Movies/big.mkv", bytes: 10, total: 100 }],
    };
    h.active.push(active);
    h.next.push({ jobId, next: new Date(Date.now() + 2 * 3600_000 + 60_000) }, { jobId: 12345, next: new Date() }, { jobId, next: null });
    const { sid } = await session(h);
    const res = await req(h, { method: "GET", url: "/", sid });
    expect(res.statusCode).toBe(200);
    const b = res.body;
    expect(b).toContain("Seedbox &lt;movies&gt;");
    expect(b).not.toContain("Seedbox <movies>");
    expect(b).toContain("Movies/big.mkv");
    expect(b).toContain("50%");
    expect(b).toContain("5.00 MiB/s");
    expect(b).toContain("ETA 10s");
    expect(b).toContain("At 03:00 AM");
    expect(b).toContain("in 2 h");
    expect(b).toContain("st-succeeded");
    expect(b).toContain("4.77 MiB");
    expect(b).toContain(dir);
    expect(b).toContain("unavailable");
    expect(b).toContain('sse-connect="/events"');
    expect(b).toContain("/static/vendor/htmx.min.js");
    expect(b).not.toMatch(/https?:\/\/(?!harvest\.test)[a-z.]*\/[^"' ]*\.js/);
  });

  it("serves fragments for the htmx refresh and 404s unknown panels", async () => {
    const h = await makeHarness();
    const { sid } = await session(h);
    const ok = await req(h, { method: "GET", url: "/fragments/last-runs", sid });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).not.toContain("<html");
    expect((await req(h, { method: "GET", url: "/fragments/constructor", sid })).statusCode).toBe(404);
    expect((await req(h, { method: "GET", url: "/fragments/nope", sid })).statusCode).toBe(404);
  });

  it("flash messages render once and are cleared", async () => {
    const h = await makeHarness({ routes: [(app, deps) => {
      app.get("/flash-test", async (_req, reply) => {
        const { redirectTo } = await import("../../src/web/helpers.js");
        void deps;
        return redirectTo(reply, "/", { kind: "ok", message: "Saved <b>it</b>" });
      });
    }] });
    const { sid } = await session(h);
    const r = await req(h, { method: "GET", url: "/flash-test", sid });
    const flash = r.cookies.find((c) => c.name === "harvest_flash")?.value ?? "";
    expect(flash).not.toBe("");
    const page = await h.app.inject({ method: "GET", url: "/", headers: { host: "harvest.test", cookie: `harvest_sid=${sid}; harvest_flash=${flash}` } });
    expect(page.body).toContain("Saved &lt;b&gt;it&lt;/b&gt;");
    expect(page.cookies.find((c) => c.name === "harvest_flash")?.value).toBe("");
  });
});
