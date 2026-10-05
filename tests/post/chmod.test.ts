import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JobConfig } from "../../src/domain.js";
import { createChmodStep, modeProblem } from "../../src/post/chmod.js";
import type { PostConfig } from "../../src/store/post-store.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const mode = (p: string): string => (statSync(p).mode & 0o7777).toString(8);

function setup(cfg: Partial<PostConfig>) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chmod-")));
  dirs.push(root);
  const step = createChmodStep({ postStore: { get: () => ({ extract: "off", chmodFile: null, chmodDir: null, ...cfg }) } });
  const run = (finalPaths: string[]) => step.run({ job: { id: 1, localPath: root } as JobConfig, runId: 1, signal: new AbortController().signal, unitKey: "u", finalPaths });
  return { root, run };
}

describe("chmod step", () => {
  it("applies file and directory modes below the local path only", async () => {
    const t = setup({ chmodFile: "640", chmodDir: "0750" });
    mkdirSync(path.join(t.root, "Pack/Sub"), { recursive: true });
    const f = path.join(t.root, "Pack/Sub/a.mkv");
    writeFileSync(f, "x");
    expect((await t.run([f])).warnings).toEqual([]);
    expect(mode(f)).toBe("640");
    expect(mode(path.join(t.root, "Pack"))).toBe("750");
    expect(mode(path.join(t.root, "Pack/Sub"))).toBe("750");
    expect(mode(t.root)).not.toBe("750");
  });

  it("does nothing without configured modes", async () => {
    const t = setup({});
    const f = path.join(t.root, "a");
    writeFileSync(f, "x", { mode: 0o600 });
    await t.run([f]);
    expect(mode(f)).toBe("600");
  });

  it("skips symlinks and does not follow them out of the local path", async () => {
    const t = setup({ chmodFile: "777", chmodDir: "777" });
    const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
    dirs.push(outside);
    writeFileSync(path.join(outside, "secret"), "x", { mode: 0o600 });
    symlinkSync(path.join(outside, "secret"), path.join(t.root, "lnk"));
    symlinkSync(outside, path.join(t.root, "dirlink"));
    await t.run([path.join(t.root, "lnk"), path.join(t.root, "dirlink/secret")]);
    expect(mode(path.join(outside, "secret"))).toBe("600");
    expect(mode(outside)).not.toBe("777");
  });

  it("ignores paths outside the local path with a warning and rejects invalid stored modes", async () => {
    const t = setup({ chmodFile: "644" });
    const stray = path.join(tmpdir(), "stray-file-not-ours");
    expect((await t.run([stray])).warnings[0]).toMatch(/outside the local path/);
    const bad = setup({ chmodFile: "9999" });
    expect((await bad.run([path.join(bad.root, "a")])).warnings[0]).toMatch(/invalid file mode/);
  });

  it("warns when a path is missing but keeps going", async () => {
    const t = setup({ chmodFile: "600" });
    const f = path.join(t.root, "real");
    writeFileSync(f, "x");
    expect((await t.run([path.join(t.root, "gone"), f])).warnings).toEqual([]);
    expect(mode(f)).toBe("600");
  });
});

describe("mode validation", () => {
  it.each([["file", "644"], ["file", "0600"], ["file", "777"], ["dir", "755"], ["dir", "0700"], ["dir", "770"]] as const)("accepts %s mode %s", (kind, v) => {
    expect(modeProblem(kind, v)).toBeNull();
  });
  it.each([["file", "4755"], ["file", "2644"], ["file", "1777"], ["file", "64"], ["file", "6444"], ["dir", "7755"], ["dir", "abc"], ["file", " 644"], ["file", "0o644"]] as const)("rejects %s mode %s (setuid/setgid/sticky or malformed)", (kind, v) => {
    expect(modeProblem(kind, v)).not.toBeNull();
  });
  it.each([["file", "444"], ["file", "040"], ["file", "0200"], ["dir", "644"], ["dir", "555"], ["dir", "0500"]] as const)("rejects %s mode %s without the owner bits Harvest needs", (kind, v) => {
    expect(modeProblem(kind, v)).toMatch(/owner/);
  });
  it("the step refuses a stored setuid or owner-less mode instead of applying it", async () => {
    const t = setup({ chmodFile: "4755" });
    expect((await t.run([path.join(t.root, "a")])).warnings[0]).toMatch(/invalid file mode/);
    const d = setup({ chmodDir: "644" });
    expect((await d.run([path.join(d.root, "a")])).warnings[0]).toMatch(/invalid dir mode/);
  });
});
