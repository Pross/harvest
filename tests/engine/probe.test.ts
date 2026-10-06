import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { HostConfig } from "../../src/domain.js";
import { candidates, probeHost } from "../../src/engine/probe.js";
import { recommendConnections } from "../../src/engine/probe-checks.js";
import type { EngineSession, RemoteEntry, TransferEngine } from "../../src/engine/types.js";
import { makeData } from "../helpers/fake-session.js";

const host = (over: Partial<HostConfig> = {}): HostConfig => ({
  id: 1, name: "box", protocol: "ftp", host: "seedbox.example", port: 21, username: "u", authKind: "password",
  secret: { password: "hunter2" }, tlsAcceptSelfSigned: false, hostKeys: null, maxConnections: 4, ...over,
});
const file = (path: string, size = 100_000, mtimeMs: number | null = 1000): RemoteEntry => ({ path, size, mtimeMs, isDir: false });
const dir = (path: string): RemoteEntry => ({ path, size: 0, mtimeMs: 1000, isDir: true });

type Server = {
  /** Which connection methods the server accepts. */
  works?: (cfg: HostConfig) => boolean;
  root?: RemoteEntry[];
  sub?: Record<string, RemoteEntry[]>;
  data?: Buffer;
  /** Simultaneous data connections the server grants. */
  maxLogins?: number;
  /** open() always fails. */
  openFails?: boolean;
  /** Ranged reads from a non-zero offset return the wrong bytes. */
  brokenResume?: boolean;
};

function fake(o: Server = {}) {
  const tested: HostConfig[] = [];
  let held = 0;
  const data = o.data ?? makeData(100_000, 3);
  const session = (): EngineSession => ({
    async list(root) { return root === "" ? (o.root ?? []) : (o.sub?.[root] ?? []); },
    async stat() { return null; },
    openRange(_p, offset, count) {
      if (held >= (o.maxLogins ?? 99)) return new Readable({ read() { this.destroy(new Error("421 too many connections")); } });
      held++;
      const body = data.subarray(offset, offset + count);
      const stream = Readable.from([o.brokenResume && offset > 0 ? Buffer.alloc(body.length, 7) : body]);
      stream.once("close", () => { held--; });
      return stream;
    },
    async remove() {}, async move() {},
    async close() {},
  });
  const engine: TransferEngine = {
    id: "rclone", capabilities: { hash: false, parallelRanges: true },
    async testConnection(cfg) {
      tested.push(cfg);
      if (o.works && !o.works(cfg)) throw new Error("connection refused: hunter2");
      return { ok: true, rootListing: o.root ?? [] };
    },
    async open() {
      if (o.openFails) throw new Error("open failed");
      return session();
    },
  };
  return { engine, tested };
}
const explain = (e: unknown): string => (e instanceof Error ? e.message.replace("hunter2", "***") : "error");
const run = (s: Server, h: HostConfig = host()) => { const f = fake(s); return probeHost(f.engine, h, explain).then((r) => ({ r, ...f })); };

describe("connection ladder", () => {
  it("takes verified explicit TLS first and stops there", async () => {
    const { r, tested } = await run({ root: [file("a.iso")] });
    expect(tested).toHaveLength(1);
    expect(r.recommend).toMatchObject({ protocol: "ftps_explicit", port: 21, tlsAcceptSelfSigned: false });
    expect(r.secure).toBe(true);
    expect(r.steps.map((s) => s.ok)).toEqual([true]);
  });

  it("falls back to an unverified certificate and says so", async () => {
    const { r } = await run({ works: (c) => c.tlsAcceptSelfSigned && c.protocol === "ftps_explicit", root: [file("a.iso")] });
    expect(r.recommend).toMatchObject({ protocol: "ftps_explicit", tlsAcceptSelfSigned: true });
    expect(r.steps.map((s) => s.ok)).toEqual([false, true]);
    expect(r.notes.join(" ")).toMatch(/certificate could not be verified/);
  });

  it("uses plain FTP only as the last resort for an FTP host, and warns", async () => {
    const { r } = await run({ works: (c) => c.protocol === "ftp", root: [file("a.iso")] });
    expect(r.recommend).toMatchObject({ protocol: "ftp", tlsAcceptSelfSigned: false });
    expect(r.secure).toBe(false);
    expect(r.steps.map((s) => s.ok)).toEqual([false, false, true]);
    expect(r.notes.join(" ")).toMatch(/unencrypted/);
  });

  it("never downgrades a host that chose TLS", async () => {
    const { r, tested } = await run({ works: (c) => c.protocol === "ftp" }, host({ protocol: "ftps_explicit" }));
    expect(r.ok).toBe(false);
    expect(r.recommend).toBeNull();
    expect(tested.every((c) => c.protocol === "ftps_explicit")).toBe(true);
  });

  it("tries implicit TLS only for hosts that chose it, on their own port", async () => {
    expect(candidates(host({ protocol: "ftps_implicit", port: 9900 })).map((c) => [c.protocol, c.port])).toEqual([["ftps_implicit", 9900], ["ftps_implicit", 9900]]);
    expect(candidates(host()).some((c) => c.protocol === "ftps_implicit")).toBe(false);
  });

  it("leaves SFTP alone without connecting", async () => {
    const { r, tested } = await run({}, host({ protocol: "sftp", port: 22 }));
    expect(r.ok).toBe(false);
    expect(tested).toEqual([]);
    expect(r.notes[0]).toMatch(/FTP and FTPS/);
  });

  it("reports every failure through explain(), so credentials never leak", async () => {
    const { r } = await run({ works: () => false });
    expect(r.ok).toBe(false);
    expect(r.steps).toHaveLength(3);
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });

  it("does not move to a less secure method when a later check fails", async () => {
    const { r, tested } = await run({ openFails: true, root: [file("a.iso")] });
    expect(tested).toHaveLength(1);
    expect(r.recommend).toMatchObject({ protocol: "ftps_explicit", maxConnections: 4 });
    expect(r.resume).toBe("untested");
    expect(r.connections).toBeNull();
  });
});

describe("what the probe learns about the server", () => {
  it("detects modification times", async () => {
    expect((await run({ root: [file("a.iso", 100_000, 5)] })).r).toMatchObject({ mtime: true, trustMtime: true });
    const none = (await run({ root: [file("a.iso", 100_000, null)] })).r;
    expect(none).toMatchObject({ mtime: false, trustMtime: false });
    expect(none.notes.join(" ")).toMatch(/no modification times/);
    expect((await run({ root: [] })).r.mtime).toBeNull();
  });

  it("confirms resume with a ranged read, also for a file one folder down", async () => {
    expect((await run({ root: [file("a.iso")] })).r.resume).toBe("ok");
    expect((await run({ root: [dir("Show")], sub: { "/Show": [file("e1.mkv")] } })).r.resume).toBe("ok");
  });

  it("reports a broken resume, and an untested one when there is no file to read", async () => {
    const broken = (await run({ root: [file("a.iso")], brokenResume: true })).r;
    expect(broken.resume).toBe("failed");
    expect(broken.notes.join(" ")).toMatch(/start over/);
    expect((await run({ root: [file("tiny.txt", 100)] })).r.resume).toBe("untested");
    expect((await run({ root: [] })).r.resume).toBe("untested");
  });

  it("measures simultaneous logins by holding them open, and recommends a cap with headroom", async () => {
    const root = [file("big.iso", 3_000_000)];
    expect((await run({ root, maxLogins: 99 })).r).toMatchObject({ connections: 6, recommend: { maxConnections: 4 } });
    expect((await run({ root, maxLogins: 3 })).r).toMatchObject({ connections: 3, recommend: { maxConnections: 3 } });
    const one = (await run({ root, maxLogins: 1 })).r;
    expect(one).toMatchObject({ connections: 1, recommend: { maxConnections: 1 } });
    expect(one.notes.join(" ")).toMatch(/only one login/);
  });

  it("does not guess the limit without a file big enough to hold logins, and keeps the current cap", async () => {
    const r = (await run({ root: [file("small.iso", 100_000)] }, host({ maxConnections: 2 }))).r;
    expect(r.connections).toBeNull();
    expect(r.recommend?.maxConnections).toBe(2);
    expect(r.notes.join(" ")).toMatch(/not measured/);
  });

  it.each([[1, 1], [2, 2], [3, 3], [4, 3], [5, 4], [6, 4], [0, 1]])("recommendConnections(%i) = %i", (n, want) => {
    expect(recommendConnections(n)).toBe(want);
  });
});
