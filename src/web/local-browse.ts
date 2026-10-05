import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import { formatBytes } from "./format.js";

export type LocalPathCheck = { ok: true; path: string } | { ok: false; error: string };
export type LocalCrumb = { name: string; path: string };
export type LocalListing =
  | { ok: true; kind: "roots"; roots: { path: string; free: string }[] }
  | { ok: true; kind: "dir"; path: string; parent: string | null; crumbs: LocalCrumb[]; dirs: LocalCrumb[]; free: string }
  | { ok: false; error: string };

const inside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

async function realOrResolved(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** Realpaths of the configured browse roots that exist. */
async function realRoots(config: Config): Promise<string[]> {
  const out: string[] = [];
  for (const r of config.BROWSE_ROOTS) {
    try {
      out.push(await fs.realpath(r));
    } catch {
      // a root that is not mounted is simply not browsable
    }
  }
  return out;
}

/** Syntax checks before touching the filesystem. Returns an error message or null. */
function shapeError(raw: string): string | null {
  if (!raw) return "Local path is required";
  if (raw.includes("\0")) return "Local path contains invalid characters";
  if (!path.isAbsolute(raw)) return "Local path must be absolute";
  if (raw.split(/[\\/]/).includes("..")) return "Local path must not contain \"..\"";
  return null;
}

async function resolveReal(raw: string): Promise<{ real: string } | { error: string }> {
  try {
    return { real: await fs.realpath(raw) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { error: code === "ENOENT" || code === "ENOTDIR" ? "Local path does not exist" : "Local path cannot be resolved" };
  }
}

async function dirError(real: string): Promise<string | null> {
  const st = await fs.stat(real);
  if (!st.isDirectory()) return "Local path is not a directory";
  try {
    await fs.access(real, fs.constants.W_OK);
  } catch {
    return "Local path is not writable by Harvest";
  }
  return null;
}

/**
 * Server-side check of a job's local_path: absolute, no `..`, realpath-resolved, inside a BROWSE_ROOT, neither equal to,
 * inside nor containing CONFIG_DIR, and an existing writable directory. Returns the realpath to store and to use at run start.
 */
export async function validateLocalPath(input: string, config: Config): Promise<LocalPathCheck> {
  const raw = input.trim();
  const bad = shapeError(raw);
  if (bad) return { ok: false, error: bad };
  const r = await resolveReal(raw);
  if ("error" in r) return { ok: false, error: r.error };
  const roots = await realRoots(config);
  if (!roots.some((root) => inside(r.real, root))) {
    return { ok: false, error: `Local path must be inside one of the allowed folders: ${config.BROWSE_ROOTS.join(", ")}` };
  }
  const cfg = await realOrResolved(config.CONFIG_DIR);
  if (inside(r.real, cfg) || inside(cfg, r.real)) return { ok: false, error: "Local path must not overlap Harvest's own config directory" };
  const err = await dirError(r.real);
  return err ? { ok: false, error: err } : { ok: true, path: r.real };
}

async function freeSpace(p: string): Promise<string> {
  try {
    const s = await fs.statfs(p);
    return formatBytes(s.bavail * s.bsize);
  } catch {
    return "unavailable";
  }
}

function crumbsFor(real: string, root: string): LocalCrumb[] {
  const crumbs: LocalCrumb[] = [{ name: root, path: root }];
  let cur = root;
  for (const seg of path.relative(root, real).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, seg);
    crumbs.push({ name: seg, path: cur });
  }
  return crumbs;
}

/** Child directories only; symlinks are followed but dropped when they leave the root. CONFIG_DIR is never offered. */
async function childDirs(real: string, root: string, cfg: string): Promise<LocalCrumb[]> {
  const out: LocalCrumb[] = [];
  for (const e of await fs.readdir(real, { withFileTypes: true })) {
    const full = path.join(real, e.name);
    if (e.isDirectory()) {
      if (!inside(full, cfg)) out.push({ name: e.name, path: full });
    } else if (e.isSymbolicLink()) {
      try {
        const target = await fs.realpath(full);
        if (inside(target, root) && !inside(target, cfg) && (await fs.stat(target)).isDirectory()) out.push({ name: e.name, path: target });
      } catch {
        // dangling link: skip
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read-only directory listing under BROWSE_ROOTS. No path (or an empty one) lists the roots themselves. */
export async function listLocal(input: string | undefined, config: Config): Promise<LocalListing> {
  const cfg = await realOrResolved(config.CONFIG_DIR);
  const roots = (await realRoots(config)).filter((x) => !inside(x, cfg));
  const raw = (input ?? "").trim();
  if (!raw) return { ok: true, kind: "roots", roots: await Promise.all(roots.map(async (p) => ({ path: p, free: await freeSpace(p) }))) };
  const bad = shapeError(raw);
  if (bad) return { ok: false, error: bad };
  const r = await resolveReal(raw);
  if ("error" in r) return { ok: false, error: r.error };
  const root = roots.find((x) => inside(r.real, x));
  if (!root || inside(r.real, cfg)) return { ok: false, error: "That folder is outside the allowed folders" };
  try {
    const dirs = await childDirs(r.real, root, cfg);
    return { ok: true, kind: "dir", path: r.real, parent: r.real === root ? null : path.dirname(r.real), crumbs: crumbsFor(r.real, root), dirs, free: await freeSpace(r.real) };
  } catch {
    return { ok: false, error: "That folder cannot be read" };
  }
}
