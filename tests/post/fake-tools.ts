import { promises as fsp } from "node:fs";
import path from "node:path";
import { sevenZipTool, unarTool, type FoundTools, type RunTool, type ToolResult } from "../../src/post/extract-tools.js";

export type FakeEntry = { path: string; content?: string; link?: boolean; size?: number };
export type FakeArchive = { entries: FakeEntry[]; failExtract?: string; writeSymlink?: string };

export const fakeTools: FoundTools = { sevenZip: sevenZipTool("/fake/7zz"), rar: unarTool("/fake/unar", "/fake/lsar") };

const ok = (stdout = ""): ToolResult => ({ code: 0, stdout, stderr: "", timedOut: false, truncated: false });

function listing(bin: string, a: FakeArchive): string {
  if (bin === "/fake/lsar") {
    return JSON.stringify({ lsarContents: a.entries.map((e) => ({ XADFileName: e.path, XADFileSize: e.size ?? (e.content ?? "").length, ...(e.link ? { XADIsLink: 1 } : {}) })) });
  }
  return a.entries.map((e) => `Path = ${e.path}\nFolder = -\nSize = ${e.size ?? (e.content ?? "").length}\nAttributes = ${e.link ? " lrwxrwxrwx" : " -rw-r--r--"}\n`).join("\n");
}

/** A RunTool that behaves like 7zz/unar for archives registered by base name. Records every call. */
export function fakeRunner(archives: Record<string, FakeArchive>): { run: RunTool; calls: { bin: string; args: string[] }[] } {
  const calls: { bin: string; args: string[] }[] = [];
  const run: RunTool = async (bin, args) => {
    calls.push({ bin, args });
    const archive = args[args.length - 1]!;
    const a = archives[path.basename(archive)];
    if (!a) return { ...ok(), code: 2, stderr: "Cannot open the file as archive" };
    const isList = bin === "/fake/lsar" || args[0] === "l";
    if (isList) return ok(listing(bin, a));
    if (a.failExtract) return { ...ok(), code: 2, stderr: a.failExtract };
    const out = bin === "/fake/unar" ? args[args.indexOf("-o") + 1]! : args.find((x) => x.startsWith("-o"))!.slice(2);
    for (const e of a.entries) {
      await fsp.mkdir(path.dirname(path.join(out, e.path)), { recursive: true });
      await fsp.writeFile(path.join(out, e.path), e.content ?? "");
    }
    if (a.writeSymlink) await fsp.symlink(a.writeSymlink, path.join(out, "evil-link"));
    return ok();
  };
  return { run, calls };
}
