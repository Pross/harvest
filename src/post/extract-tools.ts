import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

export type ToolResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean };
export type RunOpts = { signal: AbortSignal; timeoutMs: number; maxOutput: number };
/** Runs a binary with an argument array (never a shell). Replaceable in tests. */
export type RunTool = (bin: string, args: string[], opts: RunOpts) => Promise<ToolResult>;

export type ListedEntry = { path: string; size: number; isLink: boolean };
/** How to drive one extractor: list entries first (safety checks), then extract into a directory. */
export type Tool = {
  name: string;
  listBin: string;
  listArgs(archive: string): string[];
  parseList(stdout: string): ListedEntry[];
  bin: string;
  extractArgs(archive: string, outDir: string): string[];
};

/** Real runner: clean environment, no stdin, output capped, SIGKILL on timeout or abort. */
export const spawnTool: RunTool = (bin, args, o) =>
  new Promise((resolve, reject) => {
    if (o.signal.aborted) return reject(o.signal.reason ?? new Error("aborted"));
    const child = spawn(bin, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
    const state = { stdout: "", stderr: "", timedOut: false, truncated: false };
    const kill = (): boolean => child.kill("SIGKILL");
    const timer = setTimeout(() => { state.timedOut = true; kill(); }, o.timeoutMs);
    const onAbort = (): void => void kill();
    o.signal.addEventListener("abort", onAbort, { once: true });
    const take = (key: "stdout" | "stderr") => (chunk: Buffer): void => {
      if (state[key].length + chunk.length > o.maxOutput) { state.truncated = true; kill(); return; }
      state[key] += chunk.toString("utf8");
    };
    child.stdout.on("data", take("stdout"));
    child.stderr.on("data", take("stderr"));
    const done = (): void => { clearTimeout(timer); o.signal.removeEventListener("abort", onAbort); };
    child.on("error", (err) => { done(); reject(err); });
    child.on("close", (code) => {
      done();
      if (o.signal.aborted) return reject(o.signal.reason ?? new Error("aborted"));
      resolve({ code, ...state });
    });
  });

/** `7zz l -slt -ba` prints blocks of `Key = value` lines separated by blank lines. */
export function parseSevenZipList(stdout: string): ListedEntry[] {
  const out: ListedEntry[] = [];
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    const kv = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const i = line.indexOf(" = ");
      if (i > 0) kv.set(line.slice(0, i), line.slice(i + 3));
    }
    const p = kv.get("Path");
    if (p === undefined || kv.get("Folder") === "+") continue;
    const attrs = kv.get("Attributes") ?? "";
    const isLink = /(^|\s)l[r-][w-][x-]/.test(attrs) || kv.has("Symbolic Link") || kv.has("Hard Link") || kv.has("Link");
    out.push({ path: p, size: Number(kv.get("Size") ?? 0) || 0, isLink });
  }
  return out;
}

/** `lsar -j` prints JSON; folders have XADIsDirectory, links XADIsLink. */
export function parseLsarList(stdout: string): ListedEntry[] {
  const doc = JSON.parse(stdout) as { lsarContents?: Record<string, unknown>[] };
  return (doc.lsarContents ?? []).filter((e) => !e["XADIsDirectory"]).map((e) => ({
    path: String(e["XADFileName"] ?? ""), size: Number(e["XADFileSize"] ?? 0) || 0, isLink: Boolean(e["XADIsLink"]),
  }));
}

/** Free 7-Zip (Debian package `7zip`, binary 7zz): zip, 7z and many others, but NOT RAR (Debian strips the unRAR code). `-spd` turns off wildcards: without it `a?b.zip` also opens `a1b.zip` and `a2b.zip`. */
export function sevenZipTool(bin: string): Tool {
  return {
    name: "7-Zip", listBin: bin, bin,
    listArgs: (a) => ["l", "-slt", "-ba", "-bd", "-p-", "-spd", "--", a],
    parseList: parseSevenZipList,
    extractArgs: (a, out) => ["x", "-y", "-bd", `-o${out}`, "-p-", "-spd", "--", a],
  };
}

/** Free `unar`/`lsar` (Debian package `unar`): reads RAR 3/5 including multi-volume sets. */
export function unarTool(unar: string, lsar: string): Tool {
  return {
    name: "unar", listBin: lsar, bin: unar,
    listArgs: (a) => ["-j", a],
    parseList: parseLsarList,
    extractArgs: (a, out) => ["-q", "-D", "-nr", "-o", out, a],
  };
}

/** Looks for the first of `names` on PATH that is executable. */
export function findBinary(names: readonly string[], envPath: string | undefined = process.env["PATH"]): string | null {
  for (const dir of (envPath ?? "").split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const full = path.join(dir, n);
      try {
        accessSync(full, constants.X_OK);
        return full;
      } catch { /* try next */ }
    }
  }
  return null;
}

export type FoundTools = { sevenZip: Tool | null; rar: Tool | null };

/** 7zz (Debian) or 7z/7za for zip and 7z; unar for RAR. When only 7-Zip exists, RAR is attempted with it (full builds support RAR). */
export function findTools(envPath?: string): FoundTools {
  const sz = findBinary(["7zz", "7z", "7za"], envPath);
  const unar = findBinary(["unar"], envPath);
  const lsar = findBinary(["lsar"], envPath);
  const sevenZip = sz ? sevenZipTool(sz) : null;
  return { sevenZip, rar: unar && lsar ? unarTool(unar, lsar) : sevenZip };
}
