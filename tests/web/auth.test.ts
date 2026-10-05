import { describe, expect, it } from "vitest";
import { LoginThrottle } from "../../src/web/auth.js";
import { SESSION_TTL_MS } from "../../src/web/sessions.js";
import { PASSWORD, cookieOf, login, makeHarness, req, session } from "./harness.js";

describe("builtin auth", () => {
  it("redirects unauthenticated pages to /login", async () => {
    const h = await makeHarness();
    const res = await req(h, { method: "GET", url: "/" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("serves /login publicly", async () => {
    const h = await makeHarness();
    const res = await req(h, { method: "GET", url: "/login" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Sign in");
  });

  it("logs in with correct credentials and sets a hardened cookie", async () => {
    const h = await makeHarness();
    const res = await login(h);
    expect(res.statusCode).toBe(303);
    const c = res.cookies.find((x) => x.name === "harvest_sid");
    expect(c?.value.length).toBeGreaterThan(30);
    expect(c?.httpOnly).toBe(true);
    expect(c?.sameSite).toBe("Lax");
    expect(c?.secure).toBeFalsy();
    expect(c?.maxAge).toBe(14 * 24 * 3600);
  });

  it("marks the cookie Secure when COOKIE_SECURE=true", async () => {
    const h = await makeHarness({ env: { COOKIE_SECURE: "true" } });
    const res = await login(h);
    expect(res.cookies.find((x) => x.name === "harvest_sid")?.secure).toBe(true);
  });

  it("marks the cookie Secure behind a trusted https proxy only", async () => {
    const h = await makeHarness({ env: { TRUST_PROXY: "true" } });
    const res = await req(h, { method: "POST", url: "/login", payload: { username: "admin", password: PASSWORD }, headers: { "x-forwarded-proto": "https" } });
    expect(res.cookies.find((x) => x.name === "harvest_sid")?.secure).toBe(true);
    const h2 = await makeHarness();
    const res2 = await req(h2, { method: "POST", url: "/login", payload: { username: "admin", password: PASSWORD }, headers: { "x-forwarded-proto": "https" } });
    expect(res2.cookies.find((x) => x.name === "harvest_sid")?.secure).toBeFalsy();
  });

  it("stores only a hash of the session id", async () => {
    const h = await makeHarness();
    const sid = cookieOf(await login(h), "harvest_sid") ?? "";
    const rows = h.deps.db.prepare("SELECT id FROM sessions").all() as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe(sid);
  });

  it("gives the same generic error for a wrong password and an unknown user", async () => {
    const h = await makeHarness();
    const bad = await login(h, "wrong-password");
    const unknown = await req(h, { method: "POST", url: "/login", payload: { username: "nobody", password: PASSWORD } });
    expect(bad.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    const msg = (b: string) => /Invalid username or password\./.exec(b)?.[0];
    expect(msg(bad.body)).toBe("Invalid username or password.");
    expect(msg(unknown.body)).toBe("Invalid username or password.");
    expect(cookieOf(bad, "harvest_sid")).toBeUndefined();
  });

  it("rotates the session id on login and drops the old session", async () => {
    const h = await makeHarness();
    const first = cookieOf(await login(h), "harvest_sid") ?? "";
    const second = cookieOf(await req(h, { method: "POST", url: "/login", payload: { username: "admin", password: PASSWORD }, sid: first }), "harvest_sid") ?? "";
    expect(second).not.toBe("");
    expect(second).not.toBe(first);
    expect((await req(h, { method: "GET", url: "/", sid: first })).statusCode).toBe(303);
    expect((await req(h, { method: "GET", url: "/", sid: second })).statusCode).toBe(200);
  });

  it("does not adopt a session id supplied by the client", async () => {
    const h = await makeHarness();
    const res = await req(h, { method: "POST", url: "/login", payload: { username: "admin", password: PASSWORD }, sid: "attacker-chosen" });
    expect(cookieOf(res, "harvest_sid")).not.toBe("attacker-chosen");
  });

  it("logout deletes the session server-side", async () => {
    const h = await makeHarness();
    const { sid, csrf } = await session(h);
    const out = await req(h, { method: "POST", url: "/logout", sid, headers: { "x-csrf-token": csrf } });
    expect(out.statusCode).toBe(303);
    expect(out.headers.location).toBe("/login");
    expect(h.deps.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect((await req(h, { method: "GET", url: "/", sid })).statusCode).toBe(303);
  });

  it("expires sessions after 14 days and slides the expiry on use", async () => {
    let now = 1_000_000_000_000;
    const h = await makeHarness({ server: { now: () => now } });
    const sid = cookieOf(await login(h), "harvest_sid") ?? "";
    now += 7 * 24 * 3600 * 1000;
    const res = await req(h, { method: "GET", url: "/", sid });
    expect(res.statusCode).toBe(200);
    expect(cookieOf(res, "harvest_sid")).toBe(sid);
    now += 13 * 24 * 3600 * 1000;
    expect((await req(h, { method: "GET", url: "/", sid })).statusCode).toBe(200);
    now += SESSION_TTL_MS + 1000;
    expect((await req(h, { method: "GET", url: "/", sid })).statusCode).toBe(303);
  });

  it("answers htmx requests without a session with 401 and HX-Redirect", async () => {
    const h = await makeHarness();
    const res = await req(h, { method: "GET", url: "/fragments/next-runs", headers: { "hx-request": "true" } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["hx-redirect"]).toBe("/login");
  });
});

describe("login throttle", () => {
  it("allows 5 attempts per minute per IP, then 429", async () => {
    let now = 5_000_000;
    const h = await makeHarness({ server: { now: () => now } });
    for (let i = 0; i < 5; i++) expect((await login(h, "nope")).statusCode).toBe(401);
    expect((await login(h, "nope")).statusCode).toBe(429);
    expect((await login(h)).statusCode).toBe(429);
    now += 61_000;
    expect((await login(h)).statusCode).toBe(303);
  });

  it("slides the window instead of resetting at fixed boundaries", () => {
    let now = 0;
    const t = new LoginThrottle(() => now, 3, 60_000);
    expect(t.allow("a")).toBe(true);
    now = 30_000;
    expect(t.allow("a")).toBe(true);
    expect(t.allow("a")).toBe(true);
    expect(t.allow("a")).toBe(false);
    now = 61_000; // first hit expired, two remain
    expect(t.allow("a")).toBe(true);
    expect(t.allow("a")).toBe(false);
  });

  it("tracks IPs independently", () => {
    const t = new LoginThrottle(() => 0, 1, 60_000);
    expect(t.allow("a")).toBe(true);
    expect(t.allow("a")).toBe(false);
    expect(t.allow("b")).toBe(true);
  });
});
