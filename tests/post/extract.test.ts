import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtractStep } from "../../src/post/extract.js";
import type { PostConfig } from "../../src/store/post-store.js";
import type { JobConfig } from "../../src/domain.js";
import { fakeRunner, fakeTools, type FakeArchive } from "./fake-tools.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup(mode: PostConfig["extract"], archives: Record<string, FakeArchive>, files: string[], extra: Partial<Parameters<typeof createExtractStep>[0]> = {}) {
  const unitDir = mkdtempSync(path.join(tmpdir(), "ext-"));
  dirs.push(unitDir);
  const paths = files.map((f) => path.join(unitDir, f));
  for (const p of paths) { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, "archive-bytes"); }
  const { run, calls } = fakeRunner(archives);
  const step = createExtractStep({ postStore: { get: () => ({ extract: mode, chmodFile: null, chmodDir: null }) }, tools: fakeTools, run, ...extra });
  const go = (signal = new AbortController().signal) => step.run({ job: { id: 1 } as JobConfig, runId: 1, signal, unitDir, files: paths });
  return { unitDir, paths, calls, go };
}

const media: FakeArchive = { entries: [{ path: "Show/ep1.mkv", content: "video1" }, { path: "Show/ep1.nfo", content: "nfo" }] };

describe("ExtractStep with a fake extractor", () => {
  it("does nothing when extraction is off", async () => {
    const t = setup("off", { "a.zip": media }, ["a.zip"]);
    expect(await t.go()).toEqual({ warnings: [], added: [], removed: [] });
    expect(t.calls).toEqual([]);
  });

  it("extracts next to the archive and keeps the archive", async () => {
    const t = setup("keep", { "a.zip": media }, ["d/a.zip"]);
    const r = await t.go();
    expect(r.warnings).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.added.sort()).toEqual([path.join(t.unitDir, "d/Show/ep1.mkv"), path.join(t.unitDir, "d/Show/ep1.nfo")]);
    expect(readFileSync(r.added[0]!, "utf8")).toMatch(/video1|nfo/);
    expect(existsSync(t.paths[0]!)).toBe(true);
    expect(readdirSync(t.unitDir).filter((n) => n.startsWith(".harvest-extract"))).toEqual([]);
  });

  it("reports every volume as removed in delete mode, using the first volume only", async () => {
    const t = setup("delete", { "x.rar": media }, ["x.rar", "x.r00", "x.r01"]);
    const r = await t.go();
    expect(r.removed.map((p) => path.basename(p)).sort()).toEqual(["x.r00", "x.r01", "x.rar"]);
    expect(t.calls.filter((c) => c.bin === "/fake/unar")).toHaveLength(1);
    expect(t.calls.every((c) => c.args.at(-1)!.endsWith("x.rar"))).toBe(true);
    expect(t.calls[0]!.bin).toBe("/fake/lsar");
  });

  it("leaves the archive and warns when the extractor fails", async () => {
    const t = setup("delete", { "a.zip": { ...media, failExtract: "Wrong password" } }, ["a.zip"]);
    const r = await t.go();
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.warnings[0]).toMatch(/a\.zip.*Wrong password/);
    expect(readdirSync(t.unitDir)).toEqual(["a.zip"]);
  });

  it("rejects archives with link entries before extracting", async () => {
    const t = setup("keep", { "a.zip": { entries: [{ path: "f", content: "x" }, { path: "lnk", link: true }] } }, ["a.zip"]);
    const r = await t.go();
    expect(r.warnings[0]).toMatch(/contains a link/);
    expect(t.calls).toHaveLength(1);
  });

  it.each(["../escape.txt", "/etc/passwd", "a/../../b"])("rejects the unsafe entry name %s", async (name) => {
    const t = setup("keep", { "a.zip": { entries: [{ path: name, content: "x" }] } }, ["a.zip"]);
    expect((await t.go()).warnings[0]).toMatch(/unsafe path/);
  });

  it("removes a symlink that appears after extraction and keeps the archive", async () => {
    const t = setup("delete", { "a.zip": { ...media, writeSymlink: "/etc" } }, ["a.zip"]);
    const r = await t.go();
    expect(r.warnings[0]).toMatch(/symbolic link/);
    expect(r.added).toEqual([]);
    expect(readdirSync(t.unitDir)).toEqual(["a.zip"]);
  });

  it("enforces the entry and size caps", async () => {
    const many = setup("keep", { "a.zip": media }, ["a.zip"], { limits: { maxBytes: 1e9, maxEntries: 1 } });
    expect((await many.go()).warnings[0]).toMatch(/more than 1 entries/);
    const big = setup("keep", { "a.zip": { entries: [{ path: "huge", size: 51 * 1024 ** 3 }] } }, ["a.zip"]);
    expect((await big.go()).warnings[0]).toMatch(/byte cap/);
  });

  it("checks free space first", async () => {
    const t = setup("keep", { "a.zip": media }, ["a.zip"], { statfs: async () => ({ bavail: 1, bsize: 1 }) });
    const r = await t.go();
    expect(r.warnings[0]).toMatch(/free space/);
    expect(t.calls).toHaveLength(1);
  });

  it("refuses to overwrite an existing file and rolls back", async () => {
    const t = setup("keep", { "a.zip": media }, ["a.zip", "Show/ep1.nfo"]);
    const r = await t.go();
    expect(r.warnings[0]).toMatch(/overwrite/);
    expect(existsSync(path.join(t.unitDir, "Show/ep1.mkv"))).toBe(false);
  });

  it("warns that RAR is unsupported when no RAR extractor exists, and still handles zip", async () => {
    const t = setup("keep", { "a.zip": media, "r.rar": media }, ["a.zip", "r.rar"], { tools: { sevenZip: fakeTools.sevenZip, rar: null } });
    const r = await t.go();
    expect(r.warnings).toEqual([expect.stringMatching(/r\.rar: RAR is not supported/)]);
    expect(r.added.length).toBe(2);
  });

  it("explains a RAR failure on a 7-Zip build without RAR", async () => {
    const t = setup("keep", {}, ["r.rar"], { tools: { sevenZip: fakeTools.sevenZip, rar: fakeTools.sevenZip } });
    expect((await t.go()).warnings[0]).toMatch(/RAR is not supported by this 7-Zip build/);
  });

  it("propagates a run abort instead of turning it into a warning", async () => {
    const t = setup("keep", { "a.zip": media }, ["a.zip"], { run: async () => { throw new Error("aborted"); } });
    const ac = new AbortController();
    ac.abort();
    await expect(t.go(ac.signal)).rejects.toThrow("aborted");
  });

  it("never passes a password: only -p- and an argument array", async () => {
    const t = setup("keep", { "a.zip": media }, ["a.zip"]);
    await t.go();
    const extract = t.calls.find((c) => c.args[0] === "x")!;
    expect(extract.args).toEqual(["x", "-y", "-bd", expect.stringMatching(/^-o.*harvest-extract/), "-p-", "-spd", "--", t.paths[0]]);
  });
});
