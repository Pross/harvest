import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { PermanentError, TransientNetwork } from "../errors.js";
import { mapRcloneError } from "./rclone-errors.js";

export type SpawnFn = typeof nodeSpawn;
export type ProcessDeps = {
  rclone: string;
  tmpDir: string;
  spawn?: SpawnFn;
  /** Time a child gets to exit after SIGTERM before it is sent SIGKILL. Default 5 s. */
  killGraceMs?: number;
};
export type RunOptions = { timeoutMs?: number; signal?: AbortSignal; stdin?: string };
export type RunResult = { code: number | null; stdout: string; stderr: string };

const MAX_STDERR = 64 * 1024;
const DEFAULT_KILL_GRACE_MS = 5000;
const STALE_CONFIG_AGE_MS = 3_600_000;

const exited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

/** SIGTERM now, SIGKILL after the grace period if the child is still alive. */
function terminate(child: ChildProcess, graceMs: number | undefined): void {
  if (exited(child)) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => { if (!exited(child)) child.kill("SIGKILL"); }, graceMs ?? DEFAULT_KILL_GRACE_MS);
  timer.unref();
  child.once("close", () => clearTimeout(timer));
}

/** Removes `rclone-*.conf` files older than an hour that crashed processes left in tmpDir. */
export function cleanStaleConfigs(tmpDir: string, nowMs: number = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(tmpDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return; // nothing to clean
    throw err;
  }
  for (const name of names) {
    if (!/^rclone-.+\.conf$/.test(name)) continue;
    const file = join(tmpDir, name);
    try {
      if (nowMs - statSync(file).mtimeMs > STALE_CONFIG_AGE_MS) unlinkSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

/**
 * CLEAN child env. Never inherits process.env wholesale, so APP_SECRET / ADMIN_PASS cannot leak.
 * HOME and XDG_CACHE_HOME live under tmpDir; RCLONE_CONFIG is a unique empty file per spawn.
 */
export function buildChildEnv(tmpDir: string, configPath: string, remoteEnv: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: tmpDir,
    XDG_CACHE_HOME: join(tmpDir, "cache"),
    RCLONE_CONFIG: configPath,
    ...remoteEnv,
  };
}

type Spawned = { child: ChildProcess; cleanup: () => void };

function launch(deps: ProcessDeps, remoteEnv: Record<string, string>, args: string[], stdin: boolean): Spawned {
  const configPath = join(deps.tmpDir, `rclone-${randomUUID()}.conf`);
  try {
    mkdirSync(join(deps.tmpDir, "cache"), { recursive: true, mode: 0o700 });
    closeSync(openSync(configPath, "w", 0o600));
  } catch (err) {
    throw new PermanentError(`cannot prepare rclone working files in ${deps.tmpDir}`, { cause: err });
  }
  const cleanup = () => {
    try { unlinkSync(configPath); } catch { /* already removed */ }
  };
  try {
    const env = buildChildEnv(deps.tmpDir, configPath, remoteEnv);
    const child = (deps.spawn ?? nodeSpawn)(deps.rclone, args, { env, stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    child.once("close", cleanup);
    child.once("error", cleanup);
    return { child, cleanup };
  } catch (err) {
    cleanup();
    throw new PermanentError("failed to spawn rclone", { cause: err });
  }
}

function capture(child: ChildProcess): { stdout: () => string; stderr: () => string } {
  const out: Buffer[] = [];
  let err = "";
  child.stdout?.on("data", (c: Buffer) => out.push(c));
  child.stderr?.on("data", (c: Buffer) => { if (err.length < MAX_STDERR) err += c.toString("utf8"); });
  return { stdout: () => Buffer.concat(out).toString("utf8"), stderr: () => err };
}

export type Runner = {
  /** Collects output; never throws on a non-zero exit (callers map it), throws on timeout/abort/spawn failure. */
  run(args: string[], opts?: RunOptions): Promise<RunResult>;
  /** Like run but throws the mapped typed error on a non-zero exit. */
  runOk(args: string[], opts?: RunOptions): Promise<RunResult>;
  stream(args: string[], signal: AbortSignal): Readable;
  /** Kills every child still running (session close). */
  killAll(): void;
};

type Ctx = { deps: ProcessDeps; remoteEnv: Record<string, string>; track: (c: ChildProcess) => void };

function collect(ctx: Ctx, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new TransientNetwork("rclone aborted"));
    const { child } = launch(ctx.deps, ctx.remoteEnv, args, opts.stdin !== undefined);
    ctx.track(child);
    const cap = capture(child);
    let settled = false;
    const timer = opts.timeoutMs ? setTimeout(() => fail(new TransientNetwork(`rclone timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs) : null;
    const onAbort = () => fail(new TransientNetwork("rclone aborted"));
    const finish = () => { if (timer) clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true; finish(); terminate(child, ctx.deps.killGraceMs); reject(err);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (err) => fail(new PermanentError(`cannot run rclone: ${err.message}`, { cause: err })));
    child.once("close", (code) => {
      if (settled) return;
      settled = true; finish();
      resolve({ code, stdout: cap.stdout(), stderr: cap.stderr() });
    });
    if (opts.stdin !== undefined) {
      child.stdin?.on("error", () => { /* child exited early; the close handler reports */ });
      child.stdin?.end(opts.stdin);
    }
  });
}

function openStream(ctx: Ctx, args: string[], signal: AbortSignal): Readable {
  const out = new PassThrough();
  if (signal.aborted) { out.destroy(abortError()); return out; }
  let child: ChildProcess;
  try {
    child = launch(ctx.deps, ctx.remoteEnv, args, false).child;
  } catch (err) {
    out.destroy(err as Error);
    return out;
  }
  ctx.track(child);
  const cap = capture(child);
  child.stdout?.pipe(out, { end: false });
  const onAbort = () => { terminate(child, ctx.deps.killGraceMs); out.destroy(abortError()); };
  signal.addEventListener("abort", onAbort, { once: true });
  out.once("close", () => {
    signal.removeEventListener("abort", onAbort);
    terminate(child, ctx.deps.killGraceMs);
  });
  child.once("error", (err) => out.destroy(new PermanentError(`cannot run rclone: ${err.message}`, { cause: err })));
  child.once("close", (code) => {
    if (out.destroyed) return;
    if (code === 0) out.end(); else out.destroy(mapRcloneError(code, cap.stderr()));
  });
  return out;
}

export function createRunner(deps: ProcessDeps, remoteEnv: Record<string, string>): Runner {
  const live = new Set<ChildProcess>();
  const track = (child: ChildProcess) => {
    live.add(child);
    child.once("close", () => live.delete(child));
  };
  const ctx: Ctx = { deps, remoteEnv, track };
  const run = (args: string[], opts: RunOptions = {}) => collect(ctx, args, opts);
  async function runOk(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const res = await run(args, opts);
    if (res.code !== 0) throw mapRcloneError(res.code, res.stderr);
    return res;
  }
  const killAll = () => { for (const c of live) terminate(c, deps.killGraceMs); };
  return { run, runOk, stream: (a, s) => openStream(ctx, a, s), killAll };
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/** One-shot helper without a remote (used for `rclone obscure -`). */
export function runPlain(deps: ProcessDeps, args: string[], opts: RunOptions): Promise<RunResult> {
  return createRunner(deps, {}).run(args, opts);
}
