import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createBandwidthScheduler, GUARD_MS, RETRY_MS } from "../../src/run/bandwidth-scheduler.js";
import type { BwSettings } from "../../src/run/bandwidth.js";

const ok: BwSettings = { bwGlobalBps: 500, bwProfiles: [] } as unknown as BwSettings;
afterEach(() => vi.useRealTimers());

function make(read: () => BwSettings) {
  const setRate = vi.fn();
  const s = createBandwidthScheduler({ throttle: { setRate }, read, logger: pino({ level: "silent" }) });
  return { s, setRate };
}

describe("bandwidth scheduler error handling", () => {
  it("retries after 60 s when reading settings fails, and stop clears the timers", () => {
    vi.useFakeTimers();
    let fail = true;
    const read = vi.fn(() => { if (fail) throw new Error("corrupt"); return ok; });
    const { s, setRate } = make(read);
    s.refresh();
    expect(setRate).not.toHaveBeenCalled();
    fail = false;
    vi.advanceTimersByTime(RETRY_MS);
    expect(setRate).toHaveBeenCalledTimes(1);
    s.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-evaluates every 15 minutes even without profile boundaries", () => {
    vi.useFakeTimers();
    const { s, setRate } = make(() => ok);
    s.refresh();
    expect(setRate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(GUARD_MS);
    expect(setRate).toHaveBeenCalledTimes(2);
    s.stop();
    vi.advanceTimersByTime(GUARD_MS * 2);
    expect(setRate).toHaveBeenCalledTimes(2);
  });
});
