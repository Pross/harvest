import { describe, expect, it } from "vitest";
import { MIN_GUARDED, planMirrorDeletes } from "../../src/planner/mirror.js";
import { dir, file, ledgerMap } from "./helpers.js";

/** `seen` = the run that first saw the file missing; the planner under test runs as run RUN. */
const RUN = 5;
const led = (path: string, seen: number | null = 1) => ({ remotePath: path, size: 100, mtimeMs: null, syncedAt: 1, missingRunId: seen });
const fresh = (path: string) => led(path, null);
const plan_ = (listing: Parameters<typeof planMirrorDeletes>[0], ledger: Parameters<typeof ledgerMap>[0], allow = false) => planMirrorDeletes(listing, ledgerMap(ledger), allow, RUN);
const many = (n: number) => Array.from({ length: n }, (_, i) => `P/f${String(i).padStart(3, "0")}`);

describe("planMirrorDeletes", () => {
  it("returns only ledger files that are no longer listed, sorted", () => {
    const plan = plan_([file("keep"), dir("D")], [led("keep"), led("z-gone"), led("a-gone")]);
    expect(plan.refused).toBeNull();
    expect(plan.deletes.map((d) => d.remotePath)).toEqual(["a-gone", "z-gone"]);
  });

  it("never lists files that are not in the ledger", () => {
    const plan = plan_([file("new-on-remote")], [led("new-on-remote")]);
    expect(plan.deletes).toEqual([]);
  });

  it("does nothing for an empty ledger, even with an empty listing", () => {
    expect(planMirrorDeletes([], new Map(), false, RUN)).toEqual({ deletes: [], newlyMissing: [], reappeared: [], refused: null });
  });

  it("refuses an empty listing when the ledger has files", () => {
    const plan = plan_([dir("only-a-dir")], [led("a")]);
    expect(plan.deletes).toEqual([]);
    expect(plan.refused).toMatch(/listing is empty/);
  });

  it("refuses to delete more than half of a larger ledger", () => {
    const paths = many(30);
    const listing = paths.slice(0, 10).map((p) => file(p));
    const plan = plan_(listing, paths.map((p) => led(p)));
    expect(plan.deletes).toEqual([]);
    expect(plan.refused).toMatch(/20 of 30/);
  });

  it("allows deleting exactly half, and any amount up to the small-ledger floor", () => {
    const paths = many(30);
    const half = plan_(paths.slice(0, 15).map((p) => file(p)), paths.map((p) => led(p)));
    expect(half.refused).toBeNull();
    expect(half.deletes).toHaveLength(15);
    const small = many(MIN_GUARDED);
    const all = plan_([file("other")], small.map((p) => led(p)));
    expect(all.refused).toBeNull();
    expect(all.deletes).toHaveLength(MIN_GUARDED);
  });

  it("matches an NFD server name against its NFC ledger key", () => {
    const nfc = "Café/a.mkv";
    const plan = plan_([file(nfc.normalize("NFD"))], [led(nfc)]);
    expect(plan.deletes).toEqual([]);
  });

  it("with an explicit allowance, deletes even when the listing is empty or most of the ledger is gone", () => {
    const paths = many(30);
    const all = plan_([], paths.map((p) => led(p)), true);
    expect(all.refused).toBeNull();
    expect(all.deletes).toHaveLength(30);
    const most = plan_(paths.slice(0, 5).map((p) => file(p)), paths.map((p) => led(p)), true);
    expect(most.refused).toBeNull();
    expect(most.deletes).toHaveLength(25);
  });

  it("the allowance never widens the candidates beyond the ledger, and refusals point at it", () => {
    expect(planMirrorDeletes([file("x")], new Map(), true, RUN)).toEqual({ deletes: [], newlyMissing: [], reappeared: [], refused: null });
    expect(plan_([], [led("a")]).refused).toMatch(/allow one large delete/);
    const paths = many(30);
    expect(plan_([file(paths[0]!)], paths.map((p) => led(p))).refused).toMatch(/allow one large delete/);
  });

  it("a file missing for the first time is only marked, never deleted", () => {
    const plan = plan_([file("keep")], [fresh("keep"), fresh("gone")]);
    expect(plan.deletes).toEqual([]);
    expect(plan.newlyMissing).toEqual(["gone"]);
  });

  it("deletes a file already marked missing by an earlier run, but not one marked by this run", () => {
    expect(plan_([file("keep")], [fresh("keep"), led("gone", 1)]).deletes.map((d) => d.remotePath)).toEqual(["gone"]);
    expect(plan_([file("keep")], [fresh("keep"), led("gone", RUN)]).deletes).toEqual([]);
  });

  it("a file that is listed again has its mark cleared and is not deleted", () => {
    const plan = plan_([file("a")], [led("a", 1)]);
    expect(plan.deletes).toEqual([]);
    expect(plan.reappeared).toEqual(["a"]);
  });

  it("alternating halves hidden on successive runs never delete anything (the erosion case; the same files hidden twice in a row would, by design)", () => {
    const paths = many(100);
    let ledger = paths.map((p) => fresh(p));
    for (let run = 1; run <= 20; run++) {
      const hidden = new Set(paths.filter((_, i) => (run % 2 === 1 ? i < 49 : i >= 51)));
      const plan = planMirrorDeletes(paths.filter((p) => !hidden.has(p)).map((p) => file(p)), ledgerMap(ledger), false, run);
      expect(plan.deletes).toEqual([]);
      const mark = new Set(plan.newlyMissing);
      const clear = new Set(plan.reappeared);
      ledger = ledger.map((l) => (clear.has(l.remotePath) ? fresh(l.remotePath) : mark.has(l.remotePath) ? led(l.remotePath, run) : l));
    }
  });

  it("does not mark anything when the listing is refused", () => {
    const paths = many(30);
    const plan = plan_(paths.slice(0, 10).map((p) => file(p)), paths.map((p) => fresh(p)));
    expect(plan.refused).not.toBeNull();
    expect(plan.newlyMissing).toEqual([]);
  });

  it("the explicit allowance skips the two-listing wait", () => {
    expect(plan_([file("keep")], [fresh("keep"), fresh("gone")], true).deletes.map((d) => d.remotePath)).toEqual(["gone"]);
  });
});
