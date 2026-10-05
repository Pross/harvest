import { promises as fsp } from "node:fs";
import path from "node:path";
import type { AfterPromoteStep } from "./types.js";
import type { PostStore } from "./deps.js";
import { isInside } from "./extract-fs.js";

/** Three octal digits (644) or four with a leading 0 (0644). No setuid, setgid or sticky bits. */
const MODE_RE = /^(0[0-7]{3}|[0-7]{3})$/;

/** Why `v` is not an acceptable mode, or null. Files need owner read+write (0o600); directories owner read+write+execute (0o700). */
export function modeProblem(kind: "file" | "dir", v: string): string | null {
  if (!MODE_RE.test(v)) return "Use three octal digits such as 644, or four with a leading 0 such as 0755 (no setuid, setgid or sticky bits).";
  const need = kind === "file" ? 0o600 : 0o700;
  if ((parseInt(v, 8) & need) !== need) return kind === "file" ? "A file mode must keep owner read and write (at least 600) so Harvest and you can still manage the file." : "A directory mode must keep owner read, write and execute (at least 700) so Harvest and you can still open it.";
  return null;
}

/** Directories strictly between `root` and the file, outermost first. */
function ancestorsBelow(root: string, file: string): string[] {
  const dirs: string[] = [];
  for (let d = path.dirname(file); isInside(root, d) && path.resolve(d) !== path.resolve(root); d = path.dirname(d)) dirs.unshift(d);
  return dirs;
}

/** chmod `p` when it is a real (non-symlink) entry of the expected kind whose real path stays below `realRoot`. Returns true when applied. */
async function apply(p: string, mode: number, dir: boolean, realRoot: string): Promise<boolean> {
  const st = await fsp.lstat(p).catch(() => null);
  if (!st || st.isSymbolicLink() || st.isDirectory() !== dir || (!dir && !st.isFile())) return false;
  if (!isInside(realRoot, await fsp.realpath(p))) return false;
  await fsp.chmod(p, mode);
  return true;
}

/**
 * Applies the job's octal modes to the promoted files and to the directories above them (below the job's local path only).
 * Symlinks and anything resolving outside the local path are skipped. Errors on single paths become warnings.
 */
export function createChmodStep(deps: { postStore: PostStore }): AfterPromoteStep {
  return {
    async run(input) {
      const cfg = deps.postStore.get(input.job.id);
      const warnings: string[] = [];
      if (!cfg.chmodFile && !cfg.chmodDir) return { warnings };
      for (const [kind, m] of [["file", cfg.chmodFile], ["dir", cfg.chmodDir]] as const) if (m && modeProblem(kind, m)) return { warnings: [`chmod skipped: invalid ${kind} mode ${m}`] };
      const root = input.job.localPath;
      const realRoot = await fsp.realpath(root);
      const fileMode = cfg.chmodFile ? parseInt(cfg.chmodFile, 8) : null;
      const dirMode = cfg.chmodDir ? parseInt(cfg.chmodDir, 8) : null;
      const dirs = new Set<string>();
      for (const f of input.finalPaths) {
        if (!isInside(root, f)) { warnings.push(`chmod skipped for a path outside the local path: ${path.basename(f)}`); continue; }
        for (const d of ancestorsBelow(root, f)) dirs.add(d);
        await guarded(warnings, f, fileMode, false, realRoot);
      }
      for (const d of dirs) await guarded(warnings, d, dirMode, true, realRoot);
      return { warnings };
    },
  };
}

async function guarded(warnings: string[], p: string, mode: number | null, dir: boolean, realRoot: string): Promise<void> {
  if (mode === null) return;
  try {
    await apply(p, mode, dir, realRoot);
  } catch (err) {
    warnings.push(`chmod failed for ${path.basename(p)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
