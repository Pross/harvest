import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

const VERSION = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 1 + NONCE_LEN + TAG_LEN;
const HKDF_SALT = "harvest.app-secret.salt.v1";
const HKDF_INFO = "harvest.credentials.aes-256-gcm.v1";
const MIN_SECRET_LEN = 16;

function deriveKey(appSecret: string): Buffer {
  if (!appSecret) throw new Error("APP_SECRET is empty");
  return Buffer.from(hkdfSync("sha256", appSecret, HKDF_SALT, HKDF_INFO, 32));
}

/** Blob layout: version(1) | nonce(12) | tag(16) | ciphertext. */
export function encryptSecret(plaintext: string, appSecret: string): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(appSecret), nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), ct]);
}

export function decryptSecret(blob: Buffer, appSecret: string): string {
  if (blob.length < HEADER_LEN) throw new Error("Encrypted secret is truncated");
  if (blob[0] !== VERSION) throw new Error(`Unknown encrypted secret version ${blob[0]}`);
  const nonce = blob.subarray(1, 1 + NONCE_LEN);
  const tag = blob.subarray(1 + NONCE_LEN, HEADER_LEN);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(appSecret), nonce);
  decipher.setAuthTag(tag);
  // final() throws on a wrong key or any tampering.
  const pt = Buffer.concat([decipher.update(blob.subarray(HEADER_LEN)), decipher.final()]);
  return pt.toString("utf8");
}

export interface ResolvedSecret {
  secret: string;
  source: "env" | "file" | "generated";
}

export function resolveAppSecret(opts: { env?: string; configDir: string }): ResolvedSecret {
  if (opts.env) {
    if (opts.env.length < MIN_SECRET_LEN) {
      throw new Error(`APP_SECRET must be at least ${MIN_SECRET_LEN} characters`);
    }
    return { secret: opts.env, source: "env" };
  }
  const file = path.join(opts.configDir, ".app_secret");
  if (fs.existsSync(file)) {
    const secret = fs.readFileSync(file, "utf8").trim();
    if (secret.length < MIN_SECRET_LEN) throw new Error(`${file} holds an invalid secret`);
    return { secret, source: "file" };
  }
  const secret = randomBytes(32).toString("hex");
  fs.mkdirSync(opts.configDir, { recursive: true });
  fs.writeFileSync(file, secret + "\n", { mode: 0o600, flag: "wx" });
  fs.chmodSync(file, 0o600);
  return { secret, source: "generated" };
}

const SCRYPT_N = 131072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const maxmem = (n: number, r: number) => 256 * n * r;

type ScryptOpts = { N: number; r: number; p: number; maxmem: number };
const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, keylen: number, opts: ScryptOpts) => Promise<Buffer>;

/** Async scrypt (runs on the libuv thread pool), so a login attempt never blocks the event loop. */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pw, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: maxmem(SCRYPT_N, SCRYPT_R),
  });
  const b64 = (b: Buffer) => b.toString("base64");
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${b64(salt)}$${b64(hash)}`;
}

/** Resolves false (never rejects) on a wrong password or a malformed stored value. */
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = [parts[1], parts[2], parts[3]].map(Number) as [number, number, number];
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expected = Buffer.from(parts[5] ?? "", "base64");
  if (![N, r, p].every((x) => Number.isInteger(x) && x > 0) || N > 2 ** 20) return false;
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await scryptAsync(pw, salt, expected.length, { N, r, p, maxmem: maxmem(N, r) });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
