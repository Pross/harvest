import { describe, expect, it } from "vitest";
import { planRun } from "../../src/planner/plan.js";
import { file, input, job, obsMap, seenObs, ledgerMap } from "./helpers.js";

function settled(entries: ReturnType<typeof file>[], over = {}) {
  return input(entries, { observations: obsMap(entries.map((e) => seenObs(e))), ...over });
}
const reasons = (p: ReturnType<typeof planRun>) => Object.fromEntries(p.skipped.map((s) => [s.remotePath, s.reason]));

describe("filters", () => {
  it("pack with excluded nfo and Sample dir still syncs the rest", () => {
    const es = [file("Pack/e1.mkv"), file("Pack/e2.mkv"), file("Pack/info.nfo", 1), file("Pack/Sample/s.mkv")];
    const i = settled(es, { job: job({ excludeGlobs: ["**/*.nfo", "**/Sample/**"] }) });
    const plan = planRun(i);
    expect(plan.units).toHaveLength(1);
    expect(plan.units[0]?.files.map((f) => f.remotePath)).toEqual(["Pack/e1.mkv", "Pack/e2.mkv"]);
    expect(reasons(plan)["Pack/info.nfo"]).toBe("filtered_glob");
    expect(reasons(plan)["Pack/Sample/s.mkv"]).toBe("filtered_glob");
  });

  it("exclude globs match root files with dot true", () => {
    const es = [file(".hidden.tmp"), file("a/.x.tmp")];
    const plan = planRun(settled(es));
    expect(Object.values(reasons(plan))).toEqual(["filtered_glob", "filtered_glob"]);
  });

  it("empty include means everything", () => {
    const plan = planRun(settled([file("a/x.mkv")], { job: job({ excludeGlobs: [] }) }));
    expect(plan.units).toHaveLength(1);
  });

  it("include globs restrict files", () => {
    const es = [file("a/x.mkv"), file("a/y.txt")];
    const plan = planRun(settled(es, { job: job({ includeGlobs: ["**/*.mkv"] }) }));
    expect(plan.units[0]?.files).toHaveLength(1);
    expect(reasons(plan)["a/y.txt"]).toBe("filtered_glob");
  });

  it("exclude wins over include", () => {
    const es = [file("a/x.mkv")];
    const plan = planRun(settled(es, { job: job({ includeGlobs: ["**/*.mkv"], excludeGlobs: ["a/**"] }) }));
    expect(plan.units).toEqual([]);
  });

  it("min size filters small files", () => {
    const es = [file("a/big", 500), file("a/small", 5)];
    const plan = planRun(settled(es, { job: job({ minSize: 100 }) }));
    expect(reasons(plan)["a/small"]).toBe("filtered_size");
    expect(plan.units[0]?.files.map((f) => f.size)).toEqual([500]);
  });

  it("max size filters large files", () => {
    const es = [file("a/big", 500), file("a/small", 5)];
    const plan = planRun(settled(es, { job: job({ maxSize: 100 }) }));
    expect(reasons(plan)["a/big"]).toBe("filtered_size");
  });

  it("size bounds are inclusive", () => {
    const es = [file("a/x", 100)];
    const plan = planRun(settled(es, { job: job({ minSize: 100, maxSize: 100 }) }));
    expect(plan.units).toHaveLength(1);
  });

  it("a unit whose files are all filtered is not planned", () => {
    const plan = planRun(settled([file("a/x.nfo")], { job: job({ excludeGlobs: ["**/*.nfo"] }) }));
    expect(plan.units).toEqual([]);
  });
});

describe("in-progress markers", () => {
  const pack = [file("Pack/e1.mkv"), file("Pack/e2.mkv.part"), file("Pack/e3.mkv")];

  it("marker inside a pack holds the whole unit", () => {
    const plan = planRun(settled(pack));
    expect(plan.units).toEqual([]);
    expect(reasons(plan)).toEqual({
      "Pack/e1.mkv": "unit_held", "Pack/e2.mkv.part": "in_progress_marker", "Pack/e3.mkv": "unit_held",
    });
  });

  it("holds the unit even when the marker is excluded by default excludes", () => {
    const plan = planRun(settled(pack, { job: job({ excludeGlobs: ["**/*.part"] }) }));
    expect(plan.units).toEqual([]);
    expect(reasons(plan)["Pack/e2.mkv.part"]).toBe("in_progress_marker");
  });

  it("holds the unit even with no excludes at all", () => {
    const plan = planRun(settled(pack, { job: job({ excludeGlobs: [] }) }));
    expect(plan.units).toEqual([]);
  });

  it.each(["x.!qB", "x.!ut"])("%s is a marker", (name) => {
    const plan = planRun(settled([file(`P/${name}`), file("P/a.mkv")]));
    expect(reasons(plan)[`P/${name}`]).toBe("in_progress_marker");
    expect(reasons(plan)["P/a.mkv"]).toBe("unit_held");
  });

  it(".incomplete dir content holds the unit", () => {
    const plan = planRun(settled([file("P/.incomplete/x"), file("P/a.mkv")]));
    expect(reasons(plan)["P/.incomplete/x"]).toBe("in_progress_marker");
    expect(plan.units).toEqual([]);
  });

  it("loose root marker in file mode is skipped without holding others", () => {
    const es = [file("a.mkv"), file("b.mkv.part")];
    const plan = planRun(settled(es, { job: job({ unitMode: "file" }) }));
    expect(plan.units.map((u) => u.key)).toEqual(["a.mkv"]);
    expect(reasons(plan)["b.mkv.part"]).toBe("in_progress_marker");
  });

  it("in file mode a marker in a subdir holds nothing else", () => {
    const es = [file("P/a.mkv"), file("P/b.part")];
    const plan = planRun(settled(es, { job: job({ unitMode: "file" }) }));
    expect(plan.units.map((u) => u.key)).toEqual(["P/a.mkv"]);
  });

  it("other units are unaffected", () => {
    const plan = planRun(settled([...pack, file("Other/a.mkv")]));
    expect(plan.units.map((u) => u.key)).toEqual(["Other"]);
  });

  it("holds a completed pack that gained a marker", () => {
    const es = [file("Pack/e1.mkv"), file("Pack/n.part")];
    const plan = planRun(settled(es, { completedUnits: new Set(["Pack"]), ledger: ledgerMap([]) }));
    expect(plan.units).toEqual([]);
  });
});
