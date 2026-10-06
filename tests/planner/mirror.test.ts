import { describe, expect, it } from "vitest";
import { MIN_GUARDED, planMirrorDeletes } from "../../src/planner/mirror.js";
import { dir, file, ledgerMap } from "./helpers.js";

const led = (path: string, size = 100) => ({ remotePath: path, size, mtimeMs: null, syncedAt: 1 });
const many = (n: number) => Array.from({ length: n }, (_, i) => `P/f${String(i).padStart(3, "0")}`);

describe("planMirrorDeletes", () => {
  it("returns only ledger files that are no longer listed, sorted", () => {
    const plan = planMirrorDeletes([file("keep"), dir("D")], ledgerMap([led("keep"), led("z-gone"), led("a-gone")]));
    expect(plan.refused).toBeNull();
    expect(plan.deletes.map((d) => d.remotePath)).toEqual(["a-gone", "z-gone"]);
  });

  it("never lists files that are not in the ledger", () => {
    const plan = planMirrorDeletes([file("new-on-remote")], ledgerMap([led("new-on-remote")]));
    expect(plan.deletes).toEqual([]);
  });

  it("does nothing for an empty ledger, even with an empty listing", () => {
    expect(planMirrorDeletes([], new Map())).toEqual({ deletes: [], refused: null });
  });

  it("refuses an empty listing when the ledger has files", () => {
    const plan = planMirrorDeletes([dir("only-a-dir")], ledgerMap([led("a")]));
    expect(plan.deletes).toEqual([]);
    expect(plan.refused).toMatch(/listing is empty/);
  });

  it("refuses to delete more than half of a larger ledger", () => {
    const paths = many(30);
    const listing = paths.slice(0, 10).map((p) => file(p));
    const plan = planMirrorDeletes(listing, ledgerMap(paths.map((p) => led(p))));
    expect(plan.deletes).toEqual([]);
    expect(plan.refused).toMatch(/20 of 30/);
  });

  it("allows deleting exactly half, and any amount up to the small-ledger floor", () => {
    const paths = many(30);
    const half = planMirrorDeletes(paths.slice(0, 15).map((p) => file(p)), ledgerMap(paths.map((p) => led(p))));
    expect(half.refused).toBeNull();
    expect(half.deletes).toHaveLength(15);
    const small = many(MIN_GUARDED);
    const all = planMirrorDeletes([file("other")], ledgerMap(small.map((p) => led(p))));
    expect(all.refused).toBeNull();
    expect(all.deletes).toHaveLength(MIN_GUARDED);
  });

  it("matches an NFD server name against its NFC ledger key", () => {
    const nfc = "Café/a.mkv";
    const plan = planMirrorDeletes([file(nfc.normalize("NFD"))], ledgerMap([led(nfc)]));
    expect(plan.deletes).toEqual([]);
  });

  it("with an explicit allowance, deletes even when the listing is empty or most of the ledger is gone", () => {
    const paths = many(30);
    const all = planMirrorDeletes([], ledgerMap(paths.map((p) => led(p))), true);
    expect(all.refused).toBeNull();
    expect(all.deletes).toHaveLength(30);
    const most = planMirrorDeletes(paths.slice(0, 5).map((p) => file(p)), ledgerMap(paths.map((p) => led(p))), true);
    expect(most.refused).toBeNull();
    expect(most.deletes).toHaveLength(25);
  });

  it("the allowance never widens the candidates beyond the ledger, and refusals point at it", () => {
    expect(planMirrorDeletes([file("x")], new Map(), true)).toEqual({ deletes: [], refused: null });
    expect(planMirrorDeletes([], ledgerMap([led("a")])).refused).toMatch(/allow one large delete/);
    const paths = many(30);
    expect(planMirrorDeletes([file(paths[0]!)], ledgerMap(paths.map((p) => led(p)))).refused).toMatch(/allow one large delete/);
  });
});
