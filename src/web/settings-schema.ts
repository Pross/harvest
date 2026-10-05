import { z } from "zod";
import type { DB } from "../db.js";
import { BwProfilesSchema, type BwProfile } from "../run/bandwidth.js";
import type { Logger } from "../logger.js";
import type { Stores } from "../store/index.js";

/** Keys in the `settings` table. Each value is zod-validated JSON. */
export const SETTINGS_KEYS = {
  bwlimitGlobalBps: "bwlimit_global_bps",
  retention: "retention",
  bwProfiles: "bw_profiles",
} as const;

export const BwlimitSchema = z.number().int().positive().nullable();

export const RetentionSchema = z.object({
  activityDays: z.number().int().min(1).max(3650).default(90),
  runDays: z.number().int().min(1).max(3650).default(180),
  observationDays: z.number().int().min(1).max(3650).default(30),
  stagingDays: z.number().int().min(1).max(3650).default(7),
});

export type Retention = z.infer<typeof RetentionSchema>;
export type AppSettings = { bwlimitGlobalBps: number | null; bwProfiles: BwProfile[]; retention: Retention };

export const DEFAULT_SETTINGS: AppSettings = {
  bwlimitGlobalBps: null,
  bwProfiles: [],
  retention: { activityDays: 90, runDays: 180, observationDays: 30, stagingDays: 7 },
};

/** Fully defaulted settings. A missing key yields its default; corrupt JSON or an invalid value throws. */
export function readSettings(stores: Pick<Stores, "settings">): AppSettings {
  const bw = stores.settings.getJson(SETTINGS_KEYS.bwlimitGlobalBps, BwlimitSchema);
  const retention = stores.settings.getJson(SETTINGS_KEYS.retention, RetentionSchema);
  const bwProfiles = stores.settings.getJson(SETTINGS_KEYS.bwProfiles, BwProfilesSchema);
  return {
    bwlimitGlobalBps: bw ?? DEFAULT_SETTINGS.bwlimitGlobalBps,
    bwProfiles: bwProfiles ?? [],
    retention: retention ?? { ...DEFAULT_SETTINGS.retention },
  };
}

/** Boot-time read: corrupt stored settings log a warning and fall back to defaults so the app still starts. */
export function readSettingsOrDefault(stores: Pick<Stores, "settings">, logger: Pick<Logger, "warn">): AppSettings {
  try {
    return readSettings(stores);
  } catch (err) {
    logger.warn({ err }, "Stored settings are invalid; using defaults");
    return DEFAULT_SETTINGS;
  }
}

/** All keys are written in one transaction: a failure leaves neither changed. */
export function writeSettings(db: DB, stores: Pick<Stores, "settings">, s: AppSettings): void {
  const bw = BwlimitSchema.parse(s.bwlimitGlobalBps);
  const retention = RetentionSchema.parse(s.retention);
  const profiles = BwProfilesSchema.parse(s.bwProfiles);
  db.transaction(() => {
    stores.settings.setJson(SETTINGS_KEYS.bwProfiles, profiles);
    stores.settings.setJson(SETTINGS_KEYS.bwlimitGlobalBps, bw);
    stores.settings.setJson(SETTINGS_KEYS.retention, retention);
  })();
}

const RATE_UNITS: Record<string, number> = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
const RATE_RE = /^(\d+(?:\.\d+)?)\s*([kmg]?)(?:i?b)?(?:\/s|ps)?$/i;

/** "10M", "500 KiB/s", "1.5g", "2048" (bytes/s). Blank means unlimited (null). Returns undefined when invalid or not positive. */
export function parseRate(input: string): number | null | undefined {
  const text = input.trim();
  if (text === "") return null;
  const m = RATE_RE.exec(text);
  if (!m) return undefined;
  const bps = Math.round(Number(m[1]) * (RATE_UNITS[(m[2] ?? "").toLowerCase()] ?? 1));
  return Number.isSafeInteger(bps) && bps > 0 ? bps : undefined;
}

/** Inverse of parseRate for redisplay: "10M" when exact, else bytes. */
export function formatRateInput(bps: number | null): string {
  if (bps === null) return "";
  for (const [suffix, size] of [["G", 1024 ** 3], ["M", 1024 ** 2], ["K", 1024]] as const) {
    if (bps % size === 0) return `${bps / size}${suffix}`;
  }
  return String(bps);
}
