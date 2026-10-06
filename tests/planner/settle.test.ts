import { describe, expect, it } from "vitest";
import { planRun } from "../../src/planner/plan.js";
import { evaluateFile, updateObservation } from "../../src/planner/settle.js";
import { NOW, OLD, file, input, job, ledgerMap, obsMap, seenObs } from "./helpers.js";

const S = 60_000;
const reasonOf = (p: ReturnType<typeof planRun>, path: string) => p.skipped.find((s) => s.remotePath === path)?.reason;

describe("updateObservation", () => {
  const f = { remotePath: "a/x", size: 10, mtimeMs: 5 };
  it("creates a new observation", () => {
    expect(updateObservation(undefined, f, NOW)).toEqual({ ...f, firstSeenAt: NOW, lastChangedAt: NOW, lastSeenAt: NOW });
  });
  it("unchanged keeps lastChangedAt, bumps lastSeenAt", () => {
    const prev = { ...f, firstSeenAt: 1, lastChangedAt: 2, lastSeenAt: 3 };
    expect(updateObservation(prev, f, NOW)).toEqual({ ...prev, lastSeenAt: NOW });
  });
  it("size change resets lastChangedAt", () => {
    const prev = { ...f, firstSeenAt: 1, lastChangedAt: 2, lastSeenAt: 3 };
    expect(updateObservation(prev, { ...f, size: 11 }, NOW).lastChangedAt).toBe(NOW);
  });
  it("mtime change resets lastChangedAt", () => {
    const prev = { ...f, firstSeenAt: 1, lastChangedAt: 2, lastSeenAt: 3 };
    const next = updateObservation(prev, { ...f, mtimeMs: 6 }, NOW);
    expect(next.lastChangedAt).toBe(NOW);
    expect(next.firstSeenAt).toBe(1);
  });
});

describe("first sighting and settle", () => {
  it("first sighting never transfers and starts the clock", () => {
    const e = file("Pack/a.mkv");
    const plan = planRun(input([e]));
    expect(plan.units).toEqual([]);
    expect(reasonOf(plan, "Pack/a.mkv")).toBe("first_sighting");
    expect(plan.observations).toEqual([{ remotePath: "Pack/a.mkv", size: 100, mtimeMs: OLD, firstSeenAt: NOW, lastChangedAt: NOW, lastSeenAt: NOW }]);
    expect(plan.followupAt).toBe(NOW + S);
  });

  it("transfers on a later call once settled (observations fed back)", () => {
    const e = file("Pack/a.mkv");
    const first = planRun(input([e]));
    const later = planRun(input([e], { observations: obsMap(first.observations), now: NOW + S }));
    expect(later.units.map((u) => u.key)).toEqual(["Pack"]);
    expect(later.followupAt).toBeNull();
  });

  it("is unsettled just before the settle window ends", () => {
    const e = file("Pack/a.mkv");
    const first = planRun(input([e]));
    const later = planRun(input([e], { observations: obsMap(first.observations), now: NOW + S - 1 }));
    expect(reasonOf(later, "Pack/a.mkv")).toBe("unsettled");
    expect(later.followupAt).toBe(NOW + S - 1 + S);
  });

  it("a growing file resets the clock", () => {
    const e = file("Pack/a.mkv", 100);
    const first = planRun(input([e]));
    const grown = file("Pack/a.mkv", 200);
    const second = planRun(input([grown], { observations: obsMap(first.observations), now: NOW + S }));
    expect(reasonOf(second, "Pack/a.mkv")).toBe("unsettled");
    expect(second.observations[0]?.lastChangedAt).toBe(NOW + S);
    const third = planRun(input([grown], { observations: obsMap(second.observations), now: NOW + 2 * S }));
    expect(third.units).toHaveLength(1);
  });

  it("mtime change alone resets the clock", () => {
    const e = file("P/a");
    const changed = file("P/a", 100, OLD + 1);
    const plan = planRun(input([changed], { observations: obsMap([seenObs(e)]) }));
    expect(reasonOf(plan, "P/a")).toBe("unsettled");
  });

  it("settleSeconds 0 still never transfers on first sighting", () => {
    const plan = planRun(input([file("P/a")], { job: job({ settleSeconds: 0 }) }));
    expect(reasonOf(plan, "P/a")).toBe("first_sighting");
  });

  it("one unsettled file holds every file of its unit", () => {
    const a = file("P/a"), b = file("P/b");
    const plan = planRun(input([a, b], { observations: obsMap([seenObs(a)]) }));
    expect(plan.units).toEqual([]);
    expect(reasonOf(plan, "P/a")).toBe("unit_held");
    expect(reasonOf(plan, "P/b")).toBe("first_sighting");
  });

  it("other units are independent", () => {
    const a = file("P/a"), b = file("Q/b");
    const plan = planRun(input([a, b], { observations: obsMap([seenObs(a)]) }));
    expect(plan.units.map((u) => u.key)).toEqual(["P"]);
    expect(reasonOf(plan, "Q/b")).toBe("first_sighting");
  });

  it("observations include every listed sane file, including skipped ones", () => {
    const plan = planRun(input([file("P/a.nfo"), file("P/b.part"), file("../bad")]));
    expect(plan.observations.map((o) => o.remotePath)).toEqual(["P/a.nfo", "P/b.part"]);
  });

  it("followupAt is null when nothing waits", () => {
    const a = file("P/a");
    const plan = planRun(input([a], { observations: obsMap([seenObs(a)]) }));
    expect(plan.followupAt).toBeNull();
  });

  it("followupAt is null for unrelated skips only", () => {
    const a = file("P/a");
    const plan = planRun(input([a], { ledger: ledgerMap([{ remotePath: "P/a", size: 100, mtimeMs: null, syncedAt: 1 }]) }));
    expect(plan.followupAt).toBeNull();
  });
});

describe("trustMtime", () => {
  const j = job({ trustMtime: true });
  it("transfers on first sighting when the mtime is old enough", () => {
    const plan = planRun(input([file("P/a")], { job: j }));
    expect(plan.units).toHaveLength(1);
  });
  it("does not trust a recent mtime", () => {
    const plan = planRun(input([file("P/a", 100, NOW - 1000)], { job: j }));
    expect(reasonOf(plan, "P/a")).toBe("first_sighting");
  });
  it("does not trust a null mtime", () => {
    const plan = planRun(input([file("P/a", 100, null)], { job: j }));
    expect(reasonOf(plan, "P/a")).toBe("first_sighting");
  });
  it("is off by default", () => {
    expect(planRun(input([file("P/a")])).units).toEqual([]);
  });

  it("keeps trusting an unchanged old mtime on a retry inside the settle window (an interrupted run recorded the sighting)", () => {
    const e = file("P/a");
    const plan = planRun(input([e], { job: j, observations: obsMap([seenObs(e, 5_000)]) }));
    expect(plan.units).toHaveLength(1);
    expect(plan.skipped).toEqual([]);
  });
  it("without trustMtime the same retry still waits for the settle window", () => {
    const e = file("P/a");
    const plan = planRun(input([e], { observations: obsMap([seenObs(e, 5_000)]) }));
    expect(reasonOf(plan, "P/a")).toBe("unsettled");
  });
  it("stops trusting the mtime once the file has been seen to change", () => {
    const e = file("P/a");
    const changed = { ...seenObs(e, 200_000), lastChangedAt: NOW - 5_000 };
    expect(reasonOf(planRun(input([e], { job: j, observations: obsMap([changed]) })), "P/a")).toBe("unsettled");
  });
  it("does not trust a recent mtime on a retry either", () => {
    const e = file("P/a", 100, NOW - 1000);
    const plan = planRun(input([e], { job: j, observations: obsMap([seenObs(e, 5_000)]) }));
    expect(reasonOf(plan, "P/a")).toBe("unsettled");
  });
});

describe("min age", () => {
  const j = job({ minAgeSeconds: 3600 });
  const young = file("P/a", 100, NOW - 1000);
  it("holds a settled but too young file", () => {
    const plan = planRun(input([young], { job: j, observations: obsMap([seenObs(young)]) }));
    expect(reasonOf(plan, "P/a")).toBe("too_young");
    expect(plan.followupAt).toBe(NOW + S);
  });
  it("passes exactly at the min age", () => {
    const e = file("P/a", 100, NOW - 3_600_000);
    const plan = planRun(input([e], { job: j, observations: obsMap([seenObs(e)]) }));
    expect(plan.units).toHaveLength(1);
  });
  it("one young file holds its unit", () => {
    const a = file("P/a"), b = file("P/b", 100, NOW - 10);
    const plan = planRun(input([a, b], { job: j, observations: obsMap([seenObs(a), seenObs(b)]) }));
    expect(plan.units).toEqual([]);
    expect(reasonOf(plan, "P/a")).toBe("unit_held");
    expect(reasonOf(plan, "P/b")).toBe("too_young");
  });
  it("null mtime disables min age and warns", () => {
    const e = file("P/a", 100, null);
    const plan = planRun(input([e], { job: j, observations: obsMap([seenObs(e)]) }));
    expect(plan.units).toHaveLength(1);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("P/a");
  });
  it("null mtime without min age does not warn", () => {
    const e = file("P/a", 100, null);
    const plan = planRun(input([e], { observations: obsMap([seenObs(e)]) }));
    expect(plan.warnings).toEqual([]);
  });
  it("evaluateFile prefers the settle reason over too_young", () => {
    const o = seenObs(young, 0);
    expect(evaluateFile(j, false, o, NOW).reason).toBe("unsettled");
  });
});
