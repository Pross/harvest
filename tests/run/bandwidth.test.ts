import { afterEach, describe, expect, it, vi } from "vitest";
import { BwProfilesSchema, nextBoundary, resolveGlobalRate, type BwProfile, type BwSettings } from "../../src/run/bandwidth.js";
import { createBandwidthScheduler } from "../../src/run/bandwidth-scheduler.js";
import { buildLogger } from "../../src/logger.js";

// 2026-10-05 is a Monday (day 1). Dates are local-time, like the implementation.
const at = (day: number, h: number, m = 0): Date => new Date(2026, 9, 4 + day, h, m);
const prof = (days: number[], from: string, to: string, bps: number | null): BwProfile => ({ days, from, to, bps });
const settings = (profiles: BwProfile[], base: number | null = 1000): BwSettings => ({ bwlimitGlobalBps: base, bwProfiles: profiles });

describe("resolveGlobalRate", () => {
  it("falls back to the base limit with no profiles", () => {
    expect(resolveGlobalRate(settings([]), at(1, 12))).toBe(1000);
    expect(resolveGlobalRate(settings([], null), at(1, 12))).toBeNull();
  });

  it("matches the day and the half-open [from, to) window", () => {
    const s = settings([prof([1, 2], "09:00", "17:00", 50)]);
    expect(resolveGlobalRate(s, at(1, 9, 0))).toBe(50);
    expect(resolveGlobalRate(s, at(1, 16, 59))).toBe(50);
    expect(resolveGlobalRate(s, at(1, 17, 0))).toBe(1000);
    expect(resolveGlobalRate(s, at(1, 8, 59))).toBe(1000);
    expect(resolveGlobalRate(s, at(3, 12))).toBe(1000);
  });

  it("wraps past midnight and attributes the after-midnight part to the next day", () => {
    const s = settings([prof([5], "22:00", "06:00", 7)]); // Friday night
    expect(resolveGlobalRate(s, at(5, 21, 59))).toBe(1000);
    expect(resolveGlobalRate(s, at(5, 22, 0))).toBe(7);
    expect(resolveGlobalRate(s, at(6, 3))).toBe(7); // Saturday 03:00
    expect(resolveGlobalRate(s, at(6, 6, 0))).toBe(1000);
    expect(resolveGlobalRate(s, at(5, 3))).toBe(1000); // Friday 03:00 belongs to Thursday night
    expect(resolveGlobalRate(s, at(6, 22))).toBe(1000);
  });

  it("wraps from Saturday to Sunday", () => {
    const s = settings([prof([6], "23:00", "01:00", 9)]);
    expect(resolveGlobalRate(s, at(7, 0, 30))).toBe(9); // Sunday 00:30
  });

  it("first matching profile wins and null bps means unlimited", () => {
    const s = settings([prof([1], "00:00", "12:00", null), prof([1], "08:00", "10:00", 5)]);
    expect(resolveGlobalRate(s, at(1, 9))).toBeNull();
  });
});

describe("nextBoundary", () => {
  it("is null without profiles and otherwise the next start or end", () => {
    expect(nextBoundary([], at(1, 12))).toBeNull();
    const p = [prof([1], "09:00", "17:00", 1)];
    expect(nextBoundary(p, at(1, 8))).toBe(at(1, 9).getTime());
    expect(nextBoundary(p, at(1, 9))).toBe(at(1, 17).getTime());
    expect(nextBoundary(p, at(1, 17))).toBe(at(2, 9).getTime());
  });
});

describe("BwProfilesSchema", () => {
  const ok = prof([1], "09:00", "10:00", null);
  it("rejects empty days, equal times, bad times, bad rates and more than 20 entries", () => {
    expect(BwProfilesSchema.safeParse([ok]).success).toBe(true);
    expect(BwProfilesSchema.safeParse([{ ...ok, days: [] }]).success).toBe(false);
    expect(BwProfilesSchema.safeParse([{ ...ok, to: "09:00" }]).success).toBe(false);
    expect(BwProfilesSchema.safeParse([{ ...ok, from: "24:00" }]).success).toBe(false);
    expect(BwProfilesSchema.safeParse([{ ...ok, days: [7] }]).success).toBe(false);
    expect(BwProfilesSchema.safeParse([{ ...ok, bps: 0 }]).success).toBe(false);
    expect(BwProfilesSchema.safeParse(Array.from({ length: 21 }, () => ok)).success).toBe(false);
    expect(BwProfilesSchema.safeParse(Array.from({ length: 20 }, () => ok)).success).toBe(true);
  });
});

describe("bandwidth scheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("applies the rate, re-arms at each boundary, reacts to refresh and clears on stop", () => {
    vi.useFakeTimers({ now: at(1, 8, 59) });
    const rates: (number | null)[] = [];
    let current = settings([prof([1], "09:00", "10:00", 50)]);
    const s = createBandwidthScheduler({ throttle: { setRate: (r) => void rates.push(r) }, read: () => current, logger: buildLogger("silent", false), now: () => new Date() });
    s.refresh();
    expect(rates).toEqual([1000]);
    vi.advanceTimersByTime(60_000);
    expect(rates).toEqual([1000, 50]);
    expect(s.current()).toBe(50);
    vi.advanceTimersByTime(3_600_000);
    // The 15-minute guard re-applies the same rate in between; only changes matter here.
    expect(rates.filter((r, i) => r !== rates[i - 1])).toEqual([1000, 50, 1000]);
    current = settings([], 5);
    s.refresh();
    expect(rates.at(-1)).toBe(5);
    current = settings([prof([1], "11:00", "12:00", 1)]);
    s.refresh();
    s.stop();
    const n = rates.length;
    vi.advanceTimersByTime(86_400_000);
    expect(rates.length).toBe(n);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the previous rate and logs when settings cannot be read", () => {
    const errors: unknown[] = [];
    const logger = { error: (...a: unknown[]) => void errors.push(a) } as unknown as ReturnType<typeof buildLogger>;
    const s = createBandwidthScheduler({ throttle: { setRate: () => {} }, read: () => { throw new Error("corrupt"); }, logger });
    expect(() => s.refresh()).not.toThrow();
    expect(errors).toHaveLength(1);
    s.stop();
  });
});
