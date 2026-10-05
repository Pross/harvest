import { describe, expect, it } from "vitest";
import { makeHarness, req, session } from "./harness.js";

describe("server basics", () => {
  it("serves /healthz without auth", async () => {
    const h = await makeHarness();
    const res = await req(h, { method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("serves vendored htmx and sse extension without auth", async () => {
    const h = await makeHarness();
    const htmx = await req(h, { method: "GET", url: "/static/vendor/htmx.min.js" });
    expect(htmx.statusCode).toBe(200);
    expect(htmx.body).toContain("htmx");
    const sse = await req(h, { method: "GET", url: "/static/vendor/sse.min.js" });
    expect(sse.statusCode).toBe(200);
    expect((await req(h, { method: "GET", url: "/static/vendor/VERSIONS.md" })).body).toContain("2.0.11");
  });

  it("sets security headers including a CSP without external origins", async () => {
    const h = await makeHarness();
    const res = await req(h, { method: "GET", url: "/login" });
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(res.headers["content-security-policy"])).toContain("script-src 'self'");
    expect(String(res.headers["content-security-policy"])).not.toMatch(/https?:/);
  });

  it("renders a 404 page inside the layout", async () => {
    const h = await makeHarness();
    const { sid } = await session(h);
    const res = await req(h, { method: "GET", url: "/nope", sid });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("Page not found");
    expect(res.body).toContain("<nav");
  });

  it("registers extra route modules behind auth with the shared render helper", async () => {
    const h = await makeHarness({ routes: [(app, deps) => {
      app.get("/extra", async (_r, reply) => reply.type("text/plain").send(deps.config.AUTH_MODE));
    }] });
    expect((await req(h, { method: "GET", url: "/extra" })).statusCode).toBe(303);
    const { sid } = await session(h);
    expect((await req(h, { method: "GET", url: "/extra", sid })).body).toBe("builtin");
  });

  it("error handler hides internals and logs with redacted URLs", async () => {
    const h = await makeHarness({ routes: [(app) => {
      app.get("/boom", async () => { throw new Error("db password=hunter2 at /srv/secret.ts:12"); });
    }] });
    const { sid } = await session(h);
    const res = await req(h, { method: "GET", url: "/boom?token=abc123", sid });
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain("Something went wrong");
    expect(res.body).not.toContain("hunter2");
    expect(res.body).not.toContain("secret.ts");
    expect(res.body).not.toContain("Error:");
    const log = h.logs.join("");
    expect(log).toContain('"url":"/boom"');
    expect(log).not.toContain("abc123");
    const json = await req(h, { method: "GET", url: "/boom", sid, headers: { accept: "application/json" } });
    expect(json.json()).toEqual({ error: "Something went wrong" });
  });

  it("maps client errors to safe messages", async () => {
    const h = await makeHarness();
    const { sid, csrf } = await session(h);
    const res = await req(h, {
      method: "POST", url: "/logout", sid, payload: "{bad", headers: { "content-type": "application/json", "x-csrf-token": csrf },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Bad request");
  });
});
