import { describe, expect, it } from "vitest";
import { sanitizeRemotePath } from "../../src/planner/plan.js";
import { planRun } from "../../src/planner/plan.js";
import { file, input, obsMap, seenObs } from "./helpers.js";

const L = "/data/local";

describe("sanitizeRemotePath", () => {
  it.each([
    ["../x", "dotdot"], ["/etc/passwd", "absolute"], ["a/../../b", "dotdot mid"], ["a\\b", "backslash"],
    [".harvest-staging/x", "staging"], ["a/.harvest-staging/x", "nested staging"], ["a\0b", "nul"],
    ["", "empty"], ["a//b", "empty segment"], ["a/", "trailing slash"], ["a/./b", "dot"], ["x".repeat(1025), "long"],
  ])("rejects %j (%s)", (p) => {
    expect(sanitizeRemotePath(p, L).ok).toBe(false);
  });

  it("accepts a normal nested path", () => {
    expect(sanitizeRemotePath("Show/S01/e01.mkv", L)).toEqual({ ok: true, path: "Show/S01/e01.mkv" });
  });

  it("accepts a 1024 char path", () => {
    expect(sanitizeRemotePath("x".repeat(1024), L).ok).toBe(true);
  });

  it("normalizes to NFC", () => {
    const res = sanitizeRemotePath("Café/a.mkv", L);
    expect(res).toEqual({ ok: true, path: "Café/a.mkv" });
  });

  it("accepts names that merely contain dots", () => {
    expect(sanitizeRemotePath("a..b/c...d", L).ok).toBe(true);
  });
});

describe("planRun path handling", () => {
  it("skips hostile entries with unsafe_path and detail", () => {
    const plan = planRun(input([file("../x"), file("/etc/passwd"), file(".harvest-staging/x"), file("ok/a.mkv")]));
    const unsafe = plan.skipped.filter((s) => s.reason === "unsafe_path");
    expect(unsafe).toHaveLength(3);
    expect(unsafe.every((s) => typeof s.detail === "string")).toBe(true);
  });

  it("does not create observations for unsafe paths", () => {
    const plan = planRun(input([file("../x"), file("ok/a.mkv")]));
    expect(plan.observations.map((o) => o.remotePath)).toEqual(["ok/a.mkv"]);
  });

  it("never plans directory entries", () => {
    const plan = planRun(input([{ path: "d", size: 0, mtimeMs: null, isDir: true }]));
    expect(plan.units).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it("stores NFC paths in the plan", () => {
    const plan = planRun(input([file("Café/a.mkv")]));
    expect(plan.observations[0]?.remotePath).toBe("Café/a.mkv");
  });

  it("keeps the server's own spelling in remoteRaw only when it differs from NFC", () => {
    const nfd = "Cafe\u0301/a.mkv";
    const es = [file(nfd), file("plain/b.mkv")];
    const observations = obsMap(es.map((e) => ({ ...seenObs(e), remotePath: e.path.normalize("NFC") })));
    const plan = planRun(input(es, { observations }));
    const files = plan.units.flatMap((u) => u.files);
    const cafe = files.find((f) => f.remotePath === "Café/a.mkv");
    expect(cafe?.remoteRaw).toBe(nfd);
    expect(files.find((f) => f.remotePath === "plain/b.mkv")?.remoteRaw).toBeUndefined();
  });

  it("flags NFC duplicates", () => {
    const plan = planRun(input([file("Café/a"), file("Café/a")]));
    expect(plan.skipped.filter((s) => s.reason === "unsafe_path")).toHaveLength(1);
  });
});
