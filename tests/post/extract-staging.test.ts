import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JobConfig } from "../../src/domain.js";
import { createExtractStep } from "../../src/post/extract.js";
import type { RunTool } from "../../src/post/extract-tools.js";
import { fakeRunner, fakeTools, type FakeArchive } from "./fake-tools.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ep = (name: string): FakeArchive => ({ entries: [{ path: name, content: `fresh-${name}` }] });

function setup(archives: Record<string, FakeArchive>, files: string[], wrap?: (inner: RunTool, ctl: AbortController) => RunTool) {
  const unitDir = mkdtempSync(path.join(tmpdir(), "stg-"));
  dirs.push(unitDir);
  const paths = files.map((f) => path.join(unitDir, f));
  for (const p of paths) writeFileSync(p, "archive-bytes");
  const ctl = new AbortController();
  const inner = fakeRunner(archives).run;
  const step = createExtractStep({ postStore: { get: () => ({ extract: "keep", chmodFile: null, chmodDir: null }) }, tools: fakeTools, run: wrap ? wrap(inner, ctl) : inner });
  return { unitDir, ctl, go: () => step.run({ job: { id: 1 } as JobConfig, runId: 1, signal: ctl.signal, unitDir, files: paths }) };
}

describe("extraction output stranded in staging", () => {
  it("replaces stale extracted output left in staging by an earlier aborted attempt", async () => {
    const t = setup({ "a.zip": ep("ep.mkv") }, ["a.zip"]);
    writeFileSync(path.join(t.unitDir, "ep.mkv"), "stale-from-aborted-attempt");
    const r = await t.go();
    expect(r.warnings).toEqual([]);
    expect(readFileSync(path.join(t.unitDir, "ep.mkv"), "utf8")).toBe("fresh-ep.mkv");
    expect(r.added).toEqual([path.join(t.unitDir, "ep.mkv")]);
  });

  it("still refuses to overwrite one of the unit's own staged downloads", async () => {
    const t = setup({ "a.zip": ep("b.txt") }, ["a.zip", "b.txt"]);
    const r = await t.go();
    expect(r.added).toEqual([]);
    expect(r.warnings[0]).toMatch(/would overwrite an existing file/);
    expect(readFileSync(path.join(t.unitDir, "b.txt"), "utf8")).toBe("archive-bytes");
  });

  it("deletes stale .harvest-extract-* directories before extracting", async () => {
    const t = setup({ "a.zip": ep("ep.mkv") }, ["a.zip"]);
    mkdirSync(path.join(t.unitDir, ".harvest-extract-OLD1"));
    writeFileSync(path.join(t.unitDir, ".harvest-extract-OLD1", "half.bin"), "x");
    await t.go();
    expect(readdirSync(t.unitDir).filter((n) => n.startsWith(".harvest-extract-"))).toEqual([]);
  });

  it("an abort during a later set removes extras already moved for earlier sets", async () => {
    const t = setup({ "a.zip": ep("one.mkv"), "b.zip": ep("two.mkv") }, ["a.zip", "b.zip"], (inner, ctl) => async (bin, args, o) => {
      if (args[args.length - 1]!.endsWith("b.zip")) {
        ctl.abort();
        throw new Error("aborted");
      }
      return inner(bin, args, o);
    });
    await expect(t.go()).rejects.toThrow("aborted");
    expect(existsSync(path.join(t.unitDir, "one.mkv"))).toBe(false);
    expect(readdirSync(t.unitDir).sort()).toEqual(["a.zip", "b.zip"]);
  });
});
