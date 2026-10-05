import { describe, expect, it } from "vitest";
import type { TriggerResult } from "../../src/run/manager-types.js";
import { csrfOf, makeHarness, req, session, type Harness } from "./harness.js";
import { registerHookRoutes } from "../../src/web/routes-hooks.js";
import { registerTokenRoutes } from "../../src/web/routes-tokens.js";

async function setup(env: Record<string, string> = {}) {
  const h = await makeHarness({ env, routes: [registerHookRoutes, registerTokenRoutes] });
  const host = h.deps.stores.hosts.create({ name: "h", protocol: "sftp", host: "e.com", port: 22, username: "u", secret: { password: "p" } });
  const job3 = h.deps.stores.jobs.create({ name: "j3", hostId: host, remotePath: "/a", localPath: "/l" });
  const job4 = h.deps.stores.jobs.create({ name: "j4", hostId: host, remotePath: "/b", localPath: "/m" });
  const calls: [number, string][] = [];
  let result: TriggerResult = { status: "started", runId: 7 };
  h.deps.manager.trigger = (id, t) => { calls.push([id, t]); return result; };
  return { h, job3, job4, calls, setResult: (r: TriggerResult) => { result = r; } };
}

const hook = (h: Harness, id: number, token: string | null, url = `/hooks/jobs/${id}`) =>
  req(h, { method: "POST", url, origin: null, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("POST /hooks/jobs/:id", () => {
  it("triggers with a valid bearer token, without session, CSRF or Origin, even with AUTH_MODE=none", async () => {
    for (const env of [{}, { AUTH_MODE: "none" }] as Record<string, string>[]) {
      const { h, job3, calls } = await setup(env);
      const { token } = h.deps.stores.tokens.create(job3, "t");
      const res = await hook(h, job3, token);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: "started", runId: 7 });
      expect(calls).toEqual([[job3, "webhook"]]);
      expect(h.deps.stores.tokens.listForJob(job3)[0]?.lastUsedAt).not.toBeNull();
    }
  });

  it("answers missing, unknown and other-job tokens identically with 401", async () => {
    const { h, job3, job4, calls } = await setup();
    const { token } = h.deps.stores.tokens.create(job3, "t");
    const bodies = [await hook(h, job3, null), await hook(h, job3, "nope"), await hook(h, job4, token), await hook(h, 999, token)];
    // A non-numeric id is outside the exemption, so the CSRF/Origin guard answers before the route does.
    expect((await hook(h, job3, token, "/hooks/jobs/abc")).statusCode).toBe(403);
    for (const r of bodies) { expect(r.statusCode).toBe(401); expect(r.body).toBe(bodies[0]?.body); }
    expect(calls).toEqual([]);
  });

  it("maps trigger results to status codes", async () => {
    const { h, job3, setResult } = await setup();
    const cases: [TriggerResult, number][] = [
      [{ status: "queued", runId: 1 }, 202], [{ status: "rerun_pending" }, 202],
      [{ status: "skipped_locked", runId: 2 }, 409], [{ status: "disabled" }, 409],
    ];
    for (const [r, code] of cases) {
      setResult(r);
      const { token } = h.deps.stores.tokens.create(job3, "t");
      expect((await hook(h, job3, token)).statusCode).toBe(code);
    }
  });

  it("rate limits per token (6 per minute) and not across tokens", async () => {
    const { h, job3 } = await setup();
    const a = h.deps.stores.tokens.create(job3, "a").token;
    const b = h.deps.stores.tokens.create(job3, "b").token;
    for (let i = 0; i < 6; i++) expect((await hook(h, job3, a)).statusCode).toBe(202);
    const limited = await hook(h, job3, a);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await hook(h, job3, b)).statusCode).toBe(202);
  });

  it("accepts ?token= with a warning logged once, and never logs the token", async () => {
    const { h, job3 } = await setup();
    const { token } = h.deps.stores.tokens.create(job3, "t");
    for (let i = 0; i < 2; i++) {
      const res = await req(h, { method: "POST", url: `/hooks/jobs/${job3}?token=${token}`, origin: null, headers: { referer: `http://x/?token=${token}` } });
      expect(res.statusCode).toBe(202);
    }
    const out = h.logs.join("");
    expect(out.match(/query string/g)?.length).toBe(1);
    expect(out).not.toContain(token);
  });

  it("does not exempt other mutations from CSRF", async () => {
    const { h, job3 } = await setup();
    const { sid } = await session(h);
    const res = await req(h, { method: "POST", url: `/jobs/${job3}/tokens`, sid, payload: { name: "x" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("token management UI", () => {
  it("creates a token shown once, lists it, and revokes it", async () => {
    const { h, job3 } = await setup();
    const { sid, csrf } = await session(h);
    const headers = { "x-csrf-token": csrf };
    const created = await req(h, { method: "POST", url: `/jobs/${job3}/tokens`, sid, headers, payload: { name: "qbit" } });
    expect(created.statusCode).toBe(200);
    const token = /<code id="new-token">([^<]+)<\/code>/.exec(created.body)?.[1] ?? "";
    expect(token).toHaveLength(43);
    expect(created.body).toContain(`Bearer ${token}`);
    const again = await req(h, { method: "GET", url: `/jobs/${job3}/webhook`, sid });
    expect(again.body).not.toContain(token);
    expect(again.body).toContain("YOUR_TOKEN");
    expect(again.body).toContain("qbit");
    const id = h.deps.stores.tokens.listForJob(job3)[0]?.id;
    const rev = await req(h, { method: "POST", url: `/jobs/${job3}/tokens/${id}/revoke`, sid, headers });
    expect(rev.statusCode).toBe(303);
    expect(h.deps.stores.tokens.verify(token)).toBeUndefined();
    expect(csrfOf(again.body)).toBe(csrf);
  });

  it("rejects an empty name with 400 and 404s for unknown jobs", async () => {
    const { h, job3 } = await setup();
    const { sid, csrf } = await session(h);
    const headers = { "x-csrf-token": csrf };
    const bad = await req(h, { method: "POST", url: `/jobs/${job3}/tokens`, sid, headers, payload: { name: " " } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain("Enter a name.");
    expect((await req(h, { method: "GET", url: "/jobs/999/webhook", sid })).statusCode).toBe(404);
  });
});
