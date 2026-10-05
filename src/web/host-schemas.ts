import { z } from "zod";
import type { HostConfig, Protocol } from "../domain.js";
import { AuthError, HostKeyChanged, PermanentError, TransientNetwork } from "../errors.js";
import type { HostPublic } from "../store/host-store.js";
import { safeSlice } from "./helpers.js";

export const ENABLED_PROTOCOLS = ["ftp", "ftps_explicit", "ftps_implicit", "sftp"] as const;
export const DEFAULT_PORTS: Record<string, number> = { ftp: 21, ftps_explicit: 21, ftps_implicit: 990, sftp: 22 };
export const PROTOCOL_OPTIONS: { value: string; label: string; disabled: boolean }[] = [
  { value: "ftp", label: "FTP (plain)", disabled: false },
  { value: "ftps_explicit", label: "FTPS (explicit TLS)", disabled: false },
  { value: "ftps_implicit", label: "FTPS (implicit TLS)", disabled: false },
  { value: "sftp", label: "SFTP (SSH)", disabled: false },
  { value: "rsync", label: "rsync (Phase 2)", disabled: true },
  { value: "scp", label: "scp (Phase 2)", disabled: true },
];

export type FormErrors = Record<string, string>;
export type HostSecret = HostConfig["secret"];

/** Only string values of a urlencoded body (arrays collapse to their first string). Everything else is dropped. */
export function bodyStrings(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof body !== "object" || body === null) return out;
  for (const [k, v] of Object.entries(body)) {
    const s = Array.isArray(v) ? v.find((x) => typeof x === "string") : v;
    if (typeof s === "string") out[k] = s;
  }
  return out;
}

/** First message per top-level field. */
export function fieldErrors(err: z.ZodError): FormErrors {
  const out: FormErrors = {};
  for (const issue of err.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] ??= issue.message;
  }
  return out;
}

/** Positive integer from a route param, or null. */
export function parseId(raw: string): number | null {
  return /^\d{1,9}$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
}

const text = z.string().default("");
const ranged = (min: number, max: number, msg: string) =>
  text.refine((s) => { const t = s.trim(); return t === "" || (/^\d+$/.test(t) && Number(t) >= min && Number(t) <= max); }, msg);

const hostSchema = z.object({
  name: text.pipe(z.string().trim().min(1, "Name is required").max(80, "Name is too long (80 characters max)")),
  protocol: z.enum(ENABLED_PROTOCOLS, { error: "Choose ftp, ftps_explicit, ftps_implicit or sftp (rsync and scp arrive in Phase 2)" }),
  host: text.pipe(z.string().trim().min(1, "Host is required").max(255, "Host is too long")
    .refine((h) => !h.startsWith("-"), "Host must not start with a dash")
    .regex(/^[A-Za-z0-9._:\-[\]]+$/, "Enter a host name or IP address, without a scheme or path")),
  port: ranged(1, 65535, "Port must be between 1 and 65535"),
  username: text.pipe(z.string().trim().min(1, "Username is required").max(255, "Username is too long")),
  auth_kind: z.enum(["password", "key"], { error: "Choose password or key" }).default("password"),
  password: text, private_key: text, key_passphrase: text,
  tls_accept_self_signed: text,
  max_connections: ranged(1, 32, "Max connections must be between 1 and 32"),
});

export type HostFormData = {
  name: string; protocol: Protocol; host: string; port: number; username: string; authKind: "password" | "key";
  tlsAcceptSelfSigned: boolean; maxConnections: number; password: string; privateKey: string; keyPassphrase: string;
};
export type HostParse = { ok: true; data: HostFormData } | { ok: false; errors: FormErrors };

export function parseHostForm(body: unknown): HostParse {
  const r = hostSchema.safeParse(bodyStrings(body));
  if (!r.success) return { ok: false, errors: fieldErrors(r.error) };
  const d = r.data;
  if (d.auth_kind === "key" && d.protocol !== "sftp") return { ok: false, errors: { auth_kind: "Key authentication is only available for SFTP" } };
  const port = d.port.trim() === "" ? DEFAULT_PORTS[d.protocol] ?? 22 : Number(d.port);
  return {
    ok: true,
    data: {
      name: d.name, protocol: d.protocol, host: d.host, port, username: d.username, authKind: d.auth_kind,
      tlsAcceptSelfSigned: ["on", "1", "true"].includes(d.tls_accept_self_signed), maxConnections: d.max_connections.trim() === "" ? 4 : Number(d.max_connections),
      password: d.password, privateKey: d.private_key.trim(), keyPassphrase: d.key_passphrase,
    },
  };
}

/** Non-secret values for redisplay after a failed submit (never passwords, keys or passphrases). */
export function hostValues(body: unknown): Record<string, string> {
  const b = bodyStrings(body);
  const keys = ["name", "protocol", "host", "port", "username", "auth_kind", "max_connections"];
  const out: Record<string, string> = Object.fromEntries(keys.map((k) => [k, b[k] ?? ""]));
  out["tls_accept_self_signed"] = ["on", "1", "true"].includes(b["tls_accept_self_signed"] ?? "") ? "on" : "";
  if (!out["auth_kind"]) out["auth_kind"] = "password";
  return out;
}

export function hostToValues(h: HostPublic): Record<string, string> {
  return {
    name: h.name, protocol: h.protocol, host: h.host, port: String(h.port), username: h.username, auth_kind: h.authKind,
    max_connections: String(h.maxConnections), tls_accept_self_signed: h.tlsAcceptSelfSigned ? "on" : "",
  };
}

export const NEW_HOST_VALUES: Record<string, string> = {
  name: "", protocol: "sftp", host: "", port: "22", username: "", auth_kind: "password", max_connections: "4", tls_accept_self_signed: "",
};

/**
 * Secret to store. `secret: undefined` means "keep what is stored". Stored values are carried over only when the
 * auth kind is unchanged; a new value posted for a field always wins.
 */
export function buildSecret(d: HostFormData, cur: HostConfig | null): { secret: HostSecret | undefined } | { errors: FormErrors } {
  const kindChanged = !!cur && cur.authKind !== d.authKind;
  const base: HostSecret = cur && !kindChanged ? cur.secret : {};
  const posted = d.authKind === "key" ? !!d.privateKey || !!d.keyPassphrase : !!d.password;
  if (d.authKind === "key" && !d.privateKey && !base.privateKey) {
    return { errors: { private_key: "Paste the private key (PEM)" } };
  }
  if (kindChanged && d.authKind === "password" && !d.password) return { errors: { password: "Enter the password (secrets are not carried over when the auth type changes)" } };
  if (cur && !kindChanged && !posted) return { secret: undefined };
  if (d.authKind === "password") return { secret: { password: d.password || base.password || "" } };
  return { secret: { privateKey: d.privateKey || base.privateKey, keyPassphrase: d.keyPassphrase || base.keyPassphrase } };
}

export type ErrorKind = "auth" | "hostkey" | "network" | "permanent" | "unknown";

const secretFragments = (secret: HostSecret): string[] => {
  const parts = [secret.password, secret.keyPassphrase, ...(secret.privateKey?.split(/\r?\n/) ?? [])];
  return parts.filter((p): p is string => !!p && p.length >= 3).sort((a, b) => b.length - a.length);
};

/** One short line: first line only, secrets and credential-looking tokens masked, control characters removed. */
export function sanitizeSummary(message: string, secret: HostSecret): string {
  let s = (message.split(/\r?\n/)[0] ?? "").replace(/[\u0000-\u001f\u007f]/g, " ");
  for (const frag of secretFragments(secret)) s = s.split(frag).join("***");
  s = s.replace(/(pass(?:word|phrase)?|secret|token|key)([=:]\s*)\S+/gi, "$1$2***");
  return safeSlice(s.trim(), 160);
}

/** Maps typed engine errors to a friendly message without leaking secrets or raw stderr. */
export function friendlyConnectionError(err: unknown, secret: HostSecret): { kind: ErrorKind; message: string } {
  const detail = err instanceof Error ? sanitizeSummary(err.message, secret) : "";
  const suffix = detail ? ` (${detail})` : "";
  if (err instanceof AuthError) return { kind: "auth", message: "Authentication failed: check the username and the password or key." };
  if (err instanceof HostKeyChanged) {
    return { kind: "hostkey", message: "The server's host key does not match the pinned key. This can mean the server was reinstalled, or that someone is intercepting the connection. Nothing was changed." };
  }
  if (err instanceof TransientNetwork) return { kind: "network", message: `Could not reach the server: network error, timeout or connection limit. Try again shortly${suffix}.` };
  if (err instanceof PermanentError) return { kind: "permanent", message: `The server refused the request${suffix}.` };
  return { kind: "unknown", message: "The connection test failed unexpectedly. Check the logs for details." };
}
