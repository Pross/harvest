import { z } from "zod";

/**
 * Time-of-day bandwidth profiles. Times are wall-clock in the SERVER's local timezone (the process `TZ`
 * environment variable, e.g. `TZ=Europe/London`; UTC when unset). Days are 0=Sunday .. 6=Saturday.
 */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const time = z.string().regex(HHMM, "Use a 24-hour time like 08:30.");

export const BwProfileSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1, "Pick at least one day.").max(7)
    .refine((d) => new Set(d).size === d.length, "Each day may appear only once."),
  from: time,
  /** May be earlier than `from`: the window then wraps past midnight into the next day. */
  to: time,
  bps: z.number().int().positive().nullable(),
}).refine((p) => p.from !== p.to, { path: ["to"], message: "Start and end must differ." });

export const BW_PROFILES_MAX = 20;
export const BwProfilesSchema = z.array(BwProfileSchema).max(BW_PROFILES_MAX, `Use at most ${BW_PROFILES_MAX} profiles.`);

export type BwProfile = z.infer<typeof BwProfileSchema>;
export type BwSettings = { bwlimitGlobalBps: number | null; bwProfiles: readonly BwProfile[] };

const minutesOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Does the profile cover this local weekday and minute-of-day? A wrapping window's after-midnight part belongs to the NEXT day. */
function covers(p: BwProfile, day: number, minute: number): boolean {
  const from = minutesOf(p.from);
  const to = minutesOf(p.to);
  if (from < to) return p.days.includes(day) && minute >= from && minute < to;
  if (p.days.includes(day) && minute >= from) return true;
  return p.days.includes((day + 6) % 7) && minute < to;
}

/** The global rate (bytes/s, null = unlimited) at `now`: the first matching profile wins, else the base limit. */
export function resolveGlobalRate(settings: BwSettings, now: Date): number | null {
  const day = now.getDay();
  const minute = now.getHours() * 60 + now.getMinutes();
  const hit = settings.bwProfiles.find((p) => covers(p, day, minute));
  return hit ? hit.bps : settings.bwlimitGlobalBps;
}

/** Epoch ms of the next profile start or end strictly after `now` (local time), or null when there are no profiles. */
export function nextBoundary(profiles: readonly BwProfile[], now: Date): number | null {
  let best: number | null = null;
  for (let offset = 0; offset <= 7; offset++) {
    for (const p of profiles) {
      for (const t of [p.from, p.to]) {
        const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, Math.floor(minutesOf(t) / 60), minutesOf(t) % 60, 0, 0).getTime();
        if (at > now.getTime() && (best === null || at < best)) best = at;
      }
    }
  }
  return best;
}
