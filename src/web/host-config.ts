import type { HostConfig } from "../domain.js";
import type { Logger } from "../logger.js";
import type { Stores } from "../store/index.js";
import { buildSecret, type FormErrors, type HostFormData, type HostSecret } from "./host-schemas.js";

export const UNDECRYPTABLE_MESSAGE = "Stored credentials cannot be decrypted: APP_SECRET changed. Re-enter them.";

/** A stored host config, or the marker for a secret that the current APP_SECRET cannot open (or that is corrupt). */
export type LoadedConfig = { undecryptable: false; cfg: HostConfig } | { undecryptable: true };

/** Wraps `hosts.getConfig`: a decrypt failure becomes a marker instead of a 500. Logs the error name only, never the secret. */
export function loadHostConfig(deps: { stores: Pick<Stores, "hosts">; logger: Logger }, id: number): LoadedConfig {
  try {
    return { undecryptable: false, cfg: deps.stores.hosts.getConfig(id) };
  } catch (err) {
    deps.logger.warn({ hostId: id, errorName: err instanceof Error ? err.name : "unknown" }, "Host credentials cannot be decrypted");
    return { undecryptable: true };
  }
}

/** Startup check: warns once when any stored host credentials do not decrypt with the current APP_SECRET. */
export function checkStoredSecrets(deps: { stores: Pick<Stores, "hosts">; logger: Logger }): number {
  const bad = deps.stores.hosts.listPublic().filter((h) => h.hasSecret && loadHostConfig(deps, h.id).undecryptable);
  if (bad.length > 0) {
    deps.logger.warn({ hosts: bad.map((h) => h.name) }, "Stored host credentials cannot be decrypted: APP_SECRET changed or the database came from another install. Re-enter them in the UI");
  }
  return bad.length;
}

/** True when the form changed the connection target, so a stored secret must not be sent to the new address. */
export function targetChanged(cur: Pick<HostConfig, "protocol" | "host" | "port" | "username">, d: HostFormData): boolean {
  return cur.protocol !== d.protocol || cur.host !== d.host || cur.port !== d.port || cur.username !== d.username;
}

/** Secret to save on update. When the stored one is unreadable a new value must be posted; it then replaces it. */
export function secretForUpdate(d: HostFormData, stored: LoadedConfig): { secret: HostSecret | undefined } | { errors: FormErrors } {
  if (!stored.undecryptable) return buildSecret(d, stored.cfg);
  const posted = d.authKind === "key" ? !!d.privateKey : !!d.password;
  if (!posted) return { errors: { [d.authKind === "key" ? "private_key" : "password"]: UNDECRYPTABLE_MESSAGE } };
  return buildSecret(d, null);
}
