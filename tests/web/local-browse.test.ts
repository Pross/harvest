import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../../src/config.js";
import { listLocal, validateLocalPath } from "../../src/web/local-browse.js";

let base: string;
let root: string;
let outside: string;
let cfgDir: string;
let config: Config;

const cfgFor = (roots: string[], configDir = cfgDir): Config => loadConfig({ NODE_ENV: "test", BROWSE_ROOTS: roots.join(","), CONFIG_DIR: configDir });
const invalid = async (p: string, c = config): Promise<string> => {
  const r = await validateLocalPath(p, c);
  return r.ok ? "OK" : r.error;
};

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harvest-lb-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  cfgDir = path.join(base, "config");
  for (const d of [root, outside, cfgDir, path.join(root, "movies"), path.join(root, "tv", "season1"), path.join(outside, "secret")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, "file.txt"), "x");
  fs.symlinkSync(outside, path.join(root, "escape"));
  fs.symlinkSync(path.join(root, "movies"), path.join(root, "inner-link"));
  fs.symlinkSync(path.join(base, "nowhere"), path.join(root, "dangling"));
  config = cfgFor([root]);
});

afterAll(() => {
  fs.chmodSync(path.join(root, "movies"), 0o755);
  fs.rmSync(base, { recursive: true, force: true });
});

describe("validateLocalPath", () => {
  it("accepts a directory inside a root and returns its realpath", async () => {
    expect(await validateLocalPath(path.join(root, "tv"), config)).toEqual({ ok: true, path: path.join(root, "tv") });
  });

  it("accepts the root itself", async () => {
    expect(await validateLocalPath(root, config)).toEqual({ ok: true, path: root });
  });

  it("resolves a symlink that stays inside the root to its target", async () => {
    expect(await validateLocalPath(path.join(root, "inner-link"), config)).toEqual({ ok: true, path: path.join(root, "movies") });
  });

  it("rejects empty, relative and NUL paths", async () => {
    expect(await invalid("")).toContain("required");
    expect(await invalid("   ")).toContain("required");
    expect(await invalid("movies")).toContain("absolute");
    expect(await invalid(`${root}/mov\0ies`)).toContain("invalid characters");
  });

  it("rejects any .. segment, even when it would resolve inside the root", async () => {
    expect(await invalid(`${root}/tv/../movies`)).toContain("..");
    expect(await invalid(`${root}/../outside`)).toContain("..");
    expect(await invalid("/../etc")).toContain("..");
  });

  it("rejects paths that do not exist", async () => {
    expect(await invalid(path.join(root, "nope"))).toContain("does not exist");
    expect(await invalid(path.join(root, "dangling"))).toContain("does not exist");
  });

  it("rejects paths outside every root", async () => {
    expect(await invalid(outside)).toContain("inside one of the allowed folders");
    expect(await invalid(base)).toContain("inside one of the allowed folders");
    expect(await invalid("/")).toContain("inside one of the allowed folders");
  });

  it("rejects a symlink that escapes the root", async () => {
    expect(await invalid(path.join(root, "escape"))).toContain("inside one of the allowed folders");
    expect(await invalid(path.join(root, "escape", "secret"))).toContain("inside one of the allowed folders");
  });

  it("rejects the config directory, anything inside it and anything containing it", async () => {
    const c = cfgFor([base]);
    expect(await invalid(cfgDir, c)).toContain("config directory");
    fs.mkdirSync(path.join(cfgDir, "db"), { recursive: true });
    expect(await invalid(path.join(cfgDir, "db"), c)).toContain("config directory");
    expect(await invalid(base, c)).toContain("config directory");
    expect(await invalid(root, c)).toBe("OK");
  });

  it("detects the config directory through a symlink", async () => {
    const link = path.join(root, "cfg-link");
    fs.symlinkSync(cfgDir, link);
    const c = cfgFor([base]);
    expect(await invalid(link, c)).toContain("config directory");
    fs.unlinkSync(link);
  });

  it("rejects files", async () => {
    expect(await invalid(path.join(root, "file.txt"))).toContain("not a directory");
  });

  it.skipIf(process.getuid?.() === 0)("rejects directories Harvest cannot write to", async () => {
    fs.chmodSync(path.join(root, "movies"), 0o500);
    expect(await invalid(path.join(root, "movies"))).toContain("not writable");
    fs.chmodSync(path.join(root, "movies"), 0o755);
  });

  it("supports several roots and ignores roots that are not mounted", async () => {
    const c = cfgFor([path.join(base, "missing"), root, outside]);
    expect(await invalid(path.join(outside, "secret"), c)).toBe("OK");
    expect(await invalid(path.join(root, "tv"), c)).toBe("OK");
    expect(await invalid(base, c)).toContain("inside one of the allowed folders");
  });

  it("allows nothing when no root exists", async () => {
    expect(await invalid(root, cfgFor([path.join(base, "missing")]))).toContain("inside one of the allowed folders");
  });
});

describe("listLocal", () => {
  it("lists the roots with free space when no path is given", async () => {
    const l = await listLocal(undefined, cfgFor([root, outside]));
    expect(l.ok && l.kind === "roots" ? l.roots.map((r) => r.path) : []).toEqual([root, outside]);
    expect(l.ok && l.kind === "roots" ? l.roots[0]?.free : "").toMatch(/\d/);
    expect((await listLocal("  ", config)).ok).toBe(true);
  });

  it("lists directories only, sorted, never files", async () => {
    const l = await listLocal(root, config);
    expect(l.ok && l.kind === "dir" ? l.dirs.map((d) => d.name) : []).toEqual(["inner-link", "movies", "tv"]);
  });

  it("drops symlinks that leave the root or dangle and resolves inner ones", async () => {
    const l = await listLocal(root, config);
    if (!l.ok || l.kind !== "dir") throw new Error("expected dir");
    expect(l.dirs.map((d) => d.name)).not.toContain("escape");
    expect(l.dirs.map((d) => d.name)).not.toContain("dangling");
    expect(l.dirs.find((d) => d.name === "inner-link")?.path).toBe(path.join(root, "movies"));
  });

  it("refuses to list through an escaping symlink, outside paths and .. tricks", async () => {
    for (const p of [path.join(root, "escape"), outside, `${root}/tv/../..`, "/", "relative"]) {
      const l = await listLocal(p, config);
      expect(l.ok).toBe(false);
    }
  });

  it("reports missing directories", async () => {
    const l = await listLocal(path.join(root, "nope"), config);
    expect(l).toEqual({ ok: false, error: "Local path does not exist" });
  });

  it("gives breadcrumbs, parent and free space", async () => {
    const top = await listLocal(root, config);
    const sub = await listLocal(path.join(root, "tv", "season1"), config);
    if (!top.ok || top.kind !== "dir" || !sub.ok || sub.kind !== "dir") throw new Error("expected dir");
    expect(top.parent).toBeNull();
    expect(sub.parent).toBe(path.join(root, "tv"));
    expect(sub.crumbs.map((c) => c.name)).toEqual([root, "tv", "season1"]);
    expect(sub.free).toMatch(/\d/);
  });
});
