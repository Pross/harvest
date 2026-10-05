import { describe, expect, it } from "vitest";
import { AttemptLimiter } from "../../src/web/auth.js";
import { registerSettingsRoutes } from "../../src/web/routes-settings.js";
import { PASSWORD, ORIGIN, HOST, makeHarness, req, session } from "./harness.js";

const attempt = (h: Awaited<ReturnType<typeof makeHarness>>, headers: Record<string, string>, username = "admin") =>
  req(h, { method: "POST", url: "/login", payload: { username, password: "wrong-password" }, headers });

describe("AttemptLimiter", () => {
  it("caps per IP (5), per username (10) and globally (30) per minute", () => {
    let now = 0;
    const l = new AttemptLimiter(() => now);
    for (let i = 0; i < 5; i++) expect(l.allow("login", "1.1.1.1", `u${i}`)).toBe(true);
    expect(l.allow("login", "1.1.1.1", "other")).toBe(false);
    for (let i = 0; i < 10; i++) expect(l.allow("login", `2.2.2.${i}`, "Admin")).toBe(true);
    expect(l.allow("login", "2.2.2.99", "admin")).toBe(false);
    // 15 attempts so far; 15 more from fresh IPs and usernames reach the global cap of 30.
    for (let i = 0; i < 15; i++) expect(l.allow("login", `3.3.3.${i}`, `user${i}`)).toBe(true);
    expect(l.allow("login", "4.4.4.4", "fresh")).toBe(false);
    now += 61_000;
    expect(l.allow("login", "4.4.4.4", "fresh")).toBe(true);
  });

  it("keeps password-change attempts in their own buckets", () => {
    const l = new AttemptLimiter(() => 0);
    for (let i = 0; i < 5; i++) expect(l.allow("login", "1.1.1.1", "admin")).toBe(true);
    expect(l.allow("login", "1.1.1.1", "admin")).toBe(false);
    expect(l.allow("password", "1.1.1.1", "admin")).toBe(true);
  });

  it("does not record an attempt that is refused by another bucket", () => {
    const l = new AttemptLimiter(() => 0);
    for (let i = 0; i < 5; i++) l.allow("login", "9.9.9.9", "x");
    for (let i = 0; i < 20; i++) expect(l.allow("login", "9.9.9.9", "fresh")).toBe(false);
    // 5 recorded in the global bucket, not 25: another 25 attempts from other IPs still fit.
    for (let i = 0; i < 25; i++) expect(l.allow("login", `5.5.5.${i}`, `v${i}`)).toBe(true);
  });
});

describe("login throttle behind a proxy", () => {
  it("ignores a spoofed leftmost X-Forwarded-For when TRUST_PROXY is a hop count", async () => {
    const h = await makeHarness({ env: { TRUST_PROXY: "1" } });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await attempt(h, { "x-forwarded-for": `10.0.0.${i}, 203.0.113.7` })).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it("does not trust X-Forwarded-For at all when TRUST_PROXY is false", async () => {
    const h = await makeHarness();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await attempt(h, { "x-forwarded-for": `10.0.0.${i}` })).statusCode);
    expect(codes[5]).toBe(429);
  });

  it("trusts only listed proxy addresses", async () => {
    const h = await makeHarness({ env: { TRUST_PROXY: "10.9.9.9" } });
    // The test socket is 127.0.0.1, which is not the trusted proxy, so the header is ignored.
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await attempt(h, { "x-forwarded-for": `10.0.0.${i}` })).statusCode);
    expect(codes[5]).toBe(429);
  });

  it("locks one username after 10 attempts even from rotating addresses", async () => {
    const h = await makeHarness({ env: { TRUST_PROXY: "1" } });
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await attempt(h, { "x-forwarded-for": `198.51.100.${i}` })).statusCode);
    console.log(codes);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  }, 30_000);
});

describe("POST /settings/password throttle", () => {
  it("throttles wrong current-password guesses", async () => {
    const h = await makeHarness({ routes: [registerSettingsRoutes] });
    const { sid, csrf } = await session(h);
    const post = (current: string) => req(h, {
      method: "POST", url: "/settings/password", sid, headers: { "x-csrf-token": csrf, origin: ORIGIN, host: HOST },
      payload: { current, password: "brand-new-pass", confirm: "brand-new-pass" },
    });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await post(`wrong-${i}`)).statusCode);
    expect(codes).toEqual([400, 400, 400, 400, 400, 429]);
    // Even the right password is refused while throttled.
    expect((await post(PASSWORD)).statusCode).toBe(429);
  }, 30_000);
});
