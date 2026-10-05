import { describe, expect, it } from "vitest";
import { PermanentError } from "../../src/errors.js";
import { createSlots } from "../../src/run/connection-slots.js";

const sig = () => new AbortController().signal;
const flush = () => new Promise((r) => setImmediate(r));

describe("createSlots", () => {
  it("reserves one slot from files by default", () => {
    const s = createSlots(4);
    expect(s.capacity).toBe(3);
    expect(s.freeForFiles()).toBe(3);
  });

  it("still lets a file use the only slot when max is 1", async () => {
    const s = createSlots(1);
    expect(s.capacity).toBe(1);
    const r = await s.acquire(1, sig());
    r();
  });

  it("acquires and releases (release is idempotent)", async () => {
    const s = createSlots(5);
    const r = await s.acquire(3, sig());
    expect(s.freeForFiles()).toBe(1);
    r();
    r();
    expect(s.freeForFiles()).toBe(4);
  });

  it("rejects an allotment larger than the file capacity instead of waiting forever", async () => {
    const s = createSlots(4);
    await expect(s.acquire(4, sig())).rejects.toBeInstanceOf(PermanentError);
    await expect(s.acquire(0, sig())).rejects.toBeInstanceOf(PermanentError);
  });

  it("rejects an invalid cap", () => {
    expect(() => createSlots(0)).toThrow(PermanentError);
  });

  it("acquire is atomic: waits for the whole allotment and holds nothing meanwhile", async () => {
    const s = createSlots(5); // capacity 4
    const a = await s.acquire(3, sig());
    let got = false;
    const p = s.acquire(3, sig()).then((r) => ((got = true), r));
    await flush();
    expect(got).toBe(false);
    expect(s.freeForFiles()).toBe(1); // the waiter holds none of the free slot
    a();
    (await p)();
    expect(got).toBe(true);
  });

  it("two files each wanting half the slots cannot deadlock", async () => {
    const s = createSlots(5); // capacity 4
    const ctrl = new AbortController();
    const wants = [3, 3];
    const done: number[] = [];
    const run = async (i: number) => {
      const g = await s.grant(wants[i]!, ctrl.signal);
      expect(g.count).toBeGreaterThanOrEqual(1);
      await flush();
      done.push(g.count);
      g.release();
    };
    await Promise.all([run(0), run(1)]);
    expect(done).toHaveLength(2);
  });

  it("grant takes min(wanted, free) and always at least 1 after waiting", async () => {
    const s = createSlots(5);
    const hold = await s.acquire(3, sig());
    const g = await s.grant(4, sig());
    expect(g.count).toBe(1);
    const waiting = s.grant(2, sig());
    let ready = false;
    void waiting.then(() => (ready = true));
    await flush();
    expect(ready).toBe(false);
    hold();
    const g2 = await waiting;
    expect(g2.count).toBe(2);
    g.release();
    g2.release();
    expect(s.freeForFiles()).toBe(4);
  });

  it("grant clamps wanted to the file capacity", async () => {
    const s = createSlots(3);
    const g = await s.grant(10, sig());
    expect(g.count).toBe(2);
  });

  it("serves file waiters in FIFO order", async () => {
    const s = createSlots(3); // capacity 2
    const hold = await s.acquire(2, sig());
    const order: string[] = [];
    const a = s.acquire(2, sig()).then((r) => (order.push("a"), r));
    const b = s.acquire(1, sig()).then((r) => (order.push("b"), r));
    await flush();
    hold();
    const ra = await a;
    await flush();
    expect(order).toEqual(["a"]); // b is not allowed to overtake a
    ra();
    (await b)();
    expect(order).toEqual(["a", "b"]);
  });

  it("acquireOne may use the reserved slot while files hold their capacity", async () => {
    const s = createSlots(3);
    const files = await s.acquire(2, sig());
    const one = await s.acquireOne(sig());
    expect(s.freeForFiles()).toBe(0);
    one();
    files();
  });

  it("acquireOne waits when every slot is busy and is not blocked by a waiting file", async () => {
    const s = createSlots(3);
    const files = await s.acquire(2, sig());
    const one = await s.acquireOne(sig());
    const blockedFile = s.acquire(2, sig());
    let second = false;
    const other = s.acquireOne(sig()).then((r) => ((second = true), r));
    await flush();
    expect(second).toBe(false);
    one();
    (await other)();
    expect(second).toBe(true);
    files();
    (await blockedFile)();
  });

  it("file waiters cannot take the reserved slot", async () => {
    const s = createSlots(3);
    const a = await s.acquire(2, sig());
    let got = false;
    const p = s.grant(1, sig()).then((g) => ((got = true), g));
    await flush();
    expect(got).toBe(false);
    a();
    (await p).release();
  });

  it("an aborted waiter leaves the queue and unblocks those behind it", async () => {
    const s = createSlots(3);
    const hold = await s.acquire(1, sig());
    const ctrl = new AbortController();
    const big = s.acquire(2, ctrl.signal);
    const small = s.acquire(1, sig());
    await flush();
    ctrl.abort();
    await expect(big).rejects.toThrow(/abort/i);
    (await small)();
    hold();
    expect(s.freeForFiles()).toBe(2);
  });

  it("rejects immediately for an already aborted signal", async () => {
    const s = createSlots(3);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(s.acquire(1, ctrl.signal)).rejects.toThrow(/abort/i);
    await expect(s.acquireOne(ctrl.signal)).rejects.toThrow(/abort/i);
    expect(s.freeForFiles()).toBe(2);
  });
});
