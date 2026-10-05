import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileSha, makeRig, type Target } from "../support/rig.js";
import { integrationEnabled, useStack } from "../support/stack.js";

const TARGETS: Target[] = ["ftp", "sftp"];

/** Every file below `dir` (relative, posix), skipping Harvest's staging dir. */
function walk(dir: string, rel = ""): string[] {
  return readdirSync(path.join(dir, rel)).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    if (n === ".harvest-staging") return [];
    return statSync(path.join(dir, r)).isDirectory() ? walk(dir, r) : [r];
  });
}

/** Names that are legal on the server and safe to materialize locally. */
const SAFE: Record<string, number> = {
  "sp ace/file name.txt": 1100,
  "uni/café ☃ 日本.txt": 1200,
  "hash#and%percent/50%25 #1.txt": 1300,
  "quo'te/it's \"q\".txt": 1400,
  "dots/..hidden": 1500,
  "dots/a..b": 1600,
  "dots/...": 1700,
  "-leading-dash.txt": 1800,
  "%2e%2e/%2e%2e%2fevil.txt": 1900,
};
/** Names the planner must reject (never written anywhere). */
const UNSAFE: Record<string, number> = {
  "back\\slash.txt": 2100,
  "dir\\..\\..\\escape.txt": 2200,
  ".harvest-staging/inner.txt": 2300,
};

describe.skipIf(!integrationEnabled())("hostile remote names", () => {
  useStack();

  describe.each(TARGETS)("%s", (target) => {
    it("syncs odd but safe names, skips unsafe ones, and never writes outside the job local path", async () => {
      const rig = makeRig({ target });
      const seeded = await rig.seed({ ...SAFE, ...UNSAFE });
      const res = await rig.settled();
      const act = rig.activity().map((a) => `${a.severity} ${a.summary}`);
      expect(["succeeded", "partial"], act.join("\n")).toContain(res.state);

      const expected = Object.keys(SAFE).map((n) => n.normalize("NFC")).sort();
      expect(walk(rig.local).map((n) => n.normalize("NFC")).sort(), act.join("\n")).toEqual(expected);
      for (const [rel, f] of Object.entries(SAFE)) {
        expect(await fileSha(rig.localPath(rel.normalize("NFC"))), rel).toBe(seeded.get(rel)!.sha256);
        expect(f).toBeGreaterThan(0);
      }
      expect(res.row.filesFailed).toBe(0);
      expect(rig.ledger().map((r) => r.remotePath).sort()).toEqual(expected);
      for (const bad of Object.keys(UNSAFE)) expect(rig.ledger().some((r) => r.remotePath === bad)).toBe(false);

      // nothing escaped: the temp root next to the local dir holds only `local` and rclone's own scratch dir
      const root = path.dirname(rig.local);
      expect(readdirSync(root).sort()).toEqual(["local", "rclone"]);
      expect(readdirSync(rig.local).filter((n) => n.startsWith("..") && n !== "..hidden")).toEqual([]);
    });
  });
});
