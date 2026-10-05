import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TransientNetwork } from "../../src/errors.js";
import { defaultExec, fingerprint, normalizeStoredHostKeys, parseKeyScan, scanHostKeys, toRcloneHostKeys } from "../../src/engine/hostkeys.js";
import { makeTmp } from "./helpers.js";

// ed25519 host key taken from the S4 spike log.
const ED = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKr6R2pxi4+vrVW3VjbAIRQAY0/DUKXPYhtH7OaERU/U";
const scan = `# sftp:22 SSH-2.0-OpenSSH_9.2\nsftp ${ED}\n# sftp:22 SSH-2.0-OpenSSH_9.2\nsftp ${ED}\n[sftp]:2222 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC7\n`;

describe("hostkeys", () => {
  it("computes the same fingerprint as ssh-keygen -lf", () => {
    const file = join(makeTmp(), "k.pub");
    writeFileSync(file, `${ED} comment\n`);
    const out = execFileSync("ssh-keygen", ["-lf", file], { encoding: "utf8" });
    const expected = /(SHA256:\S+)/.exec(out)![1];
    expect(fingerprint(ED.split(" ")[1]!)).toBe(expected);
  });

  it("parses ssh-keyscan output, skips comments and duplicates", () => {
    const keys = parseKeyScan(scan);
    expect(keys.map((k) => k.type)).toEqual(["ssh-ed25519", "ssh-rsa"]);
    expect(keys[0]!.line).toBe(ED);
    expect(keys[0]!.sha256).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it("joins keys with commas and caps at 16", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ type: "t", line: `t K${i}`, sha256: "x" }));
    expect(toRcloneHostKeys(many.slice(0, 1))).toBe("t K0");
    expect(toRcloneHostKeys(many).split(",")).toHaveLength(16);
    expect(normalizeStoredHostKeys("a b\n# c\n\nd e")).toBe("a b,d e");
  });

  it("runs ssh-keyscan with timeout and port", async () => {
    let seen: string[] = [];
    const keys = await scanHostKeys("sftp.example.com", 2222, {
      timeoutSec: 7,
      exec: async (cmd, args) => { seen = [cmd, ...args]; return scan; },
    });
    expect(seen).toEqual(["ssh-keyscan", "-T", "7", "-p", "2222", "sftp.example.com"]);
    expect(keys).toHaveLength(2);
  });

  it("fails with a typed error on empty output or exec failure", async () => {
    await expect(scanHostKeys("h", 22, { timeoutSec: 1, exec: async () => "# nothing\n" })).rejects.toBeInstanceOf(TransientNetwork);
    await expect(scanHostKeys("h", 22, { timeoutSec: 1, exec: async () => { throw new Error("x"); } })).rejects.toBeInstanceOf(TransientNetwork);
    await expect(scanHostKeys("-oProxyCommand=x", 22, { timeoutSec: 1 })).rejects.toThrow(/invalid host/);
  });

  it("runs ssh-keyscan with a clean environment (PATH only)", async () => {
    process.env.APP_SECRET = "must-not-leak";
    const out = await defaultExec("/usr/bin/env", []);
    expect(out).not.toContain("must-not-leak");
    expect(out).toMatch(/^PATH=/m);
  });
});
