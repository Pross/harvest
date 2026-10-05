import { BW_PROFILES_MAX, BwProfileSchema, resolveGlobalRate, type BwProfile } from "../run/bandwidth.js";
import { formatBytes } from "./format.js";
import { formatRateInput, parseRate } from "./settings-schema.js";

/** Blank spare rows shown below the saved profiles so new ones can be added without client-side script. */
const SPARE_ROWS = 2;
const MAX_ROWS = BW_PROFILES_MAX + SPARE_ROWS;
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export type BwRow = { i: number; days: number[]; from: string; to: string; rate: string; error: string };
export type BwForm = { rows: BwRow[]; profiles: BwProfile[]; listError: string; dayNames: readonly string[]; effective: string };

const str = (body: Record<string, unknown>, key: string): string => (typeof body[key] === "string" ? body[key].trim() : "");

function daysOf(body: Record<string, unknown>, i: number): number[] {
  const raw = body[`bp${i}_days`];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return [...new Set(list.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
}

function rowOf(body: Record<string, unknown>, i: number): BwRow {
  const removed = str(body, `bp${i}_remove`) !== "";
  const blank = { i, days: [], from: "", to: "", rate: "", error: "" };
  return removed ? blank : { i, days: daysOf(body, i), from: str(body, `bp${i}_from`), to: str(body, `bp${i}_to`), rate: str(body, `bp${i}_rate`), error: "" };
}

const isBlank = (r: BwRow): boolean => r.days.length === 0 && !r.from && !r.to && !r.rate;

/** Builds the profile for a non-blank row, or sets row.error. */
function validate(r: BwRow): BwProfile | undefined {
  const bps = r.rate === "" ? null : parseRate(r.rate);
  if (bps === undefined) {
    r.error = "Use a rate like 10M, 500K or 2G, or leave blank for unlimited.";
    return undefined;
  }
  const parsed = BwProfileSchema.safeParse({ days: r.days, from: r.from, to: r.to, bps });
  if (!parsed.success) r.error = parsed.error.issues[0]?.message ?? "Invalid profile.";
  return parsed.success ? parsed.data : undefined;
}

export function describeRate(bps: number | null): string {
  return bps === null ? "unlimited" : `${formatBytes(bps)}/s`;
}

/** Reads rows `bp0_*`..`bpN_*` from a form body. Blank rows are dropped; an invalid row keeps its text and error. */
export function parseBwForm(body: Record<string, unknown>, base: number | null, now: Date): BwForm {
  const rows: BwRow[] = [];
  for (let i = 0; i < MAX_ROWS; i++) rows.push(rowOf(body, i));
  const profiles: BwProfile[] = [];
  for (const r of rows) {
    const p = isBlank(r) ? undefined : validate(r);
    if (p) profiles.push(p);
  }
  const listError = profiles.length > BW_PROFILES_MAX ? `Use at most ${BW_PROFILES_MAX} profiles.` : "";
  const effective = describeRate(resolveGlobalRate({ bwlimitGlobalBps: base, bwProfiles: profiles }, now));
  return { rows: trimRows(rows), profiles, listError, dayNames: DAY_NAMES, effective };
}

/** Keeps rows up to the last filled one plus the spare blank rows. */
function trimRows(rows: BwRow[]): BwRow[] {
  let last = -1;
  rows.forEach((r, i) => { if (!isBlank(r)) last = i; });
  return rows.slice(0, Math.min(rows.length, last + 1 + SPARE_ROWS));
}

export const hasBwErrors = (f: BwForm): boolean => f.listError !== "" || f.rows.some((r) => r.error !== "");

/** The form for stored profiles, plus spare blank rows. */
export function bwFormFromProfiles(profiles: readonly BwProfile[], base: number | null, now: Date): BwForm {
  const rows: BwRow[] = profiles.map((p, i) => ({ i, days: [...p.days], from: p.from, to: p.to, rate: formatRateInput(p.bps), error: "" }));
  for (let i = rows.length; i < Math.min(MAX_ROWS, profiles.length + SPARE_ROWS); i++) rows.push({ i, days: [], from: "", to: "", rate: "", error: "" });
  const effective = describeRate(resolveGlobalRate({ bwlimitGlobalBps: base, bwProfiles: profiles }, now));
  return { rows, profiles: [...profiles], listError: "", dayNames: DAY_NAMES, effective };
}
