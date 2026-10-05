import { beforeEach, describe, expect, it } from "vitest";
import { PermanentError } from "../../src/errors.js";
import { buildRemote, clearObscureCache, obscure } from "../../src/engine/rclone-remote.js";
import { FAKE_RCLONE, callsTo, host, makeTmp } from "./helpers.js";

const P = "RCLONE_CONFIG_H1_";
let tmp: string;
const deps = () => ({ rclone: FAKE_RCLONE, tmpDir: tmp });
beforeEach(() => { tmp = makeTmp(); clearObscureCache(); });

describe("buildRemote", () => {
  it("builds an ftp remote with the password obscured via stdin", async () => {
    const r = await buildRemote(host(), deps());
    expect(r.name).toBe("H1");
    expect(r.fs).toBe("H1:");
    expect(r.env).toEqual({
      [`${P}TYPE`]: "ftp", [`${P}HOST`]: "ftp.example.com", [`${P}PORT`]: "21",
      [`${P}USER`]: "alice", [`${P}PASS`]: "obscured:hunter2-secret",
    });
    const [call] = callsTo(tmp, "obscure");
    expect(call!.argv).toEqual(["obscure", "-"]);
    expect(call!.stdin).toBe("hunter2-secret");
    expect(call!.argv.join(" ")).not.toContain("hunter2");
  });

  it("caches obscured values per secret", async () => {
    await buildRemote(host(), deps());
    await buildRemote(host({ id: 2 }), deps());
    expect(callsTo(tmp, "obscure")).toHaveLength(1);
  });

  it("sets TLS options for ftps variants", async () => {
    const ex = await buildRemote(host({ protocol: "ftps_explicit" }), deps());
    expect(ex.env[`${P}EXPLICIT_TLS`]).toBe("true");
    expect(ex.env[`${P}TLS`]).toBeUndefined();
    expect(ex.env[`${P}NO_CHECK_CERTIFICATE`]).toBeUndefined();
    const im = await buildRemote(host({ protocol: "ftps_implicit", tlsAcceptSelfSigned: true }), deps());
    expect(im.env[`${P}TLS`]).toBe("true");
    expect(im.env[`${P}NO_CHECK_CERTIFICATE`]).toBe("true");
  });

  it("builds an sftp remote with pinned host keys", async () => {
    const r = await buildRemote(host({ protocol: "sftp", port: 22, hostKeys: "ssh-ed25519 AAAA\nssh-rsa BBBB" }), deps());
    expect(r.env[`${P}TYPE`]).toBe("sftp");
    expect(r.env[`${P}SHELL_TYPE`]).toBe("unix");
    expect(r.env[`${P}SKIP_LINKS`]).toBe("true");
    expect(r.env[`${P}HOST_KEYS`]).toBe("ssh-ed25519 AAAA,ssh-rsa BBBB");
  });

  it("uses a single-line PEM and an obscured passphrase for key auth", async () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----\n";
    const r = await buildRemote(host({ protocol: "sftp", hostKeys: "ssh-ed25519 AAAA", authKind: "key", secret: { privateKey: pem, keyPassphrase: "pp" } }), deps());
    expect(r.env[`${P}KEY_PEM`]).toBe("-----BEGIN OPENSSH PRIVATE KEY-----\\nabc\\ndef\\n-----END OPENSSH PRIVATE KEY-----");
    expect(r.env[`${P}KEY_PEM`]).not.toContain("\n");
    expect(r.env[`${P}KEY_FILE_PASS`]).toBe("obscured:pp");
    expect(r.env[`${P}PASS`]).toBeUndefined();
    for (const c of callsTo(tmp, "obscure")) expect(c.argv).toEqual(["obscure", "-"]);
  });

  it("refuses an sftp host without pinned keys unless the test path allows it", async () => {
    const h = host({ protocol: "sftp", port: 22, hostKeys: null });
    await expect(buildRemote(h, deps())).rejects.toThrow(/host key not pinned: pin it on the host page/);
    await expect(buildRemote(h, deps())).rejects.toBeInstanceOf(PermanentError);
    await expect(buildRemote(host({ protocol: "sftp", hostKeys: "  \n" }), deps())).rejects.toBeInstanceOf(PermanentError);
    const open = await buildRemote(h, deps(), { allowUnpinned: true });
    expect(open.env[`${P}HOST_KEYS`]).toBeUndefined();
  });

  it("omits PASS for an empty password and bounds the obscure cache", async () => {
    const r = await buildRemote(host({ secret: { password: "" } }), deps());
    expect(r.env[`${P}PASS`]).toBeUndefined();
    expect(callsTo(tmp, "obscure")).toHaveLength(0);
    for (let i = 0; i < 70; i++) await obscure(`secret-${i}`, deps());
    await obscure("secret-0", deps()); // evicted by now: spawns again
    expect(callsTo(tmp, "obscure")).toHaveLength(71);
    await obscure("secret-69", deps()); // still cached
    expect(callsTo(tmp, "obscure")).toHaveLength(71);
  });

  it("rejects rsync and scp with PermanentError", async () => {
    await expect(buildRemote(host({ protocol: "rsync" }), deps())).rejects.toBeInstanceOf(PermanentError);
    await expect(buildRemote(host({ protocol: "scp" }), deps())).rejects.toBeInstanceOf(PermanentError);
  });
});
