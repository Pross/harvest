import path from "node:path";

export type ArchiveKind = "rar" | "other";
/** One extractable archive: `first` is the file handed to the extractor, `parts` is every file of the set (including `first`). */
export type ArchiveSet = { kind: ArchiveKind; first: string; parts: string[] };
export type Grouped = { sets: ArchiveSet[]; warnings: string[] };

const PART_RAR = /^(.*)\.part0*(\d+)\.rar$/i;
const OLD_VOL = /^(.*)\.r\d{2,}$/i;
const SPLIT_7Z = /^(.*\.7z)\.(\d{3})$/i;

/** Lower-cased "dir/base" key so volumes of one set group together. */
const keyOf = (file: string, base: string): string => path.join(path.dirname(file), base).toLowerCase();

function partRarSets(files: string[], out: Grouped): Set<string> {
  const groups = new Map<string, { n: number; file: string }[]>();
  for (const f of files) {
    const m = PART_RAR.exec(path.basename(f));
    if (m) groups.set(keyOf(f, m[1]!), [...(groups.get(keyOf(f, m[1]!)) ?? []), { n: Number(m[2]), file: f }]);
  }
  const used = new Set<string>();
  for (const list of groups.values()) {
    list.sort((a, b) => a.n - b.n);
    for (const v of list) used.add(v.file);
    const low = list[0]!;
    if (low.n > 1) out.warnings.push(`${path.basename(low.file)}: first volume of the multi-part RAR set is missing; not extracted`);
    else out.sets.push({ kind: "rar", first: low.file, parts: list.map((v) => v.file) });
  }
  return used;
}

function oldStyleRarSets(files: string[], used: Set<string>, out: Grouped): void {
  const vols = new Map<string, string[]>();
  for (const f of files) {
    const m = OLD_VOL.exec(path.basename(f));
    if (m && !used.has(f)) vols.set(keyOf(f, m[1]!), [...(vols.get(keyOf(f, m[1]!)) ?? []), f]);
  }
  for (const f of files) {
    if (used.has(f) || path.extname(f).toLowerCase() !== ".rar") continue;
    const key = keyOf(f, path.basename(f, path.extname(f)));
    const rest = (vols.get(key) ?? []).sort();
    vols.delete(key);
    used.add(f);
    out.sets.push({ kind: "rar", first: f, parts: [f, ...rest] });
  }
  for (const orphans of vols.values()) out.warnings.push(`${path.basename(orphans[0]!)}: RAR volume without a first volume (.rar); not extracted`);
}

function plainSets(files: string[], out: Grouped): void {
  const split = new Map<string, string[]>();
  for (const f of files) {
    const base = path.basename(f);
    const m = SPLIT_7Z.exec(base);
    if (m) split.set(keyOf(f, m[1]!), [...(split.get(keyOf(f, m[1]!)) ?? []), f]);
    else if (/\.(zip|7z)$/i.test(base)) out.sets.push({ kind: "other", first: f, parts: [f] });
  }
  for (const list of split.values()) {
    list.sort();
    if (list[0]!.endsWith(".001")) out.sets.push({ kind: "other", first: list[0]!, parts: list });
    else out.warnings.push(`${path.basename(list[0]!)}: first volume of the split 7z set is missing; not extracted`);
  }
}

/** Finds the archives among staged files. Only the first volume of a multi-volume set is extracted; the other volumes belong to its set. */
export function groupArchives(files: readonly string[]): Grouped {
  const sorted = [...files].sort();
  const out: Grouped = { sets: [], warnings: [] };
  const used = partRarSets(sorted, out);
  oldStyleRarSets(sorted, used, out);
  plainSets(sorted.filter((f) => !used.has(f)), out);
  return out;
}
