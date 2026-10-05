import { promises as fsp } from "node:fs";
import path from "node:path";

export type Limits = { maxBytes: number; maxEntries: number };
export const DEFAULT_LIMITS: Limits = { maxBytes: 50 * 1024 ** 3, maxEntries: 100_000 };

export const isInside = (root: string, target: string): boolean => {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
};

/** Entries from an archive listing that must never be extracted: absolute, `..` segments, empty or NUL names. */
export function unsafeName(name: string): boolean {
  const n = name.replace(/\\/g, "/");
  return n === "" || n.includes("\0") || n.startsWith("/") || /^[a-zA-Z]:/.test(n) || n.split("/").includes("..");
}

/**
 * Walks an extraction result with lstat. Rejects symlinks, hard-linked files, devices and sockets, anything that
 * resolves outside `root`, and trees over the caps. Returns the regular files relative to `root` (posix separators).
 */
export async function scanTree(root: string, limits: Limits): Promise<{ files: string[]; bytes: number }> {
  const realRoot = await fsp.realpath(root);
  const files: string[] = [];
  let bytes = 0;
  let entries = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      const st = await fsp.lstat(full);
      if (++entries > limits.maxEntries) throw new Error(`archive has more than ${limits.maxEntries} entries`);
      if (st.isSymbolicLink()) throw new Error(`archive contains a symbolic link (${r}); not extracted`);
      if (!isInside(realRoot, await fsp.realpath(full))) throw new Error(`archive entry escapes the extraction directory (${r})`);
      if (st.isDirectory()) await walk(full, r);
      else if (!st.isFile() || st.nlink > 1) throw new Error(`archive contains a special or hard-linked file (${r}); not extracted`);
      else {
        bytes += st.size;
        if (bytes > limits.maxBytes) throw new Error(`archive expands beyond ${limits.maxBytes} bytes`);
        files.push(r);
      }
    }
  };
  await walk(root, "");
  return { files, bytes };
}

export const EXTRACT_TMP_PREFIX = ".harvest-extract-";

/** Removes `.harvest-extract-*` directories an earlier killed attempt left in `dir` (the finally block never ran). */
export async function clearStaleExtractDirs(dir: string): Promise<void> {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.startsWith(EXTRACT_TMP_PREFIX)) await fsp.rm(path.join(dir, e.name), { recursive: true, force: true });
  }
}

async function fsyncPath(p: string): Promise<void> {
  const fh = await fsp.open(p, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * A staged file at `t` may only be replaced when it is stale output of an earlier aborted attempt: a plain file that is NOT
 * one of the unit's own staged downloads (`protectedFiles`, absolute paths).
 */
async function assertReplaceable(t: string, destDir: string, protectedFiles: ReadonlySet<string>): Promise<void> {
  const st = await fsp.lstat(t).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
  if (st === null) return;
  if (protectedFiles.has(path.resolve(t)) || !st.isFile()) throw new Error(`extracted file would overwrite an existing file: ${path.relative(destDir, t)}`);
}

/**
 * Moves scanned files from `tmp` into `destDir` (same filesystem); fsyncs every file and touched directory.
 * Refuses to overwrite the unit's own staged files (`protectedFiles`) or non-files; stale extracted output from an
 * earlier aborted attempt is replaced.
 */
export async function moveIntoPlace(tmp: string, destDir: string, rels: string[], confine: string, protectedFiles: ReadonlySet<string> = new Set()): Promise<string[]> {
  const targets = rels.map((r) => path.join(destDir, ...r.split("/")));
  for (const t of targets) {
    if (!isInside(confine, t)) throw new Error(`extracted path leaves the staging directory: ${t}`);
    await assertReplaceable(t, destDir, protectedFiles);
  }
  const moved: string[] = [];
  const dirs = new Set<string>();
  try {
    for (const [i, t] of targets.entries()) {
      await fsp.mkdir(path.dirname(t), { recursive: true });
      await fsp.rename(path.join(tmp, ...rels[i]!.split("/")), t);
      moved.push(t);
      await fsyncPath(t);
      dirs.add(path.dirname(t));
    }
    for (const d of dirs) await fsyncPath(d);
  } catch (err) {
    await Promise.all(moved.map((m) => fsp.rm(m, { force: true })));
    throw err;
  }
  return moved;
}
