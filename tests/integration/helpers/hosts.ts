import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, compose, PORTS, type Service } from "./compose.js";
import type { HostConfig } from "../../../src/domain.js";

const KEY_DIR = path.join(ROOT, "tests/integration/docker/keys");

const base = { host: "127.0.0.1", authKind: "password" as const, hostKeys: null, maxConnections: 4 };

/** HostConfig fixtures for each test server. sftp host keys are null until `scanSftpHostKey()` fills them. */
export function testHosts(): Record<Service | "sftp-key", HostConfig> {
  return {
    ftp: { ...base, id: 1, name: "it-ftp", protocol: "ftp", port: PORTS.ftp, username: "testuser", secret: { password: "testpass" }, tlsAcceptSelfSigned: false },
    "ftps-explicit": { ...base, id: 2, name: "it-ftps-explicit", protocol: "ftps_explicit", port: PORTS["ftps-explicit"], username: "testuser", secret: { password: "testpass" }, tlsAcceptSelfSigned: true },
    "ftps-implicit": { ...base, id: 3, name: "it-ftps-implicit", protocol: "ftps_implicit", port: PORTS["ftps-implicit"], username: "vuser", secret: { password: "testpass" }, tlsAcceptSelfSigned: true },
    sftp: { ...base, id: 4, name: "it-sftp", protocol: "sftp", port: PORTS.sftp, username: "testuser", secret: { password: "testpass" }, tlsAcceptSelfSigned: false },
    "sftp-key": { ...base, id: 5, name: "it-sftp-key", protocol: "sftp", port: PORTS.sftp, username: "keyuser", authKind: "key", secret: { privateKey: readFileSync(path.join(KEY_DIR, "id_test"), "utf8") }, tlsAcceptSelfSigned: false },
  };
}

/** Read the live sftp server's ed25519 host key line (`ssh-ed25519 AAAA...`), as a host-key scan would pin it. */
export async function scanSftpHostKey(): Promise<string> {
  const { stdout } = await compose(["exec", "-T", "-u", "root", "sftp", "sh", "-c", "cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub"], 20_000);
  return stdout.trim();
}
