import pino from "pino";
import type { DestinationStream } from "pino";

const SECRET_KEYS = [
  "secret",
  "password",
  "pass",
  "passphrase",
  "privateKey",
  "keyPassphrase",
  "secret_enc",
  "APP_SECRET",
  "ADMIN_PASS",
  "token",
  "authorization",
  "cookie",
];

// Top-level keys, one level of nesting via wildcard, plus explicit header paths.
export const REDACT_PATHS: string[] = [
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((k) => `*.${k}`),
  ...SECRET_KEYS.map((k) => `*.*.${k}`),
  "headers.authorization",
  "headers.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
];

/**
 * App logger. stdout only (docker logs); pretty-printed in development.
 * An optional destination stream is accepted for tests.
 */
export function buildLogger(level: string, prettyInDev: boolean, destination?: DestinationStream) {
  const opts = { level, redact: { paths: REDACT_PATHS, censor: "[redacted]" } };
  if (destination) return pino(opts, destination);
  if (prettyInDev) {
    return pino({
      ...opts,
      transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l" } },
    });
  }
  return pino(opts);
}

export type Logger = ReturnType<typeof buildLogger>;

/** Drops query string and fragment (webhook tokens may travel there). */
export function redactUrl(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}
