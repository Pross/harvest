import { describe, expect, it, vi } from "vitest";
import { composeThrottles, createThrottle } from "../../src/run/throttle.js";

function clock() {
  const c = { t: 0, sleeps: [] as number[] };
  return {
    c,
    now: () => c.t,
    sleep: async (ms: number) => {
      c.sleeps.push(ms);
      c.t += ms;
    },
  };
}

describe("createThrottle", () => {
  it("is unlimited for null and 0", async () => {
    for (const bps of [null, 0]) {
      const k = clock();
      const t = createThrottle({ bytesPerSec: bps, now: k.now, sleep: k.sleep });
      await t.take(1e12);
      expect(k.c.sleeps).toEqual([]);
    }
  });

  it("allows a burst of one second of tokens without waiting", async () => {
    const k = clock();
    const t = createThrottle({ bytesPerSec: 1000, now: k.now, sleep: k.sleep });
    await t.take(400);
    await t.take(600);
    expect(k.c.sleeps).toEqual([]);
  });

  it("waits for the deficit once the bucket is empty", async () => {
    const k = clock();
    const t = createThrottle({ bytesPerSec: 1000, now: k.now, sleep: k.sleep });
    await t.take(1000);
    await t.take(500);
    expect(k.c.sleeps).toEqual([500]);
  });

  it("refills with elapsed time but never beyond one second of tokens", async () => {
    const k = clock();
    const t = createThrottle({ bytesPerSec: 1000, now: k.now, sleep: k.sleep });
    await t.take(1000);
    k.c.t += 60_000;
    await t.take(1000);
    expect(k.c.sleeps).toEqual([]);
    await t.take(1);
    expect(k.c.sleeps).toHaveLength(1);
  });

  it("paces a long stream at the configured rate", async () => {
    const k = clock();
    const t = createThrottle({ bytesPerSec: 1000, now: k.now, sleep: k.sleep });
    for (let i = 0; i < 20; i++) await t.take(500);
    // 10000 bytes at 1000 B/s with a 1000-byte initial burst: 9 seconds
    expect(k.c.t).toBe(9000);
  });

  it("handles chunks larger than one second of tokens", async () => {
    const k = clock();
    const t = createThrottle({ bytesPerSec: 100, now: k.now, sleep: k.sleep });
    await t.take(1000);
    expect(k.c.sleeps).toEqual([9000]);
  });

  it("setRate switches limited to unlimited and back", async () => {
    const k = clock();
    const t = createThrottle({ bytesPerSec: 100, now: k.now, sleep: k.sleep });
    t.setRate(null);
    await t.take(1e9);
    expect(k.c.sleeps).toEqual([]);
    t.setRate(1000);
    await t.take(1000);
    await t.take(1000);
    expect(k.c.sleeps).toEqual([1000]);
  });

  it("setRate lowering the rate caps the stored burst", async () => {
    const k = clock();
    const t = createThrottle({ bytesPerSec: 10_000, now: k.now, sleep: k.sleep });
    t.setRate(100);
    await t.take(100);
    await t.take(100);
    expect(k.c.sleeps).toEqual([1000]);
  });

  it("rejects when aborted before and during the wait, and refunds the tokens", async () => {
    const t = createThrottle({ bytesPerSec: 10 });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(t.take(1, ctrl.signal)).rejects.toThrow(/abort/i);

    const real = createThrottle({ bytesPerSec: 10 });
    await real.take(10);
    const c2 = new AbortController();
    const p = real.take(1000, c2.signal);
    setTimeout(() => c2.abort(), 10);
    await expect(p).rejects.toThrow(/abort/i);
    // refunded: a small take now only waits for the small deficit (<= ~110 ms), not 100 s
    const started = Date.now();
    await real.take(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("default clock", () => {
  it("is monotonic (performance.now), not the wall clock", async () => {
    const perf = vi.spyOn(performance, "now");
    const wall = vi.spyOn(Date, "now");
    const t = createThrottle({ bytesPerSec: 1000, sleep: async () => {} });
    await t.take(10);
    expect(perf).toHaveBeenCalled();
    expect(wall).not.toHaveBeenCalled();
    perf.mockRestore();
    wall.mockRestore();
  });
});

describe("composeThrottles", () => {
  it("takes from each throttle in order", async () => {
    const order: string[] = [];
    const mk = (name: string) => ({
      take: async (bytes: number) => void order.push(`${name}:${bytes}`),
    });
    await composeThrottles(mk("job"), mk("global")).take(7);
    expect(order).toEqual(["job:7", "global:7"]);
  });

  it("is bounded by the slowest bucket and propagates abort", async () => {
    const k = clock();
    const job = createThrottle({ bytesPerSec: 1000, now: k.now, sleep: k.sleep });
    const global = createThrottle({ bytesPerSec: 100, now: k.now, sleep: k.sleep });
    const both = composeThrottles(job, global);
    await both.take(100);
    await both.take(100);
    expect(k.c.t).toBeGreaterThanOrEqual(1000);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(both.take(1, ctrl.signal)).rejects.toThrow();
  });
});

describe("setRate wakes waiting takes", () => {
  it("re-evaluates a long wait against a higher rate", async () => {
    vi.useFakeTimers();
    try {
      const t = createThrottle({ bytesPerSec: 10 });
      await t.take(10);
      let done = false;
      const p = t.take(1000).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(1000);
      expect(done).toBe(false);
      t.setRate(1_000_000);
      await vi.advanceTimersByTimeAsync(5);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases waiters when the rate becomes unlimited", async () => {
    vi.useFakeTimers();
    try {
      const t = createThrottle({ bytesPerSec: 1 });
      await t.take(1);
      const p = t.take(100_000);
      await vi.advanceTimersByTimeAsync(10);
      t.setRate(null);
      await p;
    } finally {
      vi.useRealTimers();
    }
  });
});
