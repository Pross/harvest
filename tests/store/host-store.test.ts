import { describe, expect, it } from "vitest";
import { HostInUseError } from "../../src/store/errors.js";
import { setup } from "./helpers.js";

const input = { name: "box", protocol: "sftp" as const, host: "h.example", port: 22, username: "me" };

describe("host store", () => {
  it("stores the secret encrypted and getConfig decrypts it", () => {
    const { db, stores } = setup();
    const id = stores.hosts.create({ ...input, secret: { password: "hunter2", keyPassphrase: "pp" } });
    const raw = (db.prepare("SELECT secret_enc FROM hosts WHERE id = ?").get(id) as { secret_enc: Buffer }).secret_enc;
    expect(Buffer.isBuffer(raw)).toBe(true);
    expect(raw.toString()).not.toContain("hunter2");
    expect(stores.hosts.getConfig(id)).toMatchObject({ id, name: "box", secret: { password: "hunter2", keyPassphrase: "pp" }, hostKeys: null });
  });

  it("public views never include secret material", () => {
    const { stores } = setup();
    const id = stores.hosts.create({ ...input, authKind: "key", secret: { privateKey: "-----BEGIN KEY-----", password: "hunter2" } });
    const json = JSON.stringify([stores.hosts.getPublic(id), stores.hosts.listPublic()]);
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("BEGIN KEY");
    expect(json).not.toContain("secret");
    expect(stores.hosts.getPublic(id)).toMatchObject({ hasSecret: true, authKind: "key" });
  });

  it("hasSecret is false without a secret and getConfig returns an empty secret", () => {
    const { stores } = setup();
    const id = stores.hosts.create(input);
    expect(stores.hosts.getPublic(id)!.hasSecret).toBe(false);
    expect(stores.hosts.getConfig(id).secret).toEqual({});
  });

  it("update without a secret keeps the old secret", () => {
    const { stores } = setup();
    const id = stores.hosts.create({ ...input, secret: { password: "old" } });
    stores.hosts.update(id, { port: 2222, secret: {} });
    stores.hosts.update(id, { host: "new.example" });
    expect(stores.hosts.getConfig(id)).toMatchObject({ port: 2222, host: "new.example", secret: { password: "old" } });
  });

  it("update with a new secret replaces it", () => {
    const { stores } = setup();
    const id = stores.hosts.create({ ...input, secret: { password: "old" } });
    stores.hosts.update(id, { secret: { password: "new" } });
    expect(stores.hosts.getConfig(id).secret).toEqual({ password: "new" });
  });

  it("update patches booleans and throws for unknown hosts", () => {
    const { stores } = setup();
    const id = stores.hosts.create(input);
    stores.hosts.update(id, { tlsAcceptSelfSigned: true, maxConnections: 8 });
    expect(stores.hosts.getPublic(id)).toMatchObject({ tlsAcceptSelfSigned: true, maxConnections: 8 });
    stores.hosts.update(id, { tlsAcceptSelfSigned: false });
    expect(stores.hosts.getPublic(id)!.tlsAcceptSelfSigned).toBe(false);
    expect(() => stores.hosts.update(999, { port: 1 })).toThrow();
  });

  it("setHostKeys pins keys and fingerprint", () => {
    const { stores } = setup();
    const id = stores.hosts.create(input);
    stores.hosts.setHostKeys(id, "ssh-ed25519 AAAA", "SHA256:xyz");
    expect(stores.hosts.getConfig(id).hostKeys).toBe("ssh-ed25519 AAAA");
    expect(stores.hosts.getPublic(id)!.hostKeySha256).toBe("SHA256:xyz");
    expect(() => stores.hosts.setHostKeys(999, "k", "s")).toThrow();
  });

  it("getConfig throws for an unknown host; getPublic returns undefined", () => {
    const { stores } = setup();
    expect(() => stores.hosts.getConfig(999)).toThrow();
    expect(stores.hosts.getPublic(999)).toBeUndefined();
  });

  it("rejects duplicate names and deletes", () => {
    const { stores } = setup();
    const id = stores.hosts.create(input);
    expect(() => stores.hosts.create(input)).toThrow();
    stores.hosts.delete(id);
    expect(stores.hosts.getPublic(id)).toBeUndefined();
  });
});

describe("host store delete guard", () => {
  it("throws a typed error naming the jobs that use the host", () => {
    const { stores, hostId } = setup();
    stores.jobs.create({ name: "second", hostId, remotePath: "/a", localPath: "/b" });
    let err: unknown;
    try { stores.hosts.delete(hostId); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HostInUseError);
    expect((err as HostInUseError).jobNames).toEqual(["j", "second"]);
    expect(stores.hosts.getPublic(hostId)).toBeDefined();
  });
});
