import { describe, expect, it, vi } from "vitest";
import { verifyPassword } from "../../src/crypto.js";
import { registerSettingsRoutes } from "../../src/web/routes-settings.js";
import { DEFAULT_SETTINGS, SETTINGS_KEYS, formatRateInput, parseRate, readSettings } from "../../src/web/settings-schema.js";
import { PASSWORD, cookieOf, makeHarness, req, session, type Harness, type HarnessOptions } from "./harness.js";

async function boot(o: HarnessOptions = {}) {
  const h = await makeHarness({ routes: [registerSettingsRoutes], ...o });
  const changed = vi.fn();
  h.deps.onSettingsChanged = changed;
  return { h, changed };
}

const get = async (h: Harness, url = "/settings") => {
  const { sid } = await session(h);
  return req(h, { method: "GET", url, sid });
};

const form = { bwlimit: "", activityDays: "90", runDays: "180", observationDays: "30" };
const post = async (h: Harness, payload: Record<string, unknown>, url = "/settings") => {
  const { sid, csrf } = await session(h);
  return req(h, { method: "POST", url, sid, payload, headers: { "x-csrf-token": csrf } });
};

describe("readSettings", () => {
  it("returns full defaults when nothing is stored", async () => {
    const { h } = await boot();
    expect(readSettings(h.deps.stores)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.retention).toMatchObject({ activityDays: 90, runDays: 180, observationDays: 30 });
  });

  it("tolerates a missing key and fills a partial retention object", async () => {
    const { h } = await boot();
    h.deps.stores.settings.setJson(SETTINGS_KEYS.retention, { activityDays: 10 });
    const s = readSettings(h.deps.stores);
    expect(s.retention).toMatchObject({ activityDays: 10, runDays: 180, observationDays: 30 });
    expect(s.bwlimitGlobalBps).toBeNull();
  });

  it("reads stored values", async () => {
    const { h } = await boot();
    h.deps.stores.settings.setJson(SETTINGS_KEYS.bwlimitGlobalBps, 1048576);
    expect(readSettings(h.deps.stores).bwlimitGlobalBps).toBe(1048576);
  });

  it("throws on corrupt JSON and on invalid values", async () => {
    const { h } = await boot();
    h.deps.stores.settings.set(SETTINGS_KEYS.retention, "{not json");
    expect(() => readSettings(h.deps.stores)).toThrow(/not valid JSON/);
    h.deps.stores.settings.setJson(SETTINGS_KEYS.retention, { activityDays: -3 });
    expect(() => readSettings(h.deps.stores)).toThrow(/validation/);
    h.deps.stores.settings.delete(SETTINGS_KEYS.retention);
    h.deps.stores.settings.setJson(SETTINGS_KEYS.bwlimitGlobalBps, "fast");
    expect(() => readSettings(h.deps.stores)).toThrow();
  });
});

describe("rate parsing", () => {
  it("parses units and blank", () => {
    expect(parseRate("")).toBeNull();
    expect(parseRate("  ")).toBeNull();
    expect(parseRate("2048")).toBe(2048);
    expect(parseRate("10M")).toBe(10 * 1024 * 1024);
    expect(parseRate("500 KiB/s")).toBe(500 * 1024);
    expect(parseRate("1.5g")).toBe(1.5 * 1024 ** 3);
    expect(parseRate("2 MB/s")).toBe(2 * 1024 * 1024);
  });

  it("rejects junk, zero and negatives", () => {
    for (const bad of ["fast", "-5", "0", "0K", "10 X", "1e3", "M10"]) expect(parseRate(bad)).toBeUndefined();
  });

  it("round-trips for redisplay", () => {
    expect(formatRateInput(null)).toBe("");
    expect(formatRateInput(10 * 1024 * 1024)).toBe("10M");
    expect(formatRateInput(1536)).toBe("1536");
    expect(formatRateInput(2048)).toBe("2K");
  });
});

describe("settings page", () => {
  it("renders defaults, placeholders and sections", async () => {
    const { h } = await boot();
    const res = await get(h);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="activityDays" value="90"');
    expect(res.body).toContain('name="runDays" value="180"');
    expect(res.body).toContain('name="observationDays" value="30"');
    expect(res.body).toContain('name="bwlimit" value=""');
    expect(res.body).toContain("Time-of-day profiles");
    expect(res.body).toContain("Apprise notifications arrive in a later release");
    expect(res.body).toContain('aria-current="page"');
  });

  it("redisplays stored values", async () => {
    const { h } = await boot();
    h.deps.stores.settings.setJson(SETTINGS_KEYS.bwlimitGlobalBps, 5 * 1024 * 1024);
    h.deps.stores.settings.setJson(SETTINGS_KEYS.retention, { activityDays: 7, runDays: 8, observationDays: 9 });
    const b = (await get(h)).body;
    expect(b).toContain('name="bwlimit" value="5M"');
    expect(b).toContain('name="activityDays" value="7"');
    expect(b).toContain('name="observationDays" value="9"');
  });

  it("requires a session", async () => {
    const { h } = await boot();
    expect((await req(h, { method: "GET", url: "/settings" })).statusCode).toBe(303);
  });
});

describe("saving settings", () => {
  it("saves a valid form, calls onSettingsChanged once and redirects with a flash", async () => {
    const { h, changed } = await boot();
    const res = await post(h, { bwlimit: "10M", activityDays: "30", runDays: "60", observationDays: "14" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/settings");
    expect(changed).toHaveBeenCalledTimes(1);
    const s = readSettings(h.deps.stores);
    expect(s.bwlimitGlobalBps).toBe(10 * 1024 * 1024);
    expect(s.retention).toMatchObject({ activityDays: 30, runDays: 60, observationDays: 14, stagingDays: 7 });
    expect(decodeURIComponent(res.cookies.find((c) => c.name === "harvest_flash")?.value ?? "")).toContain("Settings saved");
  });

  it("blank rate means unlimited and clears a previous limit", async () => {
    const { h } = await boot();
    h.deps.stores.settings.setJson(SETTINGS_KEYS.bwlimitGlobalBps, 100);
    await post(h, form);
    expect(readSettings(h.deps.stores).bwlimitGlobalBps).toBeNull();
  });

  it("preserves a stored stagingDays", async () => {
    const { h } = await boot();
    h.deps.stores.settings.setJson(SETTINGS_KEYS.retention, { activityDays: 1, runDays: 1, observationDays: 1, stagingDays: 21 });
    await post(h, form);
    expect(readSettings(h.deps.stores).retention.stagingDays).toBe(21);
  });

  it("rejects a bad rate inline with 400, keeps input, saves nothing and does not call onSettingsChanged", async () => {
    const { h, changed } = await boot();
    const res = await post(h, { ...form, bwlimit: "fast!" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('<div class="field-error">Use a rate like');
    expect(res.body).toContain('value="fast!"');
    expect(changed).not.toHaveBeenCalled();
    expect(h.deps.stores.settings.get(SETTINGS_KEYS.bwlimitGlobalBps)).toBeUndefined();
  });

  it("rejects negative, zero, huge and non-numeric days", async () => {
    const { h, changed } = await boot();
    const { sid, csrf } = await session(h);
    for (const [field, value, msg] of [
      ["activityDays", "-1", "at least 1"], ["runDays", "0", "at least 1"], ["observationDays", "99999", "at most 3650"],
      ["activityDays", "abc", "whole number"], ["runDays", "", "whole number"], ["observationDays", "1.5", "whole number"],
    ] as const) {
      const res = await req(h, { method: "POST", url: "/settings", sid, payload: { ...form, [field]: value }, headers: { "x-csrf-token": csrf } });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(msg);
    }
    expect(changed).not.toHaveBeenCalled();
    expect(h.deps.stores.settings.get(SETTINGS_KEYS.retention)).toBeUndefined();
  });

  it("shows several errors at once", async () => {
    const { h } = await boot();
    const res = await post(h, { bwlimit: "zz", activityDays: "-1", runDays: "-2", observationDays: "30" });
    expect((res.body.match(/class="field-error"/g) ?? []).length).toBe(3);
  });

  it("escapes redisplayed input", async () => {
    const { h } = await boot();
    const res = await post(h, { ...form, bwlimit: '"><script>x</script>' });
    expect(res.body).not.toContain("<script>x</script>");
  });

  it("is protected by CSRF and Origin", async () => {
    const { h, changed } = await boot();
    const { sid, csrf } = await session(h);
    expect((await req(h, { method: "POST", url: "/settings", sid, payload: form })).statusCode).toBe(403);
    expect((await req(h, { method: "POST", url: "/settings", sid, origin: "http://evil.example", payload: form, headers: { "x-csrf-token": csrf } })).statusCode).toBe(403);
    expect(changed).not.toHaveBeenCalled();
  });
});

describe("security section", () => {
  it("shows the generated-secret banner with the path", async () => {
    const { h } = await boot({ secretSource: "generated" });
    const b = (await get(h)).body;
    expect(b).toContain("APP_SECRET was generated and stored in /tmp/harvest-web-test/.app_secret; back it up separately from the database");
    expect(b).toContain("<strong>generated</strong>");
    expect(b).toContain("banner-warn");
  });

  it("shows the env and file variants without the generated text", async () => {
    const env = (await get((await boot({ secretSource: "env" })).h)).body;
    expect(env).toContain("<strong>environment</strong>");
    expect(env).not.toContain("was generated and stored");
    const file = (await get((await boot({ secretSource: "file" })).h)).body;
    expect(file).toContain("<strong>file</strong>");
    expect(file).toContain("read from /tmp/harvest-web-test/.app_secret");
    expect(file).not.toContain("was generated and stored");
  });

  it("shows the auth mode", async () => {
    const { h } = await boot();
    expect((await get(h)).body).toContain("<strong>builtin</strong>");
  });
});

describe("password change", () => {
  const pw = { current: PASSWORD, password: "new-password-1", confirm: "new-password-1" };

  it("changes the password and rotates the session", async () => {
    const { h, changed } = await boot();
    const { sid, csrf } = await session(h);
    const res = await req(h, { method: "POST", url: "/settings/password", sid, payload: pw, headers: { "x-csrf-token": csrf } });
    expect(res.statusCode).toBe(303);
    const row = h.deps.db.prepare("SELECT password_hash FROM users WHERE username = 'admin'").get() as { password_hash: string };
    expect(await verifyPassword("new-password-1", row.password_hash)).toBe(true);
    expect(await verifyPassword(PASSWORD, row.password_hash)).toBe(false);
    const fresh = cookieOf(res, "harvest_sid");
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(sid);
    expect((await req(h, { method: "GET", url: "/settings", sid })).statusCode).toBe(303);
    expect((await req(h, { method: "GET", url: "/settings", sid: fresh })).statusCode).toBe(200);
    expect(changed).not.toHaveBeenCalled();
  });

  it("invalidates other sessions of the user", async () => {
    const { h } = await boot();
    const a = await session(h);
    const b = await session(h);
    await req(h, { method: "POST", url: "/settings/password", sid: a.sid, payload: pw, headers: { "x-csrf-token": a.csrf } });
    expect((await req(h, { method: "GET", url: "/settings", sid: b.sid })).statusCode).toBe(303);
  });

  it("the new password logs in and the old does not", async () => {
    const { h } = await boot();
    const { sid, csrf } = await session(h);
    await req(h, { method: "POST", url: "/settings/password", sid, payload: pw, headers: { "x-csrf-token": csrf } });
    const ok = await req(h, { method: "POST", url: "/login", payload: { username: "admin", password: "new-password-1" } });
    expect(cookieOf(ok, "harvest_sid")).toBeTruthy();
    const bad = await req(h, { method: "POST", url: "/login", payload: { username: "admin", password: PASSWORD } });
    expect(bad.statusCode).toBe(401);
  });

  it("rejects a wrong current password", async () => {
    const { h } = await boot();
    const res = await post(h, { ...pw, current: "nope-nope-nope" }, "/settings/password");
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Current password is incorrect.");
    expect(res.body).not.toContain("nope-nope-nope");
    const row = h.deps.db.prepare("SELECT password_hash FROM users").get() as { password_hash: string };
    expect(await verifyPassword(PASSWORD, row.password_hash)).toBe(true);
  });

  it("rejects a mismatched confirmation", async () => {
    const { h } = await boot();
    const res = await post(h, { ...pw, confirm: "different-one" }, "/settings/password");
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Passwords do not match.");
  });

  it("rejects a too short new password", async () => {
    const { h } = await boot();
    const res = await post(h, { ...pw, password: "short", confirm: "short" }, "/settings/password");
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Use at least 8 characters.");
  });

  it("keeps the session on a failed attempt", async () => {
    const { h } = await boot();
    const { sid, csrf } = await session(h);
    await req(h, { method: "POST", url: "/settings/password", sid, payload: { ...pw, current: "x" }, headers: { "x-csrf-token": csrf } });
    expect((await req(h, { method: "GET", url: "/settings", sid })).statusCode).toBe(200);
  });

  it("is not available in none mode", async () => {
    const { h } = await boot({ env: { AUTH_MODE: "none" }, user: false });
    const page = await req(h, { method: "GET", url: "/settings" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("not available because authentication is disabled");
    expect(page.body).not.toContain('action="/settings/password"');
    const csrf = /x-csrf-token&quot;:&quot;([^&]*)&quot;/.exec(page.body)?.[1] ?? "";
    const res = await req(h, { method: "POST", url: "/settings/password", payload: pw, headers: { "x-csrf-token": csrf } });
    expect(res.statusCode).toBe(404);
  });

  it("is protected by CSRF", async () => {
    const { h } = await boot();
    const { sid } = await session(h);
    expect((await req(h, { method: "POST", url: "/settings/password", sid, payload: pw })).statusCode).toBe(403);
  });
});
