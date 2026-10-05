import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthError, PermanentError, TransientNetwork } from "../../src/errors.js";
import { createRcloneEngine, commonFlags } from "../../src/engine/rclone-engine.js";
import { clearObscureCache } from "../../src/engine/rclone-remote.js";
import type { EngineSession } from "../../src/engine/types.js";
import { FAKE_RCLONE, callsTo, calls, host, makeTmp, scenario } from "./helpers.js";

let tmp: string;
const flags = commonFlags(15000);
const engine = (extra = {}) => createRcloneEngine({ rclone: FAKE_RCLONE, tmpDir: tmp, connectTimeoutMs: 15000, ...extra });
const readAll = async (s: AsyncIterable<Buffer>) => {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c);
  return Buffer.concat(chunks);
};
beforeEach(() => { tmp = makeTmp(); clearObscureCache(); process.env.APP_SECRET = "parent-app-secret"; });

async function session(): Promise<EngineSession> { return engine().open(host()); }
const PINNED = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKr6R2pxi4+vrVW3VjbAIRQAY0/DUKXPYhtH7OaERU/U";

describe("engine basics", () => {
  it("exposes id, capabilities, and no download method", async () => {
    const e = engine();
    expect(e.id).toBe("rclone");
    expect(e.capabilities).toEqual({ hash: false, parallelRanges: true });
    expect("download" in (await session())).toBe(false);
  });

  it("documents flags: quiet, single retries, timeouts", () => {
    expect(flags).toEqual(["-q", "--retries", "1", "--low-level-retries", "1", "--contimeout", "15s", "--timeout", "60s"]);
  });
});

describe("list", () => {
  const json = JSON.stringify([
    { Path: "a/b.mkv", Name: "b.mkv", Size: 42, ModTime: "2026-10-01T12:00:00.5Z", IsDir: false },
    { Path: "a", Name: "a", Size: -1, ModTime: "2026-10-01T12:00:00Z", IsDir: true },
    { Path: "z.txt", Name: "z.txt", Size: 7, ModTime: "0001-01-01T00:00:00Z", IsDir: false },
    { Path: "n.txt", Name: "n.txt", Size: 1, IsDir: false },
  ]);

  it("runs lsjson -R and parses entries incl. null mtime and directories", async () => {
    scenario(tmp, "lsjson", { out: json });
    const list = await (await session()).list("incoming", { recurse: true });
    expect(callsTo(tmp, "lsjson")[0]!.argv).toEqual(["lsjson", ...flags, "-R", "--no-mimetype", "H1:incoming"]);
    expect(list).toEqual([
      { path: "a/b.mkv", size: 42, mtimeMs: Date.parse("2026-10-01T12:00:00.5Z"), isDir: false },
      { path: "a", size: 0, mtimeMs: Date.parse("2026-10-01T12:00:00Z"), isDir: true },
      { path: "z.txt", size: 7, mtimeMs: null, isDir: false },
      { path: "n.txt", size: 1, mtimeMs: null, isDir: false },
    ]);
  });

  it("non-recursive list omits -R", async () => {
    scenario(tmp, "lsjson", { out: "[]" });
    await (await session()).list("", { recurse: false });
    expect(callsTo(tmp, "lsjson")[0]!.argv).toEqual(["lsjson", ...flags, "--no-mimetype", "H1:"]);
  });

  it("never returns a partial list when rclone exits non-zero", async () => {
    scenario(tmp, "lsjson", { out: json.slice(0, 80), err: "ERROR : dir: error reading: connection reset by peer", code: 1 });
    await expect((await session()).list("x", { recurse: true })).rejects.toBeInstanceOf(TransientNetwork);
  });

  it("throws PermanentError on unparseable output and on missing directory", async () => {
    scenario(tmp, "lsjson", { out: "[{", code: 0 });
    await expect((await session()).list("x", { recurse: true })).rejects.toBeInstanceOf(PermanentError);
    scenario(tmp, "lsjson", { out: "", err: "directory not found", code: 3 });
    await expect((await session()).list("x", { recurse: true })).rejects.toBeInstanceOf(PermanentError);
  });

  it("maps auth failures", async () => {
    scenario(tmp, "lsjson", { err: "530 Login incorrect", code: 1 });
    await expect((await session()).list("", { recurse: false })).rejects.toBeInstanceOf(AuthError);
  });
});

describe("stat, remove, move, hash", () => {
  it("stat uses lsjson --stat and returns the entry", async () => {
    scenario(tmp, "lsjson", { out: JSON.stringify({ Path: "f.bin", Name: "f.bin", Size: 9, ModTime: "2026-10-01T00:00:00Z", IsDir: false }) });
    const e = await (await session()).stat("d/f.bin");
    expect(callsTo(tmp, "lsjson")[0]!.argv).toEqual(["lsjson", ...flags, "--stat", "--no-mimetype", "H1:d/f.bin"]);
    expect(e).toEqual({ path: "d/f.bin", size: 9, mtimeMs: Date.parse("2026-10-01T00:00:00Z"), isDir: false });
  });

  it("stat returns null when not found, throws on other errors", async () => {
    scenario(tmp, "lsjson", { err: "error in stat: object not found", code: 4 });
    expect(await (await session()).stat("nope")).toBeNull();
    scenario(tmp, "lsjson", { err: "dial tcp: connection refused", code: 1 });
    await expect((await session()).stat("nope")).rejects.toBeInstanceOf(TransientNetwork);
  });

  it("stat does not treat a DNS failure as not found", async () => {
    scenario(tmp, "lsjson", { err: "NewFs: couldn't connect: host not found", code: 1 });
    await expect((await session()).stat("nope")).rejects.toBeInstanceOf(TransientNetwork);
  });

  it("list throws PermanentError for a file entry without a valid Size", async () => {
    scenario(tmp, "lsjson", { out: JSON.stringify([{ Path: "a/nosize.bin", IsDir: false }]) });
    await expect((await session()).list("", { recurse: true })).rejects.toThrow(/a\/nosize\.bin/);
    scenario(tmp, "lsjson", { out: JSON.stringify([{ Path: "neg.bin", Size: -1, IsDir: false }]) });
    await expect((await session()).list("", { recurse: true })).rejects.toBeInstanceOf(PermanentError);
  });

  it("remove and move use deletefile and moveto", async () => {
    const s = await session();
    await s.remove("a/b");
    await s.move("a/b", "done/a/b");
    expect(callsTo(tmp, "deletefile")[0]!.argv).toEqual(["deletefile", ...flags, "H1:a/b"]);
    expect(callsTo(tmp, "moveto")[0]!.argv).toEqual(["moveto", ...flags, "H1:a/b", "H1:done/a/b"]);
    scenario(tmp, "deletefile", { err: "permission denied", code: 1 });
    await expect(s.remove("x")).rejects.toBeInstanceOf(PermanentError);
  });

  it("hash returns the digest, or null when unsupported", async () => {
    const s = await session();
    scenario(tmp, "hashsum", { out: "D41D8CD98F00B204E9800998ECF8427E  f.bin\n" });
    expect(await s.hash!("f.bin", "md5")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(callsTo(tmp, "hashsum")[0]!.argv).toEqual(["hashsum", ...flags, "md5", "H1:f.bin"]);
    scenario(tmp, "hashsum", { out: "                    UNSUPPORTED  f.bin\n" });
    expect(await s.hash!("f.bin", "md5")).toBeNull();
    scenario(tmp, "hashsum", { out: "", err: "hash type not supported", code: 1 });
    expect(await s.hash!("f.bin", "sha1")).toBeNull();
  });
});

describe("openRange", () => {
  it("streams cat --offset --count bytes", async () => {
    scenario(tmp, "cat", { out: Buffer.from([1, 2, 3, 4]) });
    const s = await session();
    const data = await readAll(s.openRange("f.bin", 100, 4, new AbortController().signal));
    expect([...data]).toEqual([1, 2, 3, 4]);
    expect(callsTo(tmp, "cat")[0]!.argv).toEqual(["cat", ...flags, "--buffer-size", "0", "--offset", "100", "--count", "4", "H1:f.bin"]);
  });

  it("errors with the mapped typed error on non-zero exit", async () => {
    scenario(tmp, "cat", { out: "ab", err: "failed to send packet payload: EOF", code: 1 });
    const s = await session();
    await expect(readAll(s.openRange("f", 0, 10, new AbortController().signal))).rejects.toBeInstanceOf(TransientNetwork);
  });

  it("abort kills the child process", async () => {
    scenario(tmp, "cat", { out: "partial", sleep: 30 });
    const s = await session();
    const ac = new AbortController();
    const stream = s.openRange("f", 0, 10, ac.signal);
    const done = readAll(stream).catch((e: Error) => e);
    for (let i = 0; i < 100 && callsTo(tmp, "cat").length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const pid = callsTo(tmp, "cat")[0]!.pid;
    ac.abort();
    expect(((await done) as Error).name).toBe("AbortError");
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("destroying the stream kills the child", async () => {
    scenario(tmp, "cat", { out: "partial", sleep: 30 });
    const stream = (await session()).openRange("f", 0, 10, new AbortController().signal);
    for (let i = 0; i < 100 && callsTo(tmp, "cat").length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const pid = callsTo(tmp, "cat")[0]!.pid;
    stream.destroy();
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("secrets and environment", () => {
  it("keeps secrets out of argv and the parent env out of the child", async () => {
    scenario(tmp, "lsjson", { out: "[]" });
    const s = await engine().open(host({ id: 7 }));
    await s.list("", { recurse: false });
    const all = calls(tmp);
    expect(all.length).toBeGreaterThan(1);
    const allowed = /^(PATH|HOME|XDG_CACHE_HOME|RCLONE_CONFIG|RCLONE_CONFIG_H7_[A-Z_]+|PWD|SHLVL|_|OLDPWD)$/;
    for (const c of all) {
      expect(c.argv.join(" ")).not.toContain("hunter2");
      expect(c.env.APP_SECRET).toBeUndefined();
      for (const [k, v] of Object.entries(c.env)) {
        expect(k).toMatch(allowed);
        if (k !== "RCLONE_CONFIG_H7_PASS") expect(v).not.toContain("hunter2");
      }
    }
    const ls = callsTo(tmp, "lsjson")[0]!;
    expect(ls.env.RCLONE_CONFIG_H7_PASS).toBe("obscured:hunter2-secret");
    expect(ls.env.HOME).toBe(tmp);
    expect(ls.cfgExisted).toBe(true);
  });

  it("deletes the per-spawn config file afterwards", async () => {
    scenario(tmp, "lsjson", { out: "[]" });
    await (await session()).list("", { recurse: false });
    expect(readdirSync(tmp).filter((f) => f.endsWith(".conf"))).toEqual([]);
    expect(existsSync(tmp)).toBe(true);
  });
});

describe("testConnection", () => {
  it("lists root for ftp without scanning host keys", async () => {
    scenario(tmp, "lsjson", { out: JSON.stringify([{ Path: "x", Size: 1, ModTime: "2026-10-01T00:00:00Z", IsDir: false }]) });
    const r = await engine({ keyScanExec: async () => { throw new Error("must not scan"); } }).testConnection(host());
    expect(r.ok).toBe(true);
    expect(r.rootListing).toHaveLength(1);
    expect(r.hostKeys).toBeUndefined();
  });

  it("scans host keys for sftp", async () => {
    scenario(tmp, "lsjson", { out: "[]" });
    const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKr6R2pxi4+vrVW3VjbAIRQAY0/DUKXPYhtH7OaERU/U";
    const r = await engine({ keyScanExec: async () => `# c\nh ${key}\n` }).testConnection(host({ protocol: "sftp", port: 22 }));
    expect(r.hostKeys?.[0]?.line).toBe(key);
    expect(callsTo(tmp, "lsjson")[0]!.argv).toContain("H1:");
  });

  it("open() refuses an unpinned sftp host, testConnection may connect unpinned", async () => {
    scenario(tmp, "lsjson", { out: "[]" });
    await expect(engine().open(host({ protocol: "sftp", port: 22 }))).rejects.toThrow(/host key not pinned/);
    await engine({ keyScanExec: async () => `h ${PINNED}\n` }).testConnection(host({ protocol: "sftp", port: 22 }));
    expect(callsTo(tmp, "lsjson")[0]!.env.RCLONE_CONFIG_H1_HOST_KEYS).toBeUndefined();
    const pinned = await engine().open(host({ protocol: "sftp", port: 22, hostKeys: PINNED }));
    await pinned.list("", { recurse: false });
    expect(callsTo(tmp, "lsjson").at(-1)!.env.RCLONE_CONFIG_H1_HOST_KEYS).toBe(PINNED);
  });

  it("propagates list failure", async () => {
    scenario(tmp, "lsjson", { err: "530 Login incorrect", code: 1 });
    await expect(engine().testConnection(host())).rejects.toBeInstanceOf(AuthError);
  });
});

describe("process hygiene", () => {
  it("escalates to SIGKILL when a child ignores SIGTERM", async () => {
    const script = join(tmp, "stubborn.sh");
    writeFileSync(script, "#!/bin/bash\ntrap '' TERM\necho $$ > \"$HOME/pid\"\nwhile true; do sleep 0.05; done\n", { mode: 0o755 });
    const e = createRcloneEngine({ rclone: script, tmpDir: tmp, connectTimeoutMs: 15000, killGraceMs: 100 });
    const s = await e.open(host({ secret: { password: "" } }));
    const ac = new AbortController();
    const stream = s.openRange("f", 0, 10, ac.signal);
    stream.on("error", () => {});
    await new Promise((r) => setTimeout(r, 300));
    const pid = Number(readFileSync(join(tmp, "pid"), "utf8"));
    ac.abort();
    await new Promise((r) => setTimeout(r, 600));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("turns working-file failures into PermanentError and never throws synchronously", async () => {
    const blocker = join(tmp, "blocked");
    writeFileSync(blocker, "x");
    const e = createRcloneEngine({ rclone: FAKE_RCLONE, tmpDir: join(blocker, "sub"), connectTimeoutMs: 15000 });
    const s = await e.open(host({ secret: { password: "" } }));
    await expect(s.list("", { recurse: false })).rejects.toBeInstanceOf(PermanentError);
    const stream = s.openRange("f", 0, 1, new AbortController().signal);
    await expect(readAll(stream)).rejects.toBeInstanceOf(PermanentError);
  });

  it("deletes stale rclone-*.conf files older than an hour at engine creation", () => {
    const old = join(tmp, "rclone-old.conf");
    const fresh = join(tmp, "rclone-fresh.conf");
    writeFileSync(old, ""); writeFileSync(fresh, "");
    const past = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(old, past, past);
    engine();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
