import { createHash } from "node:crypto";
import type { HostConfig } from "../domain.js";
import { PermanentError } from "../errors.js";
import { normalizeStoredHostKeys } from "./hostkeys.js";
import { runPlain, type ProcessDeps } from "./rclone-process.js";

export type Remote = { name: string; fs: string; env: Record<string, string> };
export type RemoteDeps = ProcessDeps;

const OBSCURE_TIMEOUT_MS = 15_000;
/** Obscured values cached in memory per secret, so a run does not respawn `rclone obscure` per session. */
const obscureCache = new Map<string, string>();
const OBSCURE_CACHE_MAX = 64;
const cacheKey = (secret: string): string => createHash("sha256").update(secret).digest("hex");

/** `rclone obscure -`: the secret goes through STDIN, never argv. */
export async function obscure(secret: string, deps: RemoteDeps): Promise<string> {
  const key = cacheKey(secret);
  const hit = obscureCache.get(key);
  if (hit !== undefined) return hit;
  const res = await runPlain(deps, ["obscure", "-"], { stdin: secret, timeoutMs: OBSCURE_TIMEOUT_MS });
  const value = res.stdout.trim();
  if (res.code !== 0 || value === "") throw new PermanentError("rclone obscure failed");
  if (obscureCache.size >= OBSCURE_CACHE_MAX) obscureCache.delete(obscureCache.keys().next().value as string);
  obscureCache.set(key, value);
  return value;
}

/** Test hook: forget cached obscured secrets. */
export function clearObscureCache(): void {
  obscureCache.clear();
}

function ftpOptions(host: HostConfig, set: (k: string, v: string) => void): void {
  if (host.protocol === "ftps_explicit") set("EXPLICIT_TLS", "true");
  if (host.protocol === "ftps_implicit") set("TLS", "true");
  if (host.protocol !== "ftp" && host.tlsAcceptSelfSigned) set("NO_CHECK_CERTIFICATE", "true");
}

async function sftpOptions(host: HostConfig, set: (k: string, v: string) => void, deps: RemoteDeps, allowUnpinned: boolean): Promise<void> {
  set("SHELL_TYPE", "unix");
  set("SKIP_LINKS", "true");
  // Fresh config per spawn: without these rclone probes the server for md5sum/sha1sum on every command (~1.65 s each).
  set("MD5SUM_COMMAND", "none");
  set("SHA1SUM_COMMAND", "none");
  const keys = host.hostKeys ? normalizeStoredHostKeys(host.hostKeys) : "";
  if (keys !== "") set("HOST_KEYS", keys);
  else if (!allowUnpinned) throw new PermanentError("host key not pinned: pin it on the host page");
  if (host.authKind !== "key") return;
  const pem = host.secret.privateKey;
  if (!pem) throw new PermanentError("key authentication selected but no private key stored");
  set("KEY_PEM", pem.trim().replace(/\r?\n/g, "\\n")); // single line, literal \n
  if (host.secret.keyPassphrase) set("KEY_FILE_PASS", await obscure(host.secret.keyPassphrase, deps));
}

/** Env-defined remote `H<id>`: option names follow rclone's `RCLONE_CONFIG_<REMOTE>_<OPTION>` mapping. */
export type BuildOptions = {
  /** ONLY for the connection test, which has to connect to scan the host keys. Never for runs, browsing or maintenance. */
  allowUnpinned?: boolean;
};

export async function buildRemote(host: HostConfig, deps: RemoteDeps, opts: BuildOptions = {}): Promise<Remote> {
  const type = host.protocol === "sftp" ? "sftp" : host.protocol.startsWith("ftp") ? "ftp" : null;
  if (type === null) throw new PermanentError(`protocol ${host.protocol} is not supported by the rclone engine (Phase 2)`);
  const name = `H${host.id}`;
  const env: Record<string, string> = {};
  const set = (key: string, value: string) => { env[`RCLONE_CONFIG_${name}_${key}`] = value; };
  set("TYPE", type);
  set("HOST", host.host);
  set("PORT", String(host.port));
  set("USER", host.username);
  if (host.authKind === "password") {
    if (host.secret.password === undefined) throw new PermanentError("password authentication selected but no password stored");
    if (host.secret.password !== "") set("PASS", await obscure(host.secret.password, deps));
  }
  if (type === "ftp") ftpOptions(host, set);
  else await sftpOptions(host, set, deps, opts.allowUnpinned === true);
  return { name, fs: `${name}:`, env };
}
