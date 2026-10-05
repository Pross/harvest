import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PermanentError } from "../../src/errors.js";
import { assertContained, assertRealContained, remoteAbsOf, ensureStaging, finalPathFor, remoteAbsFor, resolvePaths, stagingPathFor, stagingRoot } from "../../src/run/paths.js";

const dirs: string[] = [];
const tmp = (): string => (dirs.push(mkdtempSync(path.join(tmpdir(), "paths-"))), dirs.at(-1)!);
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("run paths", () => {
  it("builds staging, final and remote paths", () => {
    expect(stagingRoot("/data/x", 7)).toBe("/data/x/.harvest-staging/7");
    expect(stagingPathFor("/data/x", 7, "Show/e1.mkv")).toBe("/data/x/.harvest-staging/7/Show/e1.mkv");
    expect(finalPathFor("/data/x", "Show/e1.mkv")).toBe("/data/x/Show/e1.mkv");
    expect(remoteAbsFor("/seed/files/", "Show/e1.mkv")).toBe("/seed/files/Show/e1.mkv");
  });

  it("assertContained rejects escapes and the root itself", () => {
    expect(() => assertContained("/a/b", "/a/b/c")).not.toThrow();
    expect(() => assertContained("/a/b", "/a/b/../c")).toThrow(PermanentError);
    expect(() => assertContained("/a/b", "/a/bc/x")).toThrow(PermanentError);
    expect(() => assertContained("/a/b", "/a/b")).toThrow(PermanentError);
  });

  it("resolvePaths rejects hostile relative paths at execution time", () => {
    expect(() => resolvePaths("/data/x", 1, "../../etc/passwd")).toThrow(/escapes/);
    expect(resolvePaths("/data/x", 1, "ok/f")).toEqual({ staging: "/data/x/.harvest-staging/1/ok/f", final: "/data/x/ok/f" });
  });

  it("ensureStaging creates the root on the same device by default", async () => {
    const dir = tmp();
    expect(await ensureStaging(dir, 3)).toBe(path.join(dir, ".harvest-staging", "3"));
  });

  it("ensureStaging refuses a different device", async () => {
    await expect(ensureStaging(tmp(), 3, async () => false)).rejects.toThrow(/different filesystem/);
  });

  it("remoteAbsOf prefers the server's own spelling", () => {
    expect(remoteAbsOf("/r", { remotePath: "Caf\u00e9/a" })).toBe("/r/Caf\u00e9/a");
    expect(remoteAbsOf("/r", { remotePath: "Caf\u00e9/a", remoteRaw: "Cafe\u0301/a" })).toBe("/r/Cafe\u0301/a");
  });

  it("assertRealContained follows existing symlinks and refuses ones that leave the root", async () => {
    const root = tmp();
    const elsewhere = tmp();
    mkdirSync(path.join(root, "real"));
    symlinkSync(elsewhere, path.join(root, "Show"));
    symlinkSync(path.join(root, "real"), path.join(root, "inside"));
    symlinkSync(path.join(elsewhere, "missing"), path.join(root, "dangling"));
    await expect(assertRealContained(root, path.join(root, "Show", "a.bin"))).rejects.toThrow(/outside the local path/);
    await expect(assertRealContained(root, path.join(root, "Show", "deep", "x", "a.bin"))).rejects.toThrow(PermanentError);
    await expect(assertRealContained(root, path.join(root, "dangling", "a.bin"))).rejects.toThrow(/dangling symlink/);
    await expect(assertRealContained(root, path.join(root, "inside", "a.bin"))).resolves.toBeUndefined();
    await expect(assertRealContained(root, path.join(root, "new", "deeper", "a.bin"))).resolves.toBeUndefined();
    await expect(assertRealContained(root, path.join(root, "a.bin"))).resolves.toBeUndefined();
  });
});
