import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform, Writable, type Readable } from "node:stream";
import { afterEach } from "vitest";
import { openDb } from "../../../src/db.js";
import type { JobConfig } from "../../../src/domain.js";
import { createRcloneEngine } from "../../../src/engine/rclone-engine.js";
import type { EngineSession, TransferEngine } from "../../../src/engine/types.js";
import { buildLogger } from "../../../src/logger.js";
import { createSlots } from "../../../src/run/connection-slots.js";
import { createEventBus } from "../../../src/run/events.js";
import { createExecutor, type ExecutorDeps } from "../../../src/run/executor.js";
import { createSpaceReservations } from "../../../src/run/space.js";
import { abortError, createThrottle, defaultSleep } from "../../../src/run/throttle.js";
import { createStores, type HostInput, type JobInput } from "../../../src/store/index.js";
import type { RunRow } from "../../../src/store/run-store.js";
import { exec as composeExec, type Service } from "../helpers/compose.js";
import { testHosts } from "../helpers/hosts.js";
import { REMOTE_ROOT, putTree, pseudoRandom, sha256, type SeededFile } from "../helpers/seed.js";
import { rcloneBin, sftpHostKey } from "./stack.js";

export const MIB = 1024 * 1024;
export type Target = Service | "sftp-key";
export const serviceOf = (t: Target): Service => (t === "sftp-key" ? "sftp" : t);
/** Remote path of the data root as the client sees it (sftp users are chrooted with a data/ dir). */
export const remoteBase = (t: Target): string => (serviceOf(t) === "sftp" ? "/data" : "");

const fakeCrypto = {
  encrypt: (plain: string): Buffer => Buffer.from(`ENC:${Buffer.from(plain).toString("base64")}`),
  decrypt: (blob: Buffer): string => Buffer.from(blob.toString().slice(4), "base64").toString(),
};
const MIGRATIONS = new URL("../../../src/migrations", import.meta.url).pathname;

export type Meter = { bytes: number; opens: number; onBytes?: (total: number) => void };

/** Wraps a session so every byte that leaves `openRange` is counted (independent of the downloader's own counters). */
function meterEngine(inner: TransferEngine, meter: Meter): TransferEngine {
  return {
    id: inner.id,
    capabilities: inner.capabilities,
    testConnection: (h) => inner.testConnection(h),
    async open(host) {
      const s = await inner.open(host);
      const wrapped: EngineSession = {
        list: (r, o) => s.list(r, o),
        stat: (p) => s.stat(p),
        remove: (p) => s.remove(p),
        move: (a, b) => s.move(a, b),
        close: () => s.close(),
        openRange(p, offset, count, signal): Readable {
          meter.opens++;
          const src = s.openRange(p, offset, count, signal);
          const t = new Transform({
            transform(chunk: Buffer, _enc, cb) {
              meter.bytes += chunk.length;
              meter.onBytes?.(meter.bytes);
              cb(null, chunk);
            },
          });
          src.on("error", (e) => t.destroy(e));
          src.pipe(t);
          t.on("close", () => src.destroy());
          return t;
        },
      };
      return wrapped;
    },
  };
}

export type RigOpts = {
  target?: Target;
  job?: Partial<JobInput>;
  host?: Partial<HostInput>;
  hostKeys?: string;
  cfg?: Partial<ExecutorDeps["cfg"]>;
  deps?: Partial<ExecutorDeps>;
};
export type RunResult = { state: string; runId: number; row: RunRow };

let counter = 0;
const rigs: Array<() => void> = [];
afterEach(() => {
  for (const c of rigs.splice(0)) c();
});

/** Real RcloneEngine + in-memory SQLite + temp local dir + a unique remote dir, wired like src/app-run.ts. */
export function makeRig(o: RigOpts = {}) {
  const target = o.target ?? "ftp";
  const service = serviceOf(target);
  const dir = `t${Date.now().toString(36)}${counter++}`;
  const tmp = mkdtempSync(path.join(tmpdir(), "harvest-it-"));
  const local = path.join(realpathSync(tmp), "local");
  const engineTmp = path.join(tmp, "rclone");
  const db = openDb(":memory:", MIGRATIONS);
  const stores = createStores(db, fakeCrypto);
  const fx = testHosts()[target];
  const hostId = stores.hosts.create({
    name: fx.name, protocol: fx.protocol, host: fx.host, port: fx.port, username: fx.username, authKind: fx.authKind,
    secret: fx.secret, tlsAcceptSelfSigned: fx.tlsAcceptSelfSigned, maxConnections: 5, ...o.host,
  });
  const pin = o.hostKeys ?? (service === "sftp" ? sftpHostKey() : undefined);
  if (pin) stores.hosts.setHostKeys(hostId, pin, null);
  const remoteRoot = `${remoteBase(target)}/${dir}`;
  const jobId = stores.jobs.create({
    name: "it-job", hostId, remotePath: remoteRoot, localPath: local, settleSeconds: 60, parallelFiles: 2, rangeStreams: 4,
    retries: 2, ...o.job,
  });
  const meter: Meter = { bytes: 0, opens: 0 };
  const logLines: string[] = [];
  const sink = new Writable({ write(chunk: Buffer, _e, cb) { logLines.push(chunk.toString()); cb(); } });
  const logger = buildLogger("debug", false, sink);
  const clock = { t: Date.now() };
  const control = { rate: null as number | null, freezeAfterBytes: null as number | null };
  const engine = meterEngine(createRcloneEngine({ rclone: rcloneBin(), tmpDir: engineTmp, connectTimeoutMs: 5000, runTimeoutMs: 60_000 }), meter);
  const bus = createEventBus();
  const mkExecutor = (extra: Partial<ExecutorDeps> = {}) => {
    const slots = createSlots(stores.hosts.getConfig(hostId).maxConnections);
    const deps: ExecutorDeps = {
      engine, stores, bus, logger,
      cfg: { rangeMinBytes: 2 * MIB, checkpointBytes: 256 * 1024, stallTimeoutMs: 30_000, resumeMarginBytes: 64 * 1024, ...o.cfg },
      slotsFor: () => slots,
      throttleFor: () => {
        const inner = createThrottle({ bytesPerSec: control.rate });
        return {
          async take(bytes, signal) {
            if (control.freezeAfterBytes !== null && meter.bytes >= control.freezeAfterBytes) {
              await new Promise<void>((_res, rej) => signal?.addEventListener("abort", () => rej(abortError(signal)), { once: true }));
            }
            await inner.take(bytes, signal);
          },
        };
      },
      fileGate: { run: (fn) => fn() },
      reservations: createSpaceReservations(),
      onFollowup: () => {},
      now: () => clock.t,
      backoff: (_a, s) => defaultSleep(200, s),
      ...o.deps, ...extra,
    };
    return createExecutor(deps);
  };
  let executor = mkExecutor();
  const run = async (opts: { signal?: AbortSignal; executor?: ReturnType<typeof mkExecutor> } = {}): Promise<RunResult> => {
    const runId = stores.runs.create(jobId, "manual", false);
    const state = await (opts.executor ?? executor)(stores.jobs.get(jobId)!, runId, opts.signal ?? new AbortController().signal);
    return { state, runId, row: stores.runs.get(runId)! };
  };
  /** Retries while the run is not `succeeded` (vsftpd restart gaps make implicit FTPS flaky). Bounded. */
  const runOk = async (attempts = 1, opts: { signal?: AbortSignal } = {}): Promise<RunResult> => {
    let last = await run(opts);
    for (let i = 1; i < attempts && last.state !== "succeeded"; i++) last = await run(opts);
    return last;
  };
  /** Run 1 records first sightings; the clock then moves past settle; run 2 transfers. */
  const settled = async (attempts = 1): Promise<RunResult> => {
    await runOk(attempts);
    clock.t += 120_000;
    return runOk(attempts);
  };
  const seed = async (files: Record<string, number>): Promise<Map<string, SeededFile>> => {
    const content: Record<string, Buffer> = {};
    for (const [rel, size] of Object.entries(files)) content[`${dir}/${rel}`] = pseudoRandom(`${dir}/${rel}`, size);
    const out = new Map<string, SeededFile>();
    for (const f of await putTree(service, content)) out.set(f.path.slice(dir.length + 1), { ...f, path: f.path.slice(dir.length + 1) });
    return out;
  };
  const cleanup = (): void => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  };
  rigs.push(cleanup);
  return {
    target, service, dir, local, stores, hostId, jobId, meter, clock, control, bus, engine, logLines,
    remoteRoot, remoteFs: `${REMOTE_ROOT[service]}/${dir}`,
    run, runOk, settled, seed,
    rebuild: (extra: Partial<ExecutorDeps> = {}) => { executor = mkExecutor(extra); return executor; },
    newExecutor: mkExecutor,
    job: (): JobConfig => stores.jobs.get(jobId)!,
    updateJob: (p: Partial<JobConfig>) => stores.jobs.update(jobId, p),
    activity: () => stores.activity.list({ limit: 1000 }).reverse(),
    ledger: () => stores.ledger.listActive(jobId, { limit: 1000, offset: 0 }).rows,
    localFiles: (): string[] => { try { return readdirSync(local); } catch { return []; } },
    localPath: (rel: string) => path.join(local, ...rel.split("/")),
    remoteSha: async (rel: string): Promise<string> =>
      (await composeExec(service, ["sha256sum", `${REMOTE_ROOT[service]}/${dir}/${rel}`])).split(" ")[0]!,
    remoteExists: async (rel: string): Promise<boolean> =>
      (await composeExec(service, ["sh", "-c", `test -e '${REMOTE_ROOT[service]}/${dir}/${rel}' && echo yes || echo no`])).trim() === "yes",
  };
}
export type Rig = ReturnType<typeof makeRig>;

export const fileSha = async (p: string): Promise<string> => {
  const { readFile } = await import("node:fs/promises");
  return createHash("sha256").update(await readFile(p)).digest("hex");
};
export { sha256, pseudoRandom };

/** A syntactically valid ed25519 host key line that does not match any test server. */
export function randomHostKeyLine(): string {
  const x = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!;
  const raw = Buffer.from(x, "base64url");
  const str = (b: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
  return `ssh-ed25519 ${Buffer.concat([str(Buffer.from("ssh-ed25519")), str(raw)]).toString("base64")}`;
}
