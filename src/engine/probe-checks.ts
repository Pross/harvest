import type { Readable } from "node:stream";
import type { EngineSession, RemoteEntry } from "./types.js";

export type ResumeResult = "ok" | "failed" | "untested";

const SAMPLE = 8192;
const READ_TIMEOUT_MS = 20_000;
const PROBE_CONNECTIONS = 6;
/** Large enough that the transfer cannot finish into the pipe buffers, so the login stays held. */
const HOLD_MIN_BYTES = 2 * 1024 * 1024;
const SUBDIRS_TO_TRY = 3;

/** Whether the server reports modification times. null when there is nothing listed to judge by. */
export function checkMtime(entries: readonly RemoteEntry[]): boolean | null {
  return entries.length === 0 ? null : entries.some((e) => e.mtimeMs !== null);
}

async function readRange(session: EngineSession, path: string, offset: number, count: number): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), READ_TIMEOUT_MS);
  try {
    const chunks: Buffer[] = [];
    for await (const c of session.openRange(path, offset, count, ctrl.signal)) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

/** First file of at least `minSize` bytes: at the root, else directly inside the first few folders. */
async function findSample(session: EngineSession, root: readonly RemoteEntry[], minSize: number): Promise<string | null> {
  const big = (e: RemoteEntry): boolean => !e.isDir && e.size >= minSize;
  const top = root.find(big);
  if (top) return `/${top.path}`;
  for (const dir of root.filter((e) => e.isDir).slice(0, SUBDIRS_TO_TRY)) {
    const inside = (await session.list(`/${dir.path}`, { recurse: false }).catch(() => [])).find(big);
    if (inside) return `/${dir.path}/${inside.path}`;
  }
  return null;
}

/** Uses the same ranged read Harvest downloads with: bytes read from the middle must equal the same bytes read from the start. */
export async function checkResume(session: EngineSession, root: readonly RemoteEntry[]): Promise<ResumeResult> {
  try {
    const path = await findSample(session, root, SAMPLE);
    if (path === null) return "untested";
    const head = await readRange(session, path, 0, SAMPLE);
    const tail = await readRange(session, path, SAMPLE / 2, SAMPLE / 2);
    return head.length === SAMPLE && tail.equals(head.subarray(SAMPLE / 2)) ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

/** Resolves once the stream has data, i.e. login and data connection are up; the stream is left unread so the server keeps the login. */
function connected(stream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("readable", resolve);
    stream.once("error", reject);
    stream.once("end", () => reject(new Error("closed before any data")));
  });
}

/**
 * How many logins the server grants AT THE SAME TIME (up to PROBE_CONNECTIONS). Every rclone command is its own short-lived
 * login, so listings would finish one after another and prove nothing: instead each login reads a large file and is held
 * open, unread, until all of them have tried. Null when there is no file big enough to hold a login with.
 */
export async function checkConnections(session: EngineSession, root: readonly RemoteEntry[]): Promise<number | null> {
  const path = await findSample(session, root, HOLD_MIN_BYTES);
  if (path === null) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), READ_TIMEOUT_MS);
  try {
    const streams = Array.from({ length: PROBE_CONNECTIONS }, () => session.openRange(path, 0, HOLD_MIN_BYTES, ctrl.signal));
    const results = await Promise.allSettled(streams.map(connected));
    return results.filter((r) => r.status === "fulfilled").length;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/** A cap with headroom: what the server allows, minus one once it allows more than a few, and never above 4. */
export function recommendConnections(allowed: number): number {
  return allowed <= 3 ? Math.max(1, allowed) : Math.min(4, allowed - 1);
}
