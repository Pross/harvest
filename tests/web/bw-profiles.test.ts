import { describe, expect, it, vi } from "vitest";
import { registerSettingsRoutes } from "../../src/web/routes-settings.js";
import { readSettings } from "../../src/web/settings-schema.js";
import { makeHarness, req, session, type Harness } from "./harness.js";

async function boot() {
  const h = await makeHarness({ routes: [registerSettingsRoutes] });
  const changed = vi.fn();
  h.deps.onSettingsChanged = changed;
  return { h, changed };
}

const base = { bwlimit: "", activityDays: "90", runDays: "180", observationDays: "30" };
const post = async (h: Harness, payload: Record<string, unknown>) => {
  const { sid, csrf } = await session(h);
  return req(h, { method: "POST", url: "/settings", sid, payload, headers: { "x-csrf-token": csrf } });
};
const get = async (h: Harness) => req(h, { method: "GET", url: "/settings", sid: (await session(h)).sid });

describe("bandwidth profiles in settings", () => {
  it("saves rows, ignores blank ones, notifies, and redisplays them", async () => {
    const { h, changed } = await boot();
    const res = await post(h, { ...base, bp0_days: ["1", "2"], bp0_from: "22:00", bp0_to: "06:00", bp0_rate: "2M", bp1_from: "", bp3_days: "6", bp3_from: "01:00", bp3_to: "02:00", bp3_rate: "" });
    expect(res.statusCode).toBe(303);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(readSettings(h.deps.stores).bwProfiles).toEqual([
      { days: [1, 2], from: "22:00", to: "06:00", bps: 2 * 1024 * 1024 },
      { days: [6], from: "01:00", to: "02:00", bps: null },
    ]);
    const body = (await get(h)).body;
    expect(body).toContain('name="bp0_from" value="22:00"');
    expect(body).toContain('name="bp0_rate" value="2M"');
    expect(body).toContain("Currently effective global rate");
    expect(body).toContain("TZ");
  });

  it("shows inline errors, keeps the input and saves nothing", async () => {
    const { h, changed } = await boot();
    const res = await post(h, { ...base, bp0_from: "09:00", bp0_to: "10:00", bp0_rate: "1M", bp1_days: "1", bp1_from: "09:00", bp1_to: "09:00", bp2_days: "1", bp2_from: "09:00", bp2_to: "10:00", bp2_rate: "fast" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Row 1: Pick at least one day.");
    expect(res.body).toContain("Row 2: Start and end must differ.");
    expect(res.body).toContain("Row 3: Use a rate like");
    expect(res.body).toContain('name="bp0_rate" value="1M"');
    expect(changed).not.toHaveBeenCalled();
    expect(readSettings(h.deps.stores).bwProfiles).toEqual([]);
  });

  it("removes rows with the remove box and rejects more than 20 profiles", async () => {
    const { h } = await boot();
    await post(h, { ...base, bp0_days: "1", bp0_from: "01:00", bp0_to: "02:00" });
    await post(h, { ...base, bp0_days: "1", bp0_from: "01:00", bp0_to: "02:00", bp0_remove: "1" });
    expect(readSettings(h.deps.stores).bwProfiles).toEqual([]);
    const many: Record<string, string> = { ...base };
    for (let i = 0; i < 21; i++) Object.assign(many, { [`bp${i}_days`]: "1", [`bp${i}_from`]: "01:00", [`bp${i}_to`]: "02:00" });
    const res = await post(h, many);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Use at most 20 profiles.");
  });
});
