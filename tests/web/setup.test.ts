import { describe, expect, it } from "vitest";
import { verifyPassword } from "../../src/crypto.js";
import { ensureAdmin } from "../../src/web/setup.js";
import { findUser } from "../../src/web/sessions.js";
import { PASSWORD, makeHarness, req } from "./harness.js";

const tokenFromLogs = (logs: string[]): string => {
  const line = logs.map((l) => JSON.parse(l) as { setupUrl?: string }).find((l) => l.setupUrl);
  return new URL(line?.setupUrl ?? "http://x/setup").searchParams.get("token") ?? "";
};

describe("ensureAdmin", () => {
  it("creates the user from ADMIN_USER/ADMIN_PASS when no user exists", async () => {
    const h = await makeHarness({ user: false, env: { ADMIN_USER: "root", ADMIN_PASS: "supersecret1" } });
    const u = findUser(h.deps.db, "root");
    expect(u && await verifyPassword("supersecret1", u.passwordHash)).toBe(true);
    expect(h.logs.join("")).not.toContain("setupUrl");
  });

  it("never overwrites an existing user", async () => {
    const h = await makeHarness({ env: { ADMIN_USER: "root", ADMIN_PASS: "supersecret1" } });
    expect(findUser(h.deps.db, "root")).toBeUndefined();
    await ensureAdmin(h.deps);
    expect(h.deps.db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
    const u = findUser(h.deps.db, "admin");
    expect(u && await verifyPassword(PASSWORD, u.passwordHash)).toBe(true);
  });

  it("does nothing in none mode", async () => {
    const h = await makeHarness({ user: false, env: { AUTH_MODE: "none" } });
    expect(h.deps.db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
    expect((await ensureAdmin(h.deps)).token).toBeNull();
  });
});

describe("setup token flow", () => {
  it("logs the setup URL once at startup", async () => {
    const h = await makeHarness({ user: false, env: { PUBLIC_URL: "https://harvest.example.com" } });
    const lines = h.logs.filter((l) => l.includes("setupUrl"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("https://harvest.example.com/setup?token=");
    expect(tokenFromLogs(h.logs).length).toBeGreaterThan(20);
  });

  it("404s without or with a wrong token", async () => {
    const h = await makeHarness({ user: false });
    expect((await req(h, { method: "GET", url: "/setup" })).statusCode).toBe(404);
    expect((await req(h, { method: "GET", url: "/setup?token=nope" })).statusCode).toBe(404);
    const post = await req(h, { method: "POST", url: "/setup", payload: { token: "nope", username: "a", password: "longenough1", confirm: "longenough1" } });
    expect(post.statusCode).toBe(404);
    expect(h.deps.db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
  });

  it("shows the form with the right token and creates the user once", async () => {
    const h = await makeHarness({ user: false });
    const token = tokenFromLogs(h.logs);
    const page = await req(h, { method: "GET", url: `/setup?token=${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Create the first user");
    const payload = { token, username: "owner", password: "longenough1", confirm: "longenough1" };
    const ok = await req(h, { method: "POST", url: "/setup", payload });
    expect(ok.statusCode).toBe(303);
    expect(findUser(h.deps.db, "owner")).toBeDefined();
    const again = await req(h, { method: "POST", url: "/setup", payload: { ...payload, username: "second" } });
    expect(again.statusCode).toBe(404);
    expect(findUser(h.deps.db, "second")).toBeUndefined();
    expect((await req(h, { method: "GET", url: `/setup?token=${token}` })).statusCode).toBe(404);
  });

  it("shows inline validation errors and keeps the token valid", async () => {
    const h = await makeHarness({ user: false });
    const token = tokenFromLogs(h.logs);
    const bad = await req(h, { method: "POST", url: "/setup", payload: { token, username: "owner", password: "short", confirm: "other" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain("Use at least 8 characters.");
    expect((await req(h, { method: "GET", url: `/setup?token=${token}` })).statusCode).toBe(200);
  });

  it("lets the new user sign in", async () => {
    const h = await makeHarness({ user: false });
    const token = tokenFromLogs(h.logs);
    await req(h, { method: "POST", url: "/setup", payload: { token, username: "owner", password: "longenough1", confirm: "longenough1" } });
    const res = await req(h, { method: "POST", url: "/login", payload: { username: "owner", password: "longenough1" } });
    expect(res.statusCode).toBe(303);
    expect(res.cookies.some((c) => c.name === "harvest_sid")).toBe(true);
  });

  it("404s /setup in none mode and when a user exists", async () => {
    const none = await makeHarness({ user: false, env: { AUTH_MODE: "none" } });
    expect((await req(none, { method: "GET", url: "/setup?token=x" })).statusCode).toBe(404);
    const withUser = await makeHarness();
    expect((await req(withUser, { method: "GET", url: "/setup?token=x" })).statusCode).toBe(404);
  });
});
