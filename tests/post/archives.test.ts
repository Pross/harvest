import { describe, expect, it } from "vitest";
import { groupArchives } from "../../src/post/archives.js";

const names = (files: string[]) => groupArchives(files).sets.map((s) => [s.kind, s.first.split("/").pop(), s.parts.map((p) => p.split("/").pop())]);

describe("groupArchives", () => {
  it("finds zip and 7z archives", () => {
    expect(names(["/s/a.zip", "/s/b.7z", "/s/c.mkv"])).toEqual([["other", "a.zip", ["a.zip"]], ["other", "b.7z", ["b.7z"]]]);
  });

  it("extracts a .rar/.r00 set from the .rar only and owns the other volumes", () => {
    expect(names(["/s/x.r01", "/s/x.rar", "/s/x.r00", "/s/x.nfo"])).toEqual([["rar", "x.rar", ["x.rar", "x.r00", "x.r01"]]]);
  });

  it("extracts a partN.rar set from the lowest part, with or without zero padding", () => {
    expect(names(["/s/y.part2.rar", "/s/y.part1.rar", "/s/y.part3.rar"])).toEqual([["rar", "y.part1.rar", ["y.part1.rar", "y.part2.rar", "y.part3.rar"]]]);
    expect(names(["/s/z.part02.rar", "/s/z.part01.rar"])[0]![1]).toBe("z.part01.rar");
  });

  it("warns and extracts nothing when the first volume is missing", () => {
    const g = groupArchives(["/s/y.part2.rar", "/s/y.part3.rar", "/s/o.r00", "/s/o.r01"]);
    expect(g.sets).toEqual([]);
    expect(g.warnings).toHaveLength(2);
  });

  it("keeps sets in different folders apart", () => {
    expect(groupArchives(["/s/a/x.rar", "/s/b/x.rar", "/s/b/x.r00"]).sets.map((s) => s.parts.length)).toEqual([1, 2]);
  });

  it("handles split 7z volumes", () => {
    expect(names(["/s/p.7z.002", "/s/p.7z.001"])).toEqual([["other", "p.7z.001", ["p.7z.001", "p.7z.002"]]]);
  });
});
