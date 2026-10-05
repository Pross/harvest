import { promises as fsp } from "node:fs";
import path from "node:path";

/** Name of the journal inside a job's staging root. Maps the final path of an extracted file to its size. */
export const EXTRAS_JOURNAL = ".harvest-extras.json";
export type ExtrasJournal = Record<string, number>;

const file = (root: string): string => path.join(root, EXTRAS_JOURNAL);

/** Missing or unreadable journal: no file is provably ours, so callers move existing files aside (the safe default). */
export async function readJournal(root: string): Promise<ExtrasJournal> {
  try {
    const v: unknown = JSON.parse(await fsp.readFile(file(root), "utf8"));
    if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === "number")) as ExtrasJournal;
  } catch {
    return {};
  }
}

/** Atomic and durable: write a temp file, fsync it, rename it over the journal. */
export async function writeJournal(root: string, j: ExtrasJournal): Promise<void> {
  const tmp = `${file(root)}.tmp`;
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(j));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file(root));
}

/** Adds entries (and drops `remove`) in one durable write; an emptied journal is deleted. */
export async function updateJournal(root: string, add: ExtrasJournal, remove: string[] = []): Promise<void> {
  const next = { ...(await readJournal(root)), ...add };
  for (const r of remove) delete next[r];
  if (Object.keys(next).length === 0) await fsp.rm(file(root), { force: true });
  else await writeJournal(root, next);
}
