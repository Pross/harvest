import { describe, expect, it } from "vitest";
import { z } from "zod";
import { setup } from "./helpers.js";

const schema = z.object({ days: z.number(), bps: z.number() });

describe("settings store", () => {
  it("gets, sets, overwrites and deletes strings", () => {
    const { stores } = setup();
    expect(stores.settings.get("k")).toBeUndefined();
    stores.settings.set("k", "a");
    stores.settings.set("k", "b");
    expect(stores.settings.get("k")).toBe("b");
    stores.settings.delete("k");
    expect(stores.settings.get("k")).toBeUndefined();
  });

  it("getJson validates with zod", () => {
    const { stores } = setup();
    stores.settings.setJson("bw", { days: 1, bps: 5 });
    expect(stores.settings.getJson("bw", schema)).toEqual({ days: 1, bps: 5 });
    expect(stores.settings.getJson("absent", schema)).toBeUndefined();
  });

  it("getJson throws on invalid JSON and on schema violations", () => {
    const { stores } = setup();
    stores.settings.set("bad", "{nope");
    expect(() => stores.settings.getJson("bad", schema)).toThrow(/not valid JSON/);
    stores.settings.set("wrong", JSON.stringify({ days: "x" }));
    expect(() => stores.settings.getJson("wrong", schema)).toThrow(/failed validation/);
  });
});
