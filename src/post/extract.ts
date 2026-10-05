import { promises as fsp } from "node:fs";
import path from "node:path";
import type { ExtractInput, ExtractStep } from "./types.js";
import type { PostStore } from "./deps.js";
import { groupArchives, type ArchiveSet } from "./archives.js";
import { clearStaleExtractDirs, DEFAULT_LIMITS, EXTRACT_TMP_PREFIX, moveIntoPlace, scanTree, unsafeName, type Limits } from "./extract-fs.js";
import { spawnTool, type FoundTools, type RunTool, type Tool, type ToolResult } from "./extract-tools.js";

export type ExtractDeps = {
  postStore: PostStore;
  tools: FoundTools;
  run?: RunTool;
  statfs?: (p: string) => Promise<{ bavail: number; bsize: number }>;
  limits?: Limits;
  timeoutMs?: number;
};

type Out = { warnings: string[]; added: string[]; removed: string[] };
const SPACE_MARGIN = 64 * 1024 ** 2;
const MAX_LIST_OUTPUT = 64 * 1024 ** 2;

const tail = (s: string): string => s.replace(/\s+/g, " ").trim().slice(-200);
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function failure(tool: Tool, what: string, r: ToolResult, kind: ArchiveSet["kind"]): Error {
  if (r.timedOut) return new Error(`${tool.name} timed out while ${what}`);
  if (r.truncated) return new Error(`${tool.name} produced too much output while ${what}`);
  const hint = kind === "rar" && tool.name === "7-Zip" ? " (RAR is not supported by this 7-Zip build; install unar)" : "";
  return new Error(`${tool.name} failed while ${what} (exit ${r.code}): ${tail(r.stderr || r.stdout)}${hint}`);
}

/** Pre-extraction safety: no links, no absolute or `..` names, entry and size caps, enough free space. */
function checkListing(entries: ReturnType<Tool["parseList"]>, limits: Limits): number {
  if (entries.length > limits.maxEntries) throw new Error(`archive has more than ${limits.maxEntries} entries`);
  let total = 0;
  for (const e of entries) {
    if (unsafeName(e.path)) throw new Error(`archive entry has an unsafe path (${e.path.slice(0, 80)})`);
    if (e.isLink) throw new Error(`archive contains a link (${e.path.slice(0, 80)}); not extracted`);
    total += e.size;
  }
  if (total > limits.maxBytes) throw new Error(`archive would expand to ${total} bytes, over the ${limits.maxBytes} byte cap`);
  return total;
}

async function ensureSpace(deps: ExtractDeps, dir: string, need: number): Promise<void> {
  const st = await (deps.statfs ?? ((p: string) => fsp.statfs(p)))(dir);
  if (st.bavail * st.bsize < need + SPACE_MARGIN) throw new Error(`not enough free space to extract (${need} bytes needed)`);
}

async function listEntries(deps: ExtractDeps, tool: Tool, set: ArchiveSet, input: ExtractInput) {
  const run = deps.run ?? spawnTool;
  const r = await run(tool.listBin, tool.listArgs(set.first), { signal: input.signal, timeoutMs: deps.timeoutMs ?? 600_000, maxOutput: MAX_LIST_OUTPUT });
  if (r.code !== 0 || r.timedOut || r.truncated) throw failure(tool, "listing", r, set.kind);
  try {
    return tool.parseList(r.stdout);
  } catch {
    throw new Error(`${tool.name} returned an unreadable listing`);
  }
}

async function extractSet(deps: ExtractDeps, set: ArchiveSet, input: ExtractInput): Promise<string[]> {
  const tool = set.kind === "rar" ? deps.tools.rar : deps.tools.sevenZip;
  if (!tool) throw new Error(set.kind === "rar" ? "RAR is not supported: no RAR extractor (unar) is installed" : "no archive extractor (7zz) is installed");
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const total = checkListing(await listEntries(deps, tool, set, input), limits);
  const dest = path.dirname(set.first);
  await ensureSpace(deps, dest, total);
  await clearStaleExtractDirs(input.unitDir);
  const tmp = await fsp.mkdtemp(path.join(input.unitDir, EXTRACT_TMP_PREFIX));
  try {
    const run = deps.run ?? spawnTool;
    const r = await run(tool.bin, tool.extractArgs(set.first, tmp), { signal: input.signal, timeoutMs: deps.timeoutMs ?? 6 * 3600_000, maxOutput: 1024 ** 2 });
    if (r.code !== 0 || r.timedOut || r.truncated) throw failure(tool, "extracting", r, set.kind);
    const scan = await scanTree(tmp, limits);
    if (scan.files.length === 0) throw new Error("archive contained no files");
    return await moveIntoPlace(tmp, dest, scan.files, input.unitDir, new Set(input.files.map((f) => path.resolve(f))));
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

/** An aborted unit is never finalized, so files already moved for earlier sets would be orphaned in staging: remove them. */
async function removeAll(files: string[]): Promise<void> {
  await Promise.all(files.map((f) => fsp.rm(f, { force: true })));
}

/**
 * Extracts every archive set of the unit next to the archive, inside staging. A set that fails leaves its archive files untouched and
 * adds a warning; with mode `delete` the volumes of a successfully extracted set are reported in `removed` (the caller drops them).
 */
export function createExtractStep(deps: ExtractDeps): ExtractStep {
  return {
    async run(input) {
      const mode = deps.postStore.get(input.job.id).extract;
      const out: Out = { warnings: [], added: [], removed: [] };
      if (mode === "off") return out;
      const grouped = groupArchives(input.files);
      out.warnings.push(...grouped.warnings);
      for (const set of grouped.sets) {
        try {
          out.added.push(...(await extractSet(deps, set, input)));
          if (mode === "delete") out.removed.push(...set.parts);
        } catch (err) {
          if (input.signal.aborted) {
            await removeAll(out.added);
            throw err;
          }
          out.warnings.push(`${path.basename(set.first)}: ${messageOf(err)}`);
        }
      }
      return out;
    },
  };
}
