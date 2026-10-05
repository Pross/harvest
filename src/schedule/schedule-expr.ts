import { Cron } from "croner";
import cronstrue from "cronstrue";
import type { ScheduleKind } from "../domain.js";

export const MIN_INTERVAL_MS = 60_000;
/** 24 days: setTimeout clamps delays above 2^31-1 ms (about 24.8 days) to 1 ms, so longer intervals would fire constantly. */
export const MAX_INTERVAL_MS = 24 * 86_400_000;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const UNIT_NAME = { s: "second", m: "minute", h: "hour", d: "day" } as const;

export type ScheduleCheck = { ok: true; human: string; next: Date[] } | { ok: false; error: string };

/** `<n>(s|m|h|d)` to milliseconds. Throws on a bad format, an interval under 60 seconds or one over 24 days. */
export function parseInterval(expr: string): number {
  const m = /^(\d+)([smhd])$/.exec(expr.trim());
  if (!m) throw new Error(`invalid interval "${expr}": use <n>s, <n>m, <n>h or <n>d, for example 6h`);
  const ms = Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
  if (!Number.isSafeInteger(ms) || ms < MIN_INTERVAL_MS) throw new Error(`invalid interval "${expr}": the minimum is 60s`);
  if (ms > MAX_INTERVAL_MS) throw new Error(`invalid interval "${expr}": the maximum is 24d (use a cron expression for longer periods)`);
  return ms;
}

function intervalHuman(expr: string): string {
  const m = /^(\d+)([smhd])$/.exec(expr.trim())!;
  const n = Number(m[1]);
  const unit = UNIT_NAME[m[2] as keyof typeof UNIT_NAME];
  return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
}

/** Cron descriptions are cosmetic: a cronstrue failure on an expression croner accepts must not invalidate it. */
function describeCron(expr: string): string {
  try {
    return cronstrue.toString(expr, { use24HourTimeFormat: true });
  } catch {
    return expr;
  }
}

function cronCheck(expr: string, tz?: string): ScheduleCheck {
  const job = new Cron(expr, { timezone: tz, paused: true });
  try {
    const next = job.nextRuns(3);
    if (next.length === 0) return { ok: false, error: "schedule never fires" };
    for (let i = 1; i < next.length; i++) {
      if (next[i]!.getTime() - next[i - 1]!.getTime() < MIN_INTERVAL_MS) return { ok: false, error: "cron schedules may not fire more often than every 60 seconds" };
    }
    return { ok: true, human: describeCron(expr), next };
  } finally {
    job.stop();
  }
}

function intervalCheck(expr: string): ScheduleCheck {
  const ms = parseInterval(expr);
  const start = Date.now();
  return { ok: true, human: intervalHuman(expr), next: [1, 2, 3].map((i) => new Date(start + i * ms)) };
}

/** Validates a stored or submitted schedule. Never throws; returns the reason on failure. */
export function validateSchedule(kind: ScheduleKind, expr: string | null, tz?: string): ScheduleCheck {
  if (kind === "manual") return { ok: true, human: "manual only", next: [] };
  if (!expr || !expr.trim()) return { ok: false, error: "schedule expression is required" };
  try {
    return kind === "cron" ? cronCheck(expr.trim(), tz) : intervalCheck(expr);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
