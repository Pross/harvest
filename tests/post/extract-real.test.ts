import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtractStep } from "../../src/post/extract.js";
import { findTools } from "../../src/post/extract-tools.js";
import type { JobConfig } from "../../src/domain.js";

const tools = findTools();
const FIX = path.resolve("tests/fixtures/archives");
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const BIG = sha(path.join(FIX, "expected-big.bin"));
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const unitDir = (): string => { const d = mkdtempSync(path.join(tmpdir(), "real-")); dirs.push(d); return d; };
const step = (mode: "keep" | "delete") => createExtractStep({ postStore: { get: () => ({ extract: mode, chmodFile: null, chmodDir: null }) }, tools });
const run = (mode: "keep" | "delete", dir: string, files: string[]) =>
  step(mode).run({ job: { id: 1 } as JobConfig, runId: 1, signal: new AbortController().signal, unitDir: dir, files: files.map((f) => path.join(dir, f)) });

describe.skipIf(!tools.sevenZip)("real 7-Zip", () => {
  it("extracts a zip and a 7z and deletes them in delete mode", async () => {
    const dir = unitDir();
    mkdirSync(path.join(dir, "src/Show"), { recursive: true });
    mkdirSync(path.join(dir, "src/Other"), { recursive: true });
    writeFileSync(path.join(dir, "src/Show/ep.mkv"), "episode".repeat(100));
    writeFileSync(path.join(dir, "src/Other/ep.mkv"), "other".repeat(100));
    const bin = tools.sevenZip!.bin;
    execFileSync(bin, ["a", "-tzip", "-bd", path.join(dir, "one.zip"), path.join(dir, "src/Show")], { stdio: "ignore" });
    execFileSync(bin, ["a", "-t7z", "-bd", path.join(dir, "two.7z"), path.join(dir, "src/Other")], { stdio: "ignore" });
    rmSync(path.join(dir, "src"), { recursive: true });
    const r = await run("delete", dir, ["one.zip", "two.7z"]);
    expect(r.warnings).toEqual([]);
    expect(r.removed.map((p) => path.basename(p)).sort()).toEqual(["one.zip", "two.7z"]);
    expect(r.added.map((p) => path.relative(dir, p)).sort()).toEqual(["Other/ep.mkv", "Show/ep.mkv"]);
  });

  it("opens only the archive named a?b.zip, not a1b.zip or a2b.zip (wildcards are off)", async () => {
    const dir = unitDir();
    const bin = tools.sevenZip!.bin;
    for (const n of ["a1b", "a2b", "a?b"]) {
      mkdirSync(path.join(dir, "s"), { recursive: true });
      writeFileSync(path.join(dir, "s", `${n.replace("?", "Q")}.txt`), n);
      execFileSync(bin, ["a", "-tzip", "-bd", path.join(dir, `${n}.zip`), path.join(dir, "s", `${n.replace("?", "Q")}.txt`)], { stdio: "ignore" });
      rmSync(path.join(dir, "s"), { recursive: true });
    }
    const r = await run("keep", dir, ["a?b.zip"]);
    expect(r.warnings).toEqual([]);
    expect(r.added.map((p) => path.basename(p))).toEqual(["aQb.txt"]);
  });

  it("rejects a zip holding a symlink without extracting anything", async () => {
    const dir = unitDir();
    const src = path.join(dir, "src");
    mkdirSync(src);
    execFileSync("ln", ["-s", "/etc/hosts", path.join(src, "lnk")]);
    writeFileSync(path.join(src, "f.txt"), "x");
    execFileSync(tools.sevenZip!.bin, ["a", "-tzip", "-snl", "-bd", path.join(dir, "l.zip"), path.join(src, "lnk"), path.join(src, "f.txt")], { stdio: "ignore" });
    rmSync(src, { recursive: true });
    const r = await run("delete", dir, ["l.zip"]);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.warnings[0]).toMatch(/link/);
    expect(existsSync(path.join(dir, "l.zip"))).toBe(true);
  });
});

describe.skipIf(!tools.rar || tools.rar.name !== "unar")("real RAR via unar", () => {
  it("extracts a RAR5 archive", async () => {
    const dir = unitDir();
    cpSync(path.join(FIX, "single5.rar"), path.join(dir, "single5.rar"));
    const r = await run("keep", dir, ["single5.rar"]);
    expect(r.warnings).toEqual([]);
    expect(sha(path.join(dir, "big.bin"))).toBe(BIG);
    expect(readFileSync(path.join(dir, "b.txt"), "utf8")).toBe("hello rar\n");
  });

  it("extracts a multi-volume RAR5 set from the first part and reports all parts removed", async () => {
    const dir = unitDir();
    const parts = ["multi5.part1.rar", "multi5.part2.rar", "multi5.part3.rar"];
    for (const p of parts) cpSync(path.join(FIX, p), path.join(dir, p));
    const r = await run("delete", dir, parts);
    expect(r.warnings).toEqual([]);
    expect(r.removed.map((p) => path.basename(p)).sort()).toEqual(parts);
    expect(sha(path.join(dir, "big.bin"))).toBe(BIG);
  });

  it("warns for a multi-volume set with a missing volume and keeps the files", async () => {
    const dir = unitDir();
    cpSync(path.join(FIX, "multi5.part1.rar"), path.join(dir, "multi5.part1.rar"));
    cpSync(path.join(FIX, "multi5.part3.rar"), path.join(dir, "multi5.part3.rar"));
    const r = await run("delete", dir, ["multi5.part1.rar", "multi5.part3.rar"]);
    expect(r.removed).toEqual([]);
    expect(r.warnings.length).toBe(1);
  });
});
