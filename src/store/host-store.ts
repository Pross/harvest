import type { DB } from "../db.js";
import type { HostConfig, Protocol } from "../domain.js";
import { HostInUseError } from "./errors.js";

export type Crypto = { encrypt: (plain: string) => Buffer; decrypt: (blob: Buffer) => string };
export type HostSecret = HostConfig["secret"];
/** A host as the UI may see it: never any secret material. */
export type HostPublic = Omit<HostConfig, "secret"> & { hasSecret: boolean; hostKeySha256: string | null };
export type HostInput = {
  name: string; protocol: Protocol; host: string; port: number; username: string;
  authKind?: "password" | "key"; secret?: HostSecret; tlsAcceptSelfSigned?: boolean; maxConnections?: number;
};

type HostSql = {
  id: number; name: string; protocol: Protocol; host: string; port: number; username: string; secret_enc: Buffer | null;
  auth_kind: "password" | "key"; tls_accept_self_signed: number; host_keys: string | null; host_key_sha256: string | null; max_connections: number;
};

function toPublic(r: HostSql): HostPublic {
  return {
    id: r.id, name: r.name, protocol: r.protocol, host: r.host, port: r.port, username: r.username, authKind: r.auth_kind,
    tlsAcceptSelfSigned: r.tls_accept_self_signed === 1, hostKeys: r.host_keys, hostKeySha256: r.host_key_sha256,
    maxConnections: r.max_connections, hasSecret: r.secret_enc !== null,
  };
}

const hasMaterial = (s: HostSecret | undefined): s is HostSecret => !!s && Object.values(s).some((v) => v !== undefined && v !== "");

export class SqliteHostStore {
  constructor(private readonly db: DB, private readonly crypto: Crypto) {}

  private row(id: number): HostSql | undefined {
    return this.db.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as HostSql | undefined;
  }

  create(input: HostInput): number {
    const now = Date.now();
    const enc = hasMaterial(input.secret) ? this.crypto.encrypt(JSON.stringify(input.secret)) : null;
    const res = this.db.prepare(
      `INSERT INTO hosts (name, protocol, host, port, username, secret_enc, auth_kind, tls_accept_self_signed, max_connections, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.name, input.protocol, input.host, input.port, input.username, enc, input.authKind ?? "password",
      input.tlsAcceptSelfSigned ? 1 : 0, input.maxConnections ?? 4, now, now);
    return Number(res.lastInsertRowid);
  }

  /** Updates the given fields. The stored secret is kept unless `secret` carries new material. */
  update(id: number, patch: Partial<HostInput>): void {
    const cur = this.row(id);
    if (!cur) throw new Error(`host ${id} not found`);
    const enc = hasMaterial(patch.secret) ? this.crypto.encrypt(JSON.stringify(patch.secret)) : cur.secret_enc;
    this.db.prepare(
      `UPDATE hosts SET name = ?, protocol = ?, host = ?, port = ?, username = ?, secret_enc = ?, auth_kind = ?,
         tls_accept_self_signed = ?, max_connections = ?, updated_at = ? WHERE id = ?`,
    ).run(patch.name ?? cur.name, patch.protocol ?? cur.protocol, patch.host ?? cur.host, patch.port ?? cur.port,
      patch.username ?? cur.username, enc, patch.authKind ?? cur.auth_kind,
      patch.tlsAcceptSelfSigned === undefined ? cur.tls_accept_self_signed : patch.tlsAcceptSelfSigned ? 1 : 0,
      patch.maxConnections ?? cur.max_connections, Date.now(), id);
  }

  /** Throws HostInUseError (naming the jobs) while any job still uses the host. */
  delete(id: number): void {
    const jobs = this.db.prepare("SELECT name FROM jobs WHERE host_id = ? ORDER BY name").all(id) as { name: string }[];
    if (jobs.length > 0) throw new HostInUseError(id, jobs.map((j) => j.name));
    this.db.prepare("DELETE FROM hosts WHERE id = ?").run(id);
  }

  setHostKeys(id: number, keys: string | null, sha256: string | null): void {
    const res = this.db.prepare("UPDATE hosts SET host_keys = ?, host_key_sha256 = ?, updated_at = ? WHERE id = ?").run(keys, sha256, Date.now(), id);
    if (res.changes === 0) throw new Error(`host ${id} not found`);
  }

  getPublic(id: number): HostPublic | undefined {
    const r = this.row(id);
    return r && toPublic(r);
  }

  listPublic(): HostPublic[] {
    return (this.db.prepare("SELECT * FROM hosts ORDER BY name").all() as HostSql[]).map(toPublic);
  }

  /** Decrypted domain object. In-memory use only; never log or send to the UI. */
  getConfig(id: number): HostConfig {
    const r = this.row(id);
    if (!r) throw new Error(`host ${id} not found`);
    const secret: HostSecret = r.secret_enc ? (JSON.parse(this.crypto.decrypt(r.secret_enc)) as HostSecret) : {};
    const { hasSecret: _h, hostKeySha256: _s, ...rest } = toPublic(r);
    return { ...rest, secret };
  }
}
