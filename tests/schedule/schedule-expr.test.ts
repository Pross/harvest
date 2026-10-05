import { describe, expect, it, vi } from "vitest";
import cronstrue from "cronstrue";
import { parseInterval, validateSchedule } from "../../src/schedule/schedule-expr.js";

describe("parseInterval", () => {
  it.each([["60s", 60_000], ["5m", 300_000], ["6h", 21_600_000], ["2d", 172_800_000], [" 1h ", 3_600_000]])("parses %s", (e, ms) => {
    expect(parseInterval(e)).toBe(ms);
  });
  it.each(["", "abc", "5", "5x", "-5m", "1.5h", "h6", "5 m"])("rejects %j", (e) => {
    expect(() => parseInterval(e)).toThrow(/invalid interval/);
  });
  it("enforces the 60s minimum", () => {
    expect(() => parseInterval("59s")).toThrow(/minimum/);
    expect(() => parseInterval("0m")).toThrow(/minimum/);
  });
});

describe("validateSchedule", () => {
  it("accepts a cron expression with human text and three next runs", () => {
    const r = validateSchedule("cron", "*/15 * * * *");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.human.toLowerCase()).toContain("15 minutes");
    expect(r.next).toHaveLength(3);
    expect(r.next[0]!.getTime()).toBeLessThan(r.next[1]!.getTime());
  });
  it("honors the timezone for next runs", () => {
    const a = validateSchedule("cron", "0 3 * * *", "UTC");
    const b = validateSchedule("cron", "0 3 * * *", "Asia/Tokyo");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.next[0]!.getTime()).not.toBe(b.next[0]!.getTime());
  });
  it.each(["not a cron", "99 * * * *", "* * *"])("rejects invalid cron %j", (e) => {
    const r = validateSchedule("cron", e);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
  it("rejects an unknown timezone", () => {
    expect(validateSchedule("cron", "0 3 * * *", "Mars/Base").ok).toBe(false);
  });
  it("rejects a missing expression for cron and interval", () => {
    expect(validateSchedule("cron", null)).toMatchObject({ ok: false });
    expect(validateSchedule("interval", "  ")).toMatchObject({ ok: false });
  });
  it("accepts intervals with human text", () => {
    const r = validateSchedule("interval", "6h");
    expect(r).toMatchObject({ ok: true, human: "every 6 hours" });
    if (r.ok) expect(r.next).toHaveLength(3);
  });
  it.each([["1h", "every hour"], ["1m", "every minute"], ["90s", "every 90 seconds"], ["1d", "every day"]])("humanizes %s", (e, h) => {
    expect(validateSchedule("interval", e)).toMatchObject({ ok: true, human: h });
  });
  it("rejects bad intervals without throwing", () => {
    expect(validateSchedule("interval", "10s")).toMatchObject({ ok: false });
    expect(validateSchedule("interval", "soon")).toMatchObject({ ok: false });
  });
  it("manual is always ok", () => {
    expect(validateSchedule("manual", null)).toEqual({ ok: true, human: "manual only", next: [] });
  });
});

describe("schedule limits", () => {
  it("rejects intervals above 24 days (setTimeout would clamp them to 1 ms)", () => {
    expect(parseInterval("24d")).toBe(24 * 86_400_000);
    expect(() => parseInterval("25d")).toThrow(/maximum/);
    expect(() => parseInterval("30d")).toThrow(/maximum/);
    expect(() => parseInterval("720h")).toThrow(/maximum/);
    const v = validateSchedule("interval", "30d");
    expect(v.ok).toBe(false);
  });

  it("rejects cron expressions that fire more often than every 60 seconds", () => {
    expect(validateSchedule("cron", "* * * * * *", "UTC")).toMatchObject({ ok: false });
    expect(validateSchedule("cron", "*/30 * * * * *", "UTC")).toMatchObject({ ok: false });
    expect(validateSchedule("cron", "* * * * *", "UTC")).toMatchObject({ ok: true });
  });

  it("a cronstrue failure does not invalidate a valid cron expression", () => {
    const spy = vi.spyOn(cronstrue, "toString").mockImplementation(() => { throw new Error("cannot describe"); });
    const v = validateSchedule("cron", "0 6 * * *", "UTC");
    spy.mockRestore();
    expect(v).toMatchObject({ ok: true, human: "0 6 * * *" });
  });
});
