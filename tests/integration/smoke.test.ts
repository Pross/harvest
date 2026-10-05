import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import { COMPOSE_FILE, PORTS, composeDown, composeUp, dockerAvailable, exec, waitForAll, type Service } from "./helpers/compose.js";
import { scanSftpHostKey, testHosts } from "./helpers/hosts.js";
import { MiniFtp, type FtpMode } from "./helpers/miniftp.js";
import { pseudoRandom, seedFiles, sha256, REMOTE_ROOT } from "./helpers/seed.js";

const SIZE = 300_000;
const OFFSET = 123_457;
const COUNT = 50_000;
const FTP_SERVERS: Array<[Service, FtpMode, string]> = [
  ["ftp", "plain", "testuser"],
  ["ftps-explicit", "explicit", "testuser"],
  ["ftps-implicit", "implicit", "vuser"],
];

describe.skipIf(!dockerAvailable())("integration stack smoke", () => {
  beforeAll(async () => {
    await composeUp();
    await waitForAll();
    await seedFiles("ftp", { "smoke/data.bin": SIZE });
    await seedFiles("sftp", { "smoke/data.bin": SIZE });
  }, 300_000);

  afterAll(async () => {
    await composeDown();
  }, 120_000);

  const expected = pseudoRandom("smoke/data.bin", SIZE).subarray(OFFSET, OFFSET + COUNT);

  it.each(FTP_SERVERS)("%s: lists and reads a byte range over its own protocol", async (service, mode, user) => {
    const c = await MiniFtp.connect(mode, PORTS[service]);
    try {
      await c.login(user, "testpass");
      expect(await c.list("smoke")).toContain("data.bin");
      const got = await c.readRange("smoke/data.bin", OFFSET, COUNT);
      expect(sha256(got)).toBe(sha256(expected));
    } finally {
      c.close();
    }
  });

  it("sftp: banner, scanned host key, seeded file listed and range readable", async () => {
    const banner = await new Promise<string>((resolve, reject) => {
      const s = net.connect({ host: "127.0.0.1", port: PORTS.sftp });
      s.setTimeout(10_000, () => s.destroy(new Error("banner timeout")));
      s.once("data", (d) => { s.destroy(); resolve(d.toString()); });
      s.once("error", reject);
    });
    expect(banner).toMatch(/^SSH-2\.0-OpenSSH/);
    expect(await scanSftpHostKey()).toMatch(/^ssh-ed25519 \S+$/);
    expect(testHosts().sftp.port).toBe(2222);
    const dir = `${REMOTE_ROOT.sftp}/smoke`;
    expect(await exec("sftp", ["ls", dir])).toContain("data.bin");
    const range = await exec("sftp", ["sh", "-c", `tail -c +${OFFSET + 1} ${dir}/data.bin | head -c ${COUNT} | sha256sum`]);
    expect(range.split(" ")[0]).toBe(sha256(expected));
  });

  it("compose file path resolves", () => {
    expect(COMPOSE_FILE.endsWith("docker-compose.test.yml")).toBe(true);
  });
});
