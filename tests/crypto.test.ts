import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  constantTimeEqual, decryptSecret, encryptSecret, hashPassword, randomToken,
  resolveAppSecret, sha256Hex, verifyPassword,
} from "../src/crypto.js";

const KEY = "k".repeat(32);

describe("encryptSecret / decryptSecret", () => {
  it("round-trips including unicode and empty", () => {
    for (const pt of ["hunter2", "pässwörd-日本", "", "x".repeat(5000)]) {
      expect(decryptSecret(encryptSecret(pt, KEY), KEY)).toBe(pt);
    }
  });
  it("uses version byte and a fresh nonce", () => {
    const a = encryptSecret("same", KEY);
    const b = encryptSecret("same", KEY);
    expect(a[0]).toBe(1);
    expect(a.equals(b)).toBe(false);
    expect(a.length).toBe(1 + 12 + 16 + 4);
  });
  it("rejects wrong key", () => {
    expect(() => decryptSecret(encryptSecret("x", KEY), "z".repeat(32))).toThrow();
  });
  it("rejects tampering in nonce, tag and ciphertext", () => {
    const blob = encryptSecret("some secret", KEY);
    for (const i of [1, 13, 29, blob.length - 1]) {
      const t = Buffer.from(blob);
      t[i] = (t[i] ?? 0) ^ 0xff;
      expect(() => decryptSecret(t, KEY)).toThrow();
    }
  });
  it("rejects truncation and unknown version", () => {
    const blob = encryptSecret("some secret", KEY);
    expect(() => decryptSecret(blob.subarray(0, 20), KEY)).toThrow(/truncated/);
    expect(() => decryptSecret(blob.subarray(0, blob.length - 1), KEY)).toThrow();
    expect(() => decryptSecret(Buffer.alloc(0), KEY)).toThrow();
    const v = Buffer.from(blob);
    v[0] = 2;
    expect(() => decryptSecret(v, KEY)).toThrow(/version/);
  });
});

describe("resolveAppSecret", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "harvest-crypto-"));
  it("env wins and does not touch disk", () => {
    const dir = tmp();
    expect(resolveAppSecret({ env: KEY, configDir: dir })).toEqual({ secret: KEY, source: "env" });
    expect(fs.existsSync(path.join(dir, ".app_secret"))).toBe(false);
  });
  it("rejects a short env secret", () => {
    expect(() => resolveAppSecret({ env: "short", configDir: tmp() })).toThrow(/16/);
  });
  it("generates with mode 0600 then reads the file", () => {
    const dir = path.join(tmp(), "nested");
    const gen = resolveAppSecret({ configDir: dir });
    expect(gen.source).toBe("generated");
    expect(gen.secret).toMatch(/^[0-9a-f]{64}$/);
    const file = path.join(dir, ".app_secret");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(resolveAppSecret({ configDir: dir })).toEqual({ secret: gen.secret, source: "file" });
  });
  it("throws on a corrupt secret file", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".app_secret"), "tiny");
    expect(() => resolveAppSecret({ configDir: dir })).toThrow();
  });
});

describe("passwords", () => {
  it("hashes and verifies", async () => {
    const h = await hashPassword("correct horse");
    expect(h).toMatch(/^scrypt\$131072\$8\$1\$[^$]+\$[^$]+$/);
    expect(await verifyPassword("correct horse", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await hashPassword("correct horse")).not.toBe(h);
  });
  it("does not block the event loop while hashing", async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    await verifyPassword("pw", await hashPassword("pw"));
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(2);
  });
  it("returns false on malformed stored values", async () => {
    for (const s of ["", "garbage", "scrypt$1$2", "bcrypt$1$8$1$AA$AA", "scrypt$x$8$1$AA$AA",
      "scrypt$131072$8$1$$", "scrypt$99999999999$8$1$AA$AA", "scrypt$3$8$1$AA$AA"]) {
      expect(await verifyPassword("pw", s)).toBe(false);
    }
  });
});

describe("helpers", () => {
  it("randomToken is base64url and sized", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(8)).toHaveLength(11);
    expect(randomToken()).not.toBe(randomToken());
  });
  it("sha256Hex matches known vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("constantTimeEqual handles differing lengths", () => {
    expect(constantTimeEqual("a", "a")).toBe(true);
    expect(constantTimeEqual("a", "ab")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});
