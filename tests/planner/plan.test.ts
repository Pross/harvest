import { describe, expect, it } from "vitest";
import { planRun, unitKeyFor } from "../../src/planner/plan.js";
import { file, input, job, ledgerMap, obsMap, seenObs } from "./helpers.js";

const ready = (es: ReturnType<typeof file>[], over = {}) =>
  input(es, { observations: obsMap(es.map((e) => seenObs(e))), ...over });
const led = (path: string, size = 100) => ({ remotePath: path, size, mtimeMs: null, syncedAt: 1 });

describe("unitKeyFor", () => {
  it("top_dir returns the first segment", () => expect(unitKeyFor("Show/S01/e.mkv", "top_dir")).toBe("Show"));
  it("top_dir returns the file itself at the root", () => expect(unitKeyFor("movie.mkv", "top_dir")).toBe("movie.mkv"));
  it("file returns the path", () => expect(unitKeyFor("Show/S01/e.mkv", "file")).toBe("Show/S01/e.mkv"));
});

describe("mirror", () => {
  const mirror = job({ mode: "mirror" });
  it("plans like copy mode when nothing is missing locally", () => {
    const e = file("P/a");
    const plan = planRun(ready([e], { job: mirror, ledger: ledgerMap([led("P/a")]) }));
    expect(plan.units).toEqual([]);
    expect(plan.skipped).toEqual([{ remotePath: "P/a", reason: "already_synced" }]);
  });

  it("downloads a ledger file again when its local copy is missing", () => {
    const e = file("P/a");
    const plan = planRun(ready([e], { job: mirror, ledger: ledgerMap([led("P/a")]), missingLocal: new Set(["P/a"]) }));
    expect(plan.units.map((u) => u.key)).toEqual(["P"]);
  });

  it("ignores missingLocal outside mirror mode, so a deleted local file is never re-downloaded", () => {
    const e = file("P/a");
    const plan = planRun(ready([e], { ledger: ledgerMap([led("P/a")]), missingLocal: new Set(["P/a"]) }));
    expect(plan.units).toEqual([]);
  });
});

describe("ledger", () => {
  it("skip policy ignores a changed size", () => {
    const e = file("P/a", 200);
    const plan = planRun(ready([e], { ledger: ledgerMap([led("P/a", 100)]) }));
    expect(plan.units).toEqual([]);
    expect(plan.skipped).toEqual([{ remotePath: "P/a", reason: "already_synced" }]);
  });
  it("resync policy treats a changed size as new", () => {
    const e = file("P/a", 200);
    const plan = planRun(ready([e], { job: job({ changedPolicy: "resync" }), ledger: ledgerMap([led("P/a", 100)]) }));
    expect(plan.units[0]?.files[0]?.size).toBe(200);
  });
  it("resync policy skips an unchanged size", () => {
    const e = file("P/a", 100);
    const plan = planRun(ready([e], { job: job({ changedPolicy: "resync" }), ledger: ledgerMap([led("P/a", 100)]) }));
    expect(plan.units).toEqual([]);
  });
  it("resync does not compare mtime", () => {
    const e = file("P/a", 100, 12345);
    const plan = planRun(ready([e], { job: job({ changedPolicy: "resync" }), ledger: ledgerMap([led("P/a", 100)]) }));
    expect(plan.skipped[0]?.reason).toBe("already_synced");
  });
  it("a synced pack that gains a file plans only the new file with existing=true", () => {
    const es = [file("P/a"), file("P/b")];
    const plan = planRun(ready(es, { ledger: ledgerMap([led("P/a")]), completedUnits: new Set(["P"]) }));
    expect(plan.units).toHaveLength(1);
    expect(plan.units[0]?.existing).toBe(true);
    expect(plan.units[0]?.files.map((f) => f.remotePath)).toEqual(["P/b"]);
  });
  it("new unit has existing=false", () => {
    expect(planRun(ready([file("P/a")])).units[0]?.existing).toBe(false);
  });
  it("a new file added to a synced pack still waits for first sighting", () => {
    const a = file("P/a");
    const plan = planRun(input([a, file("P/b")], { observations: obsMap([seenObs(a)]), ledger: ledgerMap([led("P/a")]), completedUnits: new Set(["P"]) }));
    expect(plan.units).toEqual([]);
    expect(plan.skipped.find((s) => s.remotePath === "P/b")?.reason).toBe("first_sighting");
  });
});

describe("units and ordering", () => {
  it("sorts units by key, files by path, and sums bytes", () => {
    const es = [file("Z/b", 3), file("A/z", 5), file("Z/a", 4), file("A/a", 1)];
    const plan = planRun(ready(es));
    expect(plan.units.map((u) => u.key)).toEqual(["A", "Z"]);
    expect(plan.units[0]?.files.map((f) => f.remotePath)).toEqual(["A/a", "A/z"]);
    expect(plan.units.map((u) => u.totalBytes)).toEqual([6, 7]);
  });
  it("file mode makes one unit per file", () => {
    const es = [file("P/a"), file("P/b")];
    const plan = planRun(ready(es, { job: job({ unitMode: "file" }) }));
    expect(plan.units.map((u) => u.key)).toEqual(["P/a", "P/b"]);
  });
  it("file mode: an unsettled file does not hold its neighbors", () => {
    const a = file("P/a");
    const plan = planRun(input([a, file("P/b")], { job: job({ unitMode: "file" }), observations: obsMap([seenObs(a)]) }));
    expect(plan.units.map((u) => u.key)).toEqual(["P/a"]);
  });
  it("root file in top_dir mode is its own unit", () => {
    const plan = planRun(ready([file("movie.mkv")]));
    expect(plan.units[0]?.key).toBe("movie.mkv");
  });
  it("planned files carry size and mtime", () => {
    const plan = planRun(ready([file("P/a", 7, 42)]));
    expect(plan.units[0]?.files[0]).toEqual({ remotePath: "P/a", size: 7, mtimeMs: 42 });
  });
});

describe("vanished", () => {
  it("lists observed paths missing from the listing", () => {
    const gone = file("P/gone");
    const here = file("P/here");
    const plan = planRun(input([here], { observations: obsMap([seenObs(gone), seenObs(here)]) }));
    expect(plan.vanished).toEqual(["P/gone"]);
  });
  it("is empty when everything is still listed", () => {
    const here = file("P/here");
    expect(planRun(ready([here])).vanished).toEqual([]);
  });
  it("does not treat skipped-but-listed files as vanished", () => {
    const e = file("P/a.part");
    expect(planRun(ready([e])).vanished).toEqual([]);
  });
});

describe("determinism", () => {
  it("same input gives identical output and input is not mutated", () => {
    const es = [file("B/x"), file("A/y"), file("A/z.part"), file("../bad"), file("C/q", 5, null)];
    const i = input(es, { observations: obsMap([seenObs(es[0]!)]) });
    const snapshot = JSON.stringify(es);
    expect(planRun(i)).toEqual(planRun(i));
    expect(JSON.stringify(es)).toBe(snapshot);
  });
  it("listing order does not change the result", () => {
    const es = [file("B/x"), file("A/y"), file("A/z")];
    const obs = obsMap(es.map((e) => seenObs(e)));
    expect(planRun(input(es, { observations: obs }))).toEqual(planRun(input([...es].reverse(), { observations: obs })));
  });
  it("empty listing yields an empty plan", () => {
    expect(planRun(input([]))).toEqual({ units: [], skipped: [], observations: [], vanished: [], followupAt: null, warnings: [] });
  });
});
