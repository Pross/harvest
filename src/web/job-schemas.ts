import picomatch from "picomatch";
import { z } from "zod";
import { DEFAULT_EXCLUDES, type JobConfig } from "../domain.js";
import type { HostPublic } from "../store/host-store.js";
import { checkMoveTo } from "../run/remote-move.js";
import { validateSchedule } from "../schedule/schedule-expr.js";
import { bodyStrings, fieldErrors, type FormErrors } from "./host-schemas.js";

const UNIT: Record<string, number> = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

/** "500MB", "2 GB", "1.5GiB", "1024" to bytes (1 KB = 1024 B, matching the sizes shown everywhere else). undefined when invalid. */
export function parseHumanSize(input: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?$/i.exec(input.trim());
  if (!m) return undefined;
  const n = Math.round(Number(m[1]) * (UNIT[(m[2] ?? "").toLowerCase()] ?? 1));
  return Number.isSafeInteger(n) ? n : undefined;
}

/** "10MB/s", "500 KB/s", "2m" to bytes per second. undefined when invalid. */
export function parseHumanRate(input: string): number | undefined {
  return parseHumanSize(input.trim().replace(/\s*(\/s|ps)$/i, ""));
}

/** Bytes back to an editable string using the largest exact unit ("2GB"). */
export function sizeToInput(n: number | null): string {
  if (n === null) return "";
  const units: [string, number][] = [["TB", 1024 ** 4], ["GB", 1024 ** 3], ["MB", 1024 ** 2], ["KB", 1024]];
  for (const [suffix, size] of units) {
    if (n >= size && n % size === 0) return `${n / size}${suffix}`;
  }
  return String(n);
}

const text = z.string().default("");
const human = (label: string, parse: (s: string) => number | undefined, example: string) =>
  text.transform((s, ctx): number | null => {
    if (!s.trim()) return null;
    const n = parse(s);
    if (n === undefined) {
      ctx.addIssue({ code: "custom", message: `${label}: enter a size like ${example}` });
      return z.NEVER;
    }
    return n === 0 ? null : n;
  });
const whole = (min: number, max: number) =>
  text.transform((s, ctx): number => {
    const t = s.trim();
    if (/^\d+$/.test(t) && Number(t) >= min && Number(t) <= max) return Number(t);
    ctx.addIssue({ code: "custom", message: `Enter a whole number from ${min} to ${max}` });
    return z.NEVER;
  });
export const MAX_GLOBS = 50;
export const MAX_GLOB_LENGTH = 200;

/**
 * Why a glob is refused, or null. picomatch only compiles at save time and can hang the event loop at match time on
 * regex-like input such as `(a+)+$`, so groups, extglobs and backslashes are rejected outright; plain `*`, `**`, `?`,
 * `[abc]` and `{a,b}` stay. Chained stars are also polynomial (`a*a*a*a*a*b` took 21 s on a 250-character name), so
 * a path segment may hold at most 3 star runs, a pattern at most 2 `**`, and braces may not hold ranges.
 */
export function globProblem(line: string): string | null {
  if (line.length > MAX_GLOB_LENGTH) return `Pattern is too long (${MAX_GLOB_LENGTH} characters max)`;
  if (/[\u0000-\u001f]/.test(line)) return "Pattern contains control characters";
  if (/[()\\]/.test(line)) return "Parentheses, extglobs and backslashes are not supported in patterns";
  if (/\{[^}]*\.\.[^}]*\}/.test(line) || (line.match(/\{/g) ?? []).length > 3) return "Use at most 3 {a,b} groups and no ranges in patterns";
  const segments = line.split("/");
  if (segments.filter((x) => x === "**").length > 2) return "Use at most 2 ** in a pattern";
  if (segments.some((x) => x !== "**" && (x.match(/\*+/g) ?? []).length > 3)) return "Use at most 3 * per folder or file name in a pattern";
  return null;
}

const globList = text.transform((s, ctx): string[] => {
  const out: string[] = [];
  for (const line of s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const problem = globProblem(line);
    try {
      if (!problem) picomatch(line);
    } catch {
      ctx.addIssue({ code: "custom", message: `Invalid pattern: ${line.slice(0, 60)}` });
      return z.NEVER;
    }
    if (problem) {
      ctx.addIssue({ code: "custom", message: `Invalid pattern (${problem}): ${line.slice(0, 60)}` });
      return z.NEVER;
    }
    if (!out.includes(line)) out.push(line);
    if (out.length > MAX_GLOBS) {
      ctx.addIssue({ code: "custom", message: `Use at most ${MAX_GLOBS} patterns` });
      return z.NEVER;
    }
  }
  return out;
});
const pathField = (label: string) =>
  text.pipe(z.string().trim().min(1, `${label} is required`).max(4096, `${label} is too long`).refine((s) => !s.includes("\0"), `${label} contains invalid characters`));
const checked = text.transform((s) => ["on", "1", "true"].includes(s));

const jobSchema = z.object({
  name: text.pipe(z.string().trim().min(1, "Name is required").max(100, "Name is too long (100 characters max)")),
  host_id: whole(1, 999_999_999).catch(0),
  remote_path: pathField("Remote path"),
  local_path: pathField("Local path"),
  mode: z.enum(["copy_new"], { error: "Mirror mode arrives in Phase 2" }).default("copy_new"),
  unit_mode: z.enum(["top_dir", "file"], { error: "Choose top_dir or file" }).default("top_dir"),
  after_sync: z.enum(["keep", "delete", "delete_after_days", "move"], { error: "Choose keep, delete, delete after N days or move" }).default("keep"),
  after_days: text, move_to: text,
  verify: z.enum(["size", "checksum"], { error: "Choose size or checksum" }).default("size"),
  settle_seconds: whole(0, 604_800), min_age_seconds: whole(0, 31_536_000),
  min_size: human("Minimum size", parseHumanSize, "500MB"), max_size: human("Maximum size", parseHumanSize, "2GB"),
  include_globs: globList, exclude_globs: globList, trust_mtime: checked, enabled: checked,
  parallel_files: whole(1, 16), range_streams: whole(1, 8), retries: whole(0, 10),
  min_free_bytes: human("Minimum free space", parseHumanSize, "20GB"),
  bwlimit: human("Bandwidth limit", parseHumanRate, "10MB/s"),
  schedule_kind: z.enum(["manual", "cron", "interval"], { error: "Choose manual, cron or interval" }).default("manual"),
  schedule_expr: text.pipe(z.string().trim().max(200, "Schedule is too long (200 characters max)")),
  changed_policy: z.enum(["skip", "resync"], { error: "Choose skip or resync" }).default("skip"),
  confirm_ledger_reset: checked,
});

export type JobFormData = Pick<JobConfig, "name" | "hostId" | "remotePath" | "localPath" | "mode" | "unitMode" | "afterSync" | "afterDays" | "moveTo" | "verify" |
  "settleSeconds" | "minAgeSeconds" | "minSize" | "maxSize" | "includeGlobs" | "excludeGlobs" | "trustMtime" | "enabled" | "bwlimitBps" |
  "parallelFiles" | "rangeStreams" | "retries" | "minFreeBytes" | "scheduleKind" | "scheduleExpr" | "changedPolicy"> & { confirmLedgerReset: boolean };
export type JobParse = { ok: true; data: JobFormData } | { ok: false; errors: FormErrors };

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);

type AfterParse = { ok: true; afterDays: number | null; moveTo: string | null } | { ok: false; errors: FormErrors };

/** delete_after_days needs 1..3650 days; move needs a normalized absolute folder outside the remote path. Other modes store neither. */
function parseAfterSync(mode: string, daysText: string, moveText: string, remotePath: string): AfterParse {
  if (mode === "delete_after_days") {
    const t = daysText.trim();
    const ok = /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= 3650;
    return ok ? { ok: true, afterDays: Number(t), moveTo: null } : { ok: false, errors: { after_days: "Enter a whole number of days from 1 to 3650" } };
  }
  if (mode !== "move") return { ok: true, afterDays: null, moveTo: null };
  const target = checkMoveTo(moveText, remotePath);
  return target.ok ? { ok: true, afterDays: null, moveTo: target.path } : { ok: false, errors: { move_to: target.error } };
}

export function parseJobForm(body: unknown): JobParse {
  const r = jobSchema.safeParse(bodyStrings(body));
  if (!r.success) return { ok: false, errors: fieldErrors(r.error) };
  const d = r.data;
  const after = parseAfterSync(d.after_sync, d.after_days, d.move_to, trimSlash(d.remote_path));
  if (!after.ok) return { ok: false, errors: after.errors };
  return { ok: true, data: {
    name: d.name, hostId: d.host_id, remotePath: trimSlash(d.remote_path), localPath: d.local_path, mode: d.mode, unitMode: d.unit_mode,
    afterSync: d.after_sync, afterDays: after.afterDays, moveTo: after.moveTo, verify: d.verify, settleSeconds: d.settle_seconds, minAgeSeconds: d.min_age_seconds, minSize: d.min_size,
    maxSize: d.max_size, includeGlobs: d.include_globs, excludeGlobs: d.exclude_globs, trustMtime: d.trust_mtime, enabled: d.enabled,
    bwlimitBps: d.bwlimit, parallelFiles: d.parallel_files, rangeStreams: d.range_streams, retries: d.retries, minFreeBytes: d.min_free_bytes,
    scheduleKind: d.schedule_kind, scheduleExpr: d.schedule_kind === "manual" ? null : d.schedule_expr, changedPolicy: d.changed_policy,
    confirmLedgerReset: d.confirm_ledger_reset,
  } };
}

const NO_HASH = ["ftp", "ftps_explicit", "ftps_implicit"];
export const hasNoHashes = (host: HostPublic | undefined): boolean => !!host && NO_HASH.includes(host.protocol);

/** Rules that need other data than the form: host, names, schedule. The local path is checked separately (async). */
export function crossValidate(d: JobFormData, host: HostPublic | undefined, nameTaken: boolean, tz: string | undefined): FormErrors {
  const errors: FormErrors = {};
  if (!host) errors["host_id"] = "Choose a host";
  if (nameTaken) errors["name"] = "A job with this name already exists";
  if (d.verify === "checksum" && hasNoHashes(host)) errors["verify"] = "Checksum verification is not available: FTP and FTPS servers provide no file hashes. Use size.";
  if (d.minSize !== null && d.maxSize !== null && d.minSize > d.maxSize) errors["max_size"] = "Maximum size must not be smaller than the minimum size";
  const sched = validateSchedule(d.scheduleKind, d.scheduleExpr, tz);
  if (!sched.ok) errors["schedule_expr"] = sched.error;
  return errors;
}

const KEYS = ["name", "host_id", "remote_path", "local_path", "mode", "unit_mode", "after_sync", "after_days", "move_to", "verify", "settle_seconds", "min_age_seconds",
  "min_size", "max_size", "include_globs", "exclude_globs", "parallel_files", "range_streams", "retries", "min_free_bytes", "bwlimit",
  "schedule_kind", "schedule_expr", "changed_policy"];

/** Submitted values for redisplay. */
export function jobValues(body: unknown): Record<string, string> {
  const b = bodyStrings(body);
  const out: Record<string, string> = Object.fromEntries(KEYS.map((k) => [k, b[k] ?? ""]));
  for (const k of ["trust_mtime", "enabled", "confirm_ledger_reset"]) out[k] = ["on", "1", "true"].includes(b[k] ?? "") ? "on" : "";
  return out;
}

export function jobToValues(j: JobConfig): Record<string, string> {
  return {
    name: j.name, host_id: String(j.hostId), remote_path: j.remotePath, local_path: j.localPath, mode: j.mode, unit_mode: j.unitMode,
    after_sync: j.afterSync, after_days: j.afterDays === null ? "" : String(j.afterDays), move_to: j.moveTo ?? "", verify: j.verify, settle_seconds: String(j.settleSeconds), min_age_seconds: String(j.minAgeSeconds),
    min_size: sizeToInput(j.minSize), max_size: sizeToInput(j.maxSize), include_globs: j.includeGlobs.join("\n"), exclude_globs: j.excludeGlobs.join("\n"),
    trust_mtime: j.trustMtime ? "on" : "", enabled: j.enabled ? "on" : "", confirm_ledger_reset: "", parallel_files: String(j.parallelFiles),
    range_streams: String(j.rangeStreams), retries: String(j.retries), min_free_bytes: sizeToInput(j.minFreeBytes),
    bwlimit: j.bwlimitBps === null ? "" : `${sizeToInput(j.bwlimitBps)}/s`, schedule_kind: j.scheduleKind, schedule_expr: j.scheduleExpr ?? "",
    changed_policy: j.changedPolicy,
  };
}

export const NEW_JOB_VALUES: Record<string, string> = {
  name: "", host_id: "", remote_path: "", local_path: "", mode: "copy_new", unit_mode: "top_dir", after_sync: "keep", after_days: "7", move_to: "", verify: "size",
  settle_seconds: "300", min_age_seconds: "0", min_size: "", max_size: "", include_globs: "", exclude_globs: DEFAULT_EXCLUDES.join("\n"),
  trust_mtime: "", enabled: "on", confirm_ledger_reset: "", parallel_files: "2", range_streams: "4", retries: "3", min_free_bytes: "",
  bwlimit: "", schedule_kind: "manual", schedule_expr: "", changed_policy: "skip",
};
