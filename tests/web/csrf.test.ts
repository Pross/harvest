import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { csrfOf, makeHarness, req, session, ORIGIN } from "./harness.js";

const echo = (app: FastifyInstance) => {
  app.post("/echo", async () => ({ ok: true }));
  app.post("/hooks/jobs/1", async () => ({ hook: true }));
  app.post("/hooks/other", async () => ({ hook: true }));
  app.post("/hooks/jobs/1/extra", async () => ({ hook: true }));
};

describe("CSRF and Origin (builtin)", () => {
  it("rejects a mutation without a token (403)", async () => {
    const h = await makeHarness({ routes: [echo] });
    const { sid } = await session(h);
    const res = await req(h, { method: "POST", url: "/echo", sid, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("CSRF");
  });

  it("rejects a wrong token", async () => {
    const h = await makeHarness({ routes: [echo] });
    const { sid } = await session(h);
    const res = await req(h, { method: "POST", url: "/echo", sid, headers: { "x-csrf-token": "wrong" } });
    expect(res.statusCode).toBe(403);
  });

  it("accepts the token from the x-csrf-token header", async () => {
    const h = await makeHarness({ routes: [echo] });
    const { sid, csrf } = await session(h);
    expect(csrf.length).toBeGreaterThan(20);
    const res = await req(h, { method: "POST", url: "/echo", sid, headers: { "x-csrf-token": csrf } });
    expect(res.statusCode).toBe(200);
  });

  it("accepts the token from the _csrf form field", async () => {
    const h = await makeHarness({ routes: [echo] });
    const { sid, csrf } = await session(h);
    const res = await req(h, {
      method: "POST", url: "/echo", sid, payload: `_csrf=${encodeURIComponent(csrf)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("uses a different token per session", async () => {
    const h = await makeHarness({ routes: [echo] });
    const a = await session(h);
    const b = await session(h);
    expect(a.csrf).not.toBe(b.csrf);
    const res = await req(h, { method: "POST", url: "/echo", sid: a.sid, headers: { "x-csrf-token": b.csrf } });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a cross-site Origin even with a valid token", async () => {
    const h = await makeHarness({ routes: [echo] });
    const { sid, csrf } = await session(h);
    const res = await req(h, { method: "POST", url: "/echo", sid, origin: "http://evil.example", headers: { "x-csrf-token": csrf } });
    expect(res.statusCode).toBe(403);
  });

  it("falls back to Referer when Origin is absent, and rejects when both are absent", async () => {
    const h = await makeHarness({ routes: [echo] });
    const { sid, csrf } = await session(h);
    const ok = await req(h, { method: "POST", url: "/echo", sid, origin: null, headers: { referer: `${ORIGIN}/jobs`, "x-csrf-token": csrf } });
    expect(ok.statusCode).toBe(200);
    const none = await req(h, { method: "POST", url: "/echo", sid, origin: null, headers: { "x-csrf-token": csrf } });
    expect(none.statusCode).toBe(403);
  });

  it("applies the Origin check to the login form (pre-session)", async () => {
    const h = await makeHarness();
    const res = await req(h, { method: "POST", url: "/login", origin: "http://evil.example", payload: { username: "admin", password: "x" } });
    expect(res.statusCode).toBe(403);
  });

  it("exempts POST /hooks/jobs/<id> from CSRF, Origin and session checks", async () => {
    const h = await makeHarness({ routes: [echo] });
    const res = await req(h, { method: "POST", url: "/hooks/jobs/1", origin: null, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hook: true });
  });

  it("exempts only POST /hooks/jobs/<digits>, not other /hooks/ paths", async () => {
    const h = await makeHarness({ routes: [echo] });
    for (const url of ["/hooks/other", "/hooks/jobs/1/extra"]) {
      const res = await req(h, { method: "POST", url, origin: null, payload: {} });
      expect(res.statusCode).toBe(403);
    }
    const get = await req(h, { method: "GET", url: "/hooks/jobs/1" });
    expect(get.statusCode).not.toBe(200);
  });

  it("returns JSON errors for JSON clients", async () => {
    const h = await makeHarness({ routes: [echo] });
    const { sid } = await session(h);
    const res = await req(h, { method: "POST", url: "/echo", sid, headers: { accept: "application/json" } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toHaveProperty("error");
  });

  it("embeds the token in hx-headers on pages", async () => {
    const h = await makeHarness();
    const { sid } = await session(h);
    const page = await req(h, { method: "GET", url: "/", sid });
    expect(csrfOf(page.body)).not.toBe("");
    expect(page.body).toContain('name="_csrf"');
  });
});

describe("AUTH_MODE=none", () => {
  it("shows the warning banner and needs no login", async () => {
    const h = await makeHarness({ env: { AUTH_MODE: "none" }, user: false, routes: [echo] });
    const res = await req(h, { method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Authentication is disabled");
  });

  it("still enforces the Origin check on mutations", async () => {
    const h = await makeHarness({ env: { AUTH_MODE: "none" }, user: false, routes: [echo] });
    const page = await req(h, { method: "GET", url: "/" });
    const csrf = csrfOf(page.body);
    const bad = await req(h, { method: "POST", url: "/echo", origin: "http://evil.example", headers: { "x-csrf-token": csrf } });
    expect(bad.statusCode).toBe(403);
    const good = await req(h, { method: "POST", url: "/echo", headers: { "x-csrf-token": csrf } });
    expect(good.statusCode).toBe(200);
  });

  it("still requires the per-process CSRF token", async () => {
    const h = await makeHarness({ env: { AUTH_MODE: "none" }, user: false, routes: [echo] });
    expect((await req(h, { method: "POST", url: "/echo" })).statusCode).toBe(403);
  });

  it("redirects /login to the dashboard", async () => {
    const h = await makeHarness({ env: { AUTH_MODE: "none" }, user: false });
    expect((await req(h, { method: "GET", url: "/login" })).headers.location).toBe("/");
  });

  it("builtin mode shows no banner", async () => {
    const h = await makeHarness();
    const { sid } = await session(h);
    expect((await req(h, { method: "GET", url: "/", sid })).body).not.toContain("Authentication is disabled");
  });
});

describe("Host allowlist", () => {
  it("rejects unknown hosts with 421 in both modes, allows listed ones", async () => {
    for (const mode of ["builtin", "none"]) {
      const h = await makeHarness({ env: { ALLOWED_HOSTS: "harvest.test,other.test:8099", AUTH_MODE: mode }, user: mode === "builtin" });
      const bad = await h.app.inject({ method: "GET", url: "/login", headers: { host: "evil.example" } });
      expect(bad.statusCode).toBe(421);
      const ok = await h.app.inject({ method: "GET", url: "/login", headers: { host: "harvest.test:8099" } });
      expect(ok.statusCode).not.toBe(421);
      const port = await h.app.inject({ method: "GET", url: "/login", headers: { host: "other.test:8099" } });
      expect(port.statusCode).not.toBe(421);
    }
  });

  it("keeps /healthz reachable for container health checks", async () => {
    const h = await makeHarness({ env: { ALLOWED_HOSTS: "harvest.test" } });
    const res = await h.app.inject({ method: "GET", url: "/healthz", headers: { host: "127.0.0.1:8099" } });
    expect(res.statusCode).toBe(200);
  });
});
