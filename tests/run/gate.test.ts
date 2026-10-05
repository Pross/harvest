import { describe, expect, it } from "vitest";
import { createGate } from "../../src/run/gate.js";

const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("createGate", () => {
  it("never runs more than max callbacks at once and is FIFO", async () => {
    const gate = createGate(2);
    let live = 0;
    let peak = 0;
    const order: number[] = [];
    const gates = [defer(), defer(), defer(), defer()];
    const runs = gates.map((g, i) => gate.run(async () => { order.push(i); live++; peak = Math.max(peak, live); await g.promise; live--; }));
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual([0, 1]);
    gates.forEach((g) => g.resolve());
    await Promise.all(runs);
    expect(order).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it("a queued waiter stops waiting when its signal aborts and does not consume a slot", async () => {
    const gate = createGate(1);
    const hold = defer();
    const first = gate.run(() => hold.promise);
    const ctrl = new AbortController();
    let ran = false;
    const queued = gate.run(async () => { ran = true; }, ctrl.signal);
    const assertion = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    ctrl.abort();
    await assertion;
    hold.resolve();
    await first;
    expect(ran).toBe(false);
    await expect(gate.run(async () => "after")).resolves.toBe("after");
  });

  it("rejects immediately for an already aborted signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(createGate(1).run(async () => 1, ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
