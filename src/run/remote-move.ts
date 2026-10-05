import path from "node:path";
import type { EngineSession } from "../engine/types.js";

export type MoveTarget = { ok: true; path: string } | { ok: false; error: string };

const stripLead = (p: string): string => p.replace(/^\/+/, "");

/**
 * Validates a `move_to` folder: absolute, no `..`, not the root, and neither equal to nor inside the job's remote path
 * (moved files would be listed and synced again). Returns the normalized path without a trailing slash.
 */
export function checkMoveTo(moveTo: string, remotePath: string): MoveTarget {
  const raw = moveTo.trim();
  if (raw === "" || raw.includes("\0") || raw.includes("\\")) return { ok: false, error: "Enter an absolute remote folder such as /done" };
  if (!raw.startsWith("/")) return { ok: false, error: "The move folder must be an absolute path starting with /" };
  if (raw.split("/").includes("..")) return { ok: false, error: "The move folder must not contain .." };
  const norm = path.posix.normalize(raw).replace(/\/+$/, "");
  if (norm === "") return { ok: false, error: "The move folder must not be the root /" };
  const src = stripLead(path.posix.normalize(remotePath)).replace(/\/+$/, "");
  const dst = stripLead(norm);
  if (src === "" || dst === src || dst.startsWith(`${src}/`)) {
    return { ok: false, error: "The move folder must be outside the remote path, or moved files would be synced again" };
  }
  return { ok: true, path: norm };
}

/** `a.mkv` -> `a.1.mkv`; a name with no extension gets `.1` appended. */
export function withSuffix(p: string, n: number): string {
  const ext = path.posix.extname(p);
  return `${p.slice(0, p.length - ext.length)}.${n}${ext}`;
}

/**
 * rclone moveto silently overwrites, so stat the destination first and pick a free name (`name.1.ext`, `name.2.ext`...).
 * Parent folders are created implicitly by moveto. Returns the final destination. The stat-then-move window is not atomic;
 * only this app moves files into the done folder, so that is accepted.
 */
export async function moveToFreeName(s: EngineSession, from: string, to: string): Promise<string> {
  let dest = to;
  for (let n = 1; (await s.stat(dest)) !== null; n++) {
    if (n > 1000) throw new Error(`no free name found at ${to}`);
    dest = withSuffix(to, n);
  }
  await s.move(from, dest);
  return dest;
}
