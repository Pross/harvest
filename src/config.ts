import { isIP } from "node:net";
import path from "node:path";
import { z, ZodError } from "zod";

const TRUE_TOKENS = ["true", "1", "yes", "on"];
const FALSE_TOKENS = ["false", "0", "no", "off"];

// z.coerce.boolean() does Boolean(value), so "false" would become true. Parse tokens explicitly and leave
// anything unknown as the raw string so zod rejects it (a typo like "ture" must not silently mean false).
export function envBool(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim().toLowerCase();
  if (t === "") return undefined;
  if (TRUE_TOKENS.includes(t)) return true;
  if (FALSE_TOKENS.includes(t)) return false;
  return v;
}

const BOOL_ERROR = "must be true or false (also accepted: 1, 0, yes, no, on, off)";

/** Fastify `trustProxy` value: false, true (unsafe unless the proxy overwrites X-Forwarded-For), a hop count, or trusted addresses. */
export type TrustProxy = boolean | number | string[];

const NAMED_RANGES = ["loopback", "linklocal", "uniquelocal"];

function validTrustEntry(e: string): boolean {
  if (NAMED_RANGES.includes(e)) return true;
  const [addr, prefix, extra] = e.split("/");
  const kind = isIP(addr ?? "");
  if (kind === 0 || extra !== undefined) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (kind === 4 ? 32 : 128);
}

/** "false" | "true" | hop count ("1") | comma-separated IPs/CIDRs ("172.18.0.0/16,10.0.0.1"). Anything else is left raw for zod to reject. */
export function parseTrustProxy(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim().toLowerCase();
  if (t === "") return undefined;
  if (TRUE_TOKENS.includes(t) && t !== "1") return true;
  if (FALSE_TOKENS.includes(t) && t !== "0") return false;
  if (/^\d{1,3}$/.test(t)) return Number(t) === 0 ? false : Number(t);
  const list = v.split(",").map((x) => x.trim()).filter(Boolean);
  return list.length > 0 && list.every(validTrustEntry) ? list : v;
}

const trustProxyVar = z.preprocess(
  parseTrustProxy,
  z.union([z.boolean(), z.number().int().min(1).max(100), z.array(z.string())], {
    error: "must be false, true, a hop count such as 1, or a comma-separated list of proxy IPs/CIDRs",
  }).default(false),
);

// Unraid passes unset template variables as "". Treat blank as absent so the
// default (or optional) applies, for every kind of variable.
const blankToUndef = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;
const orBlank = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndef, schema);
const boolVar = (def: boolean) => z.preprocess(envBool, z.boolean({ error: BOOL_ERROR }).default(def));
const intVar = (def: number, min = 1, max = Number.MAX_SAFE_INTEGER) =>
  orBlank(z.coerce.number().int().min(min).max(max).default(def));
const csv = (v: unknown): unknown =>
  typeof v === "string"
    ? v.split(",").map((s) => s.trim()).filter(Boolean)
    : v;

const Schema = z.object({
  PORT: intVar(8099, 0, 65535),
  HOST: orBlank(z.string().default("0.0.0.0")),
  APP_SECRET: orBlank(z.string().optional()),
  CONFIG_DIR: orBlank(z.string().default("./config")),
  BROWSE_ROOTS: z.preprocess(
    (v) => csv(blankToUndef(v)),
    z.array(z.string().min(1)).default(["/data"]),
  ),
  AUTH_MODE: orBlank(z.enum(["builtin", "none"]).default("builtin")),
  ADMIN_USER: orBlank(z.string().min(1).optional()),
  ADMIN_PASS: orBlank(z.string().min(8, "ADMIN_PASS must be at least 8 characters").optional()),
  COOKIE_SECURE: boolVar(false),
  METRICS_ENABLED: boolVar(false),
  TRUST_PROXY: trustProxyVar,
  PUBLIC_URL: orBlank(
    z.url({ protocol: /^https?$/, error: "PUBLIC_URL must be an http(s) URL" })
      .transform((u) => u.replace(/\/+$/, ""))
      .optional(),
  ),
  ALLOWED_HOSTS: z.preprocess((v) => csv(blankToUndef(v)), z.array(z.string().min(1)).optional()),
  MAX_CONCURRENT_RUNS: intVar(2),
  MAX_CONCURRENT_FILES: intVar(4),
  RCLONE_BIN: orBlank(z.string().default("rclone")),
  RANGE_MIN_BYTES: intVar(268_435_456),
  CHECKPOINT_BYTES: intVar(16_777_216),
  STALL_TIMEOUT_SECONDS: intVar(120),
  CONNECT_TIMEOUT_SECONDS: intVar(30),
  LOG_LEVEL: orBlank(
    z.enum(["silent", "fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  ),
  TZ: orBlank(z.string().optional()),
  NODE_ENV: orBlank(z.enum(["development", "test", "production"]).default("production")),
});

export type Config = z.infer<typeof Schema> & {
  dbPath: string;
  tmpDir: string;
  logDir: string;
};

export class ConfigError extends Error {
  constructor(message: string, public readonly hints: string[]) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = Schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(formatIssues(result.error), buildHints(result.error));
  }
  const parsed = result.data;
  const configDir = path.resolve(parsed.CONFIG_DIR);
  return {
    ...parsed,
    CONFIG_DIR: configDir,
    dbPath: path.join(configDir, "db", "harvest.db"),
    tmpDir: path.join(configDir, "tmp"),
    logDir: path.join(configDir, "logs"),
  };
}

function formatIssues(err: ZodError): string {
  return err.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}

const HINTS: Record<string, string> = {
  PORT: "PORT must be an integer from 0 to 65535.",
  AUTH_MODE: "AUTH_MODE must be 'builtin' or 'none'.",
  ADMIN_PASS: "ADMIN_PASS is only needed on first run; when set it needs 8 or more characters.",
  PUBLIC_URL: "PUBLIC_URL looks like https://harvest.example.com (no path required).",
  LOG_LEVEL: "LOG_LEVEL is one of silent, fatal, error, warn, info, debug, trace.",
  NODE_ENV: "NODE_ENV is one of development, test, production.",
  COOKIE_SECURE: "COOKIE_SECURE must be true or false.",
  TRUST_PROXY: "TRUST_PROXY is false (default), a hop count like 1, or a comma-separated list of proxy IPs/CIDRs. 'true' trusts any X-Forwarded-For.",
  BROWSE_ROOTS: "BROWSE_ROOTS is a comma-separated list of container paths, e.g. /data,/media.",
};

function buildHints(err: ZodError): string[] {
  const keys = new Set(err.issues.map((i) => String(i.path[0] ?? "")));
  const hints = [...keys].flatMap((k) => (HINTS[k] ? [HINTS[k]] : []));
  hints.push("Numeric variables must be positive integers; leave a variable empty to use its default.");
  return hints;
}

/** Human-readable multi-line message for startup failures. */
export function formatConfigError(err: ConfigError): string {
  const hints = err.hints.map((h) => `  * ${h}`).join("\n");
  return `Invalid configuration:\n${err.message}\n\nHints:\n${hints}`;
}
