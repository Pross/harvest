import { describe, expect, it } from "vitest";
import { releaseSpace, reserveSpace, totalReserved, trimToFit } from "../../src/planner/space.js";
import type { PlannedUnit } from "../../src/planner/types.js";

const u = (key: string, totalBytes: number): PlannedUnit => ({ key, files: [], totalBytes, existing: false });
const keys = (us: PlannedUnit[]) => us.map((x) => x.key);

describe("trimToFit", () => {
  it("keeps everything when it fits", () => {
    const r = trimToFit([u("a", 10), u("b", 20)], 100, 0, null);
    expect(keys(r.kept)).toEqual(["a", "b"]);
    expect(r.dropped).toEqual([]);
  });
  it("fits exactly", () => {
    expect(trimToFit([u("a", 50), u("b", 50)], 100, 0, null).dropped).toEqual([]);
  });
  it("drops the largest first", () => {
    const r = trimToFit([u("a", 60), u("b", 10), u("c", 30)], 50, 0, null);
    expect(keys(r.kept)).toEqual(["b", "c"]);
    expect(keys(r.dropped)).toEqual(["a"]);
  });
  it("prefers keeping more small units over one large unit", () => {
    const r = trimToFit([u("big", 90), u("s1", 30), u("s2", 30), u("s3", 30)], 100, 0, null);
    expect(keys(r.kept)).toEqual(["s1", "s2", "s3"]);
  });
  it("never splits a unit: a unit bigger than free is dropped", () => {
    const r = trimToFit([u("a", 101)], 100, 0, null);
    expect(r.kept).toEqual([]);
    expect(keys(r.dropped)).toEqual(["a"]);
  });
  it("subtracts reservations", () => {
    const r = trimToFit([u("a", 30), u("b", 30)], 100, 50, null);
    expect(keys(r.kept)).toEqual(["a"]);
  });
  it("subtracts min free", () => {
    const r = trimToFit([u("a", 30), u("b", 30)], 100, 0, 50);
    expect(keys(r.kept)).toEqual(["a"]);
  });
  it("null min free counts as 0", () => {
    expect(trimToFit([u("a", 100)], 100, 0, null).kept).toHaveLength(1);
  });
  it("keeps nothing when budget is negative", () => {
    expect(trimToFit([u("a", 0)], 10, 20, null).kept).toEqual([]);
  });
  it("handles an empty list", () => {
    expect(trimToFit([], 10, 0, null)).toEqual({ kept: [], dropped: [] });
  });
  it("preserves input order in kept and dropped", () => {
    const r = trimToFit([u("z", 5), u("a", 5), u("m", 500)], 20, 0, null);
    expect(keys(r.kept)).toEqual(["z", "a"]);
  });
  it("does not mutate the input", () => {
    const units = [u("b", 9), u("a", 1)];
    trimToFit(units, 5, 0, null);
    expect(keys(units)).toEqual(["b", "a"]);
  });
});

describe("reservations", () => {
  it("reserves, totals and releases without mutating", () => {
    const empty = new Map<number, number>();
    const one = reserveSpace(empty, 1, 100);
    const two = reserveSpace(one, 2, 50);
    expect(empty.size).toBe(0);
    expect(totalReserved(two)).toBe(150);
    expect(totalReserved(releaseSpace(two, 1))).toBe(50);
  });
  it("re-reserving the same run replaces its bytes", () => {
    const m = reserveSpace(reserveSpace(new Map<number, number>(), 1, 100), 1, 40);
    expect(totalReserved(m)).toBe(40);
  });
});
