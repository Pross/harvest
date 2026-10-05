import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, envBool, formatConfigError, loadConfig } from "../src/config.js";

describe("loadConfig defaults", () => {
  it("applies every default from an empty env", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      PORT: 8099, HOST: "0.0.0.0", AUTH_MODE: "builtin", COOKIE_SECURE: false,
      TRUST_PROXY: false, MAX_CONCURRENT_RUNS: 2, MAX_CONCURRENT_FILES: 4,
      RCLONE_BIN: "rclone", RANGE_MIN_BYTES: 268435456, CHECKPOINT_BYTES: 16777216,
      STALL_TIMEOUT_SECONDS: 120, CONNECT_TIMEOUT_SECONDS: 30, LOG_LEVEL: "info",
      NODE_ENV: "production",
    });
    expect(c.BROWSE_ROOTS).toEqual(["/data"]);
    expect(c.APP_SECRET).toBeUndefined();
    expect(c.PUBLIC_URL).toBeUndefined();
    expect(c.ALLOWED_HOSTS).toBeUndefined();
  });

  it("derives paths from CONFIG_DIR", () => {
    const c = loadConfig({ CONFIG_DIR: "/config" });
    expect(c.dbPath).toBe("/config/db/harvest.db");
    expect(c.tmpDir).toBe("/config/tmp");
    expect(c.logDir).toBe("/config/logs");
    expect(loadConfig({}).dbPath).toBe(path.resolve("./config/db/harvest.db"));
  });
});

describe("blank-string coercion", () => {
  const blanks = [
    "PORT", "HOST", "APP_SECRET", "CONFIG_DIR", "BROWSE_ROOTS", "AUTH_MODE", "ADMIN_USER",
    "ADMIN_PASS", "COOKIE_SECURE", "TRUST_PROXY", "PUBLIC_URL", "ALLOWED_HOSTS",
    "MAX_CONCURRENT_RUNS", "MAX_CONCURRENT_FILES", "RCLONE_BIN", "RANGE_MIN_BYTES",
    "CHECKPOINT_BYTES", "STALL_TIMEOUT_SECONDS", "CONNECT_TIMEOUT_SECONDS", "LOG_LEVEL",
    "TZ", "NODE_ENV",
  ];
  it("treats an all-blank env exactly like an empty env", () => {
    const env = Object.fromEntries(blanks.map((k) => [k, ""]));
    expect(loadConfig(env)).toEqual(loadConfig({}));
  });
  it.each(blanks)("%s=\"\" and whitespace are accepted", (k) => {
    expect(() => loadConfig({ [k]: "" })).not.toThrow();
    expect(() => loadConfig({ [k]: "   " })).not.toThrow();
  });
});

describe("parsing", () => {
  it("parses lists, urls and numbers", () => {
    const c = loadConfig({
      BROWSE_ROOTS: " /a , /b,,", ALLOWED_HOSTS: "x.test, y.test",
      PUBLIC_URL: "https://h.example.com/", PORT: "9000", AUTH_MODE: "none",
    });
    expect(c.BROWSE_ROOTS).toEqual(["/a", "/b"]);
    expect(c.ALLOWED_HOSTS).toEqual(["x.test", "y.test"]);
    expect(c.PUBLIC_URL).toBe("https://h.example.com");
    expect(c.PORT).toBe(9000);
    expect(c.AUTH_MODE).toBe("none");
  });

  it("envBool tokens", () => {
    for (const t of ["true", "TRUE", "1", "yes", "on", " On "]) expect(envBool(t)).toBe(true);
    for (const t of ["false", "0", "no", "off"]) expect(envBool(t)).toBe(false);
    expect(envBool("")).toBeUndefined();
    expect(loadConfig({ COOKIE_SECURE: "false", TRUST_PROXY: "true" })).toMatchObject({
      COOKIE_SECURE: false, TRUST_PROXY: true,
    });
  });

  it("rejects unknown boolean tokens instead of treating them as false", () => {
    expect(() => loadConfig({ COOKIE_SECURE: "ture" })).toThrow(ConfigError);
    expect(() => loadConfig({ AUTH_MODE: "none", COOKIE_SECURE: "maybe" })).toThrow(/COOKIE_SECURE/);
    expect(loadConfig({ COOKIE_SECURE: "" }).COOKIE_SECURE).toBe(false);
  });

  it("parses TRUST_PROXY as boolean, hop count or address list", () => {
    const tp = (v: string) => loadConfig({ TRUST_PROXY: v }).TRUST_PROXY;
    expect(loadConfig({}).TRUST_PROXY).toBe(false);
    expect(tp("")).toBe(false);
    expect(tp("false")).toBe(false);
    expect(tp("0")).toBe(false);
    expect(tp("true")).toBe(true);
    expect(tp("1")).toBe(1);
    expect(tp("2")).toBe(2);
    expect(tp("172.18.0.0/16, 10.0.0.1")).toEqual(["172.18.0.0/16", "10.0.0.1"]);
    expect(tp("loopback,::1")).toEqual(["loopback", "::1"]);
    for (const bad of ["ture", "10.0.0.0/99", "not-an-ip", "1.2.3.4/8/9", "1.2.3"]) {
      expect(() => tp(bad), bad).toThrow(ConfigError);
    }
  });
});

describe("invalid values", () => {
  const bad: Array<[string, string, string]> = [
    ["PORT", "abc", "PORT"],
    ["PORT", "70000", "PORT"],
    ["AUTH_MODE", "ldap", "AUTH_MODE"],
    ["ADMIN_PASS", "short", "ADMIN_PASS"],
    ["PUBLIC_URL", "not a url", "PUBLIC_URL"],
    ["PUBLIC_URL", "ftp://x.test", "PUBLIC_URL"],
    ["LOG_LEVEL", "loud", "LOG_LEVEL"],
    ["MAX_CONCURRENT_RUNS", "0", "MAX_CONCURRENT_RUNS"],
    ["STALL_TIMEOUT_SECONDS", "1.5", "STALL_TIMEOUT_SECONDS"],
  ];
  it.each(bad)("%s=%s throws ConfigError with hints", (k, v, name) => {
    try {
      loadConfig({ [k]: v });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const err = e as ConfigError;
      expect(err.message).toContain(name);
      expect(err.hints.length).toBeGreaterThan(0);
      expect(formatConfigError(err)).toContain("Hints:");
    }
  });
});
