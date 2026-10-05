import { openDb, type DB } from "../../src/db.js";
import { createStores } from "../../src/store/index.js";

export const crypto = {
  encrypt: (plain: string): Buffer => Buffer.from(`ENC:${Buffer.from(plain).toString("base64")}`),
  decrypt: (blob: Buffer): string => Buffer.from(blob.toString().slice(4), "base64").toString(),
};

export function setup() {
  const db: DB = openDb(":memory:", new URL("../../src/migrations", import.meta.url).pathname);
  const stores = createStores(db, crypto);
  const hostId = stores.hosts.create({ name: "h", protocol: "sftp", host: "example.com", port: 22, username: "u", secret: { password: "pw" } });
  const jobId = stores.jobs.create({ name: "j", hostId, remotePath: "/r", localPath: "/l" });
  return { db, stores, hostId, jobId };
}

export const file = (remotePath: string, size = 10) => ({ remotePath, size, mtimeMs: 1000 });
