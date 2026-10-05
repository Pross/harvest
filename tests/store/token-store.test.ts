import { describe, expect, it } from "vitest";
import { hashToken } from "../../src/store/index.js";
import { setup } from "./helpers.js";

describe("token store", () => {
  it("creates base64url tokens of 32 bytes and stores only the hash", () => {
    const { stores, jobId, db } = setup();
    const { token, record } = stores.tokens.create(jobId, "qbit");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(record.id) as { token_hash: string };
    expect(row.token_hash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("verifies, rejects unknown tokens and records last use", () => {
    const { stores, jobId } = setup();
    const { token, record } = stores.tokens.create(jobId, "a");
    expect(stores.tokens.verify(token)?.id).toBe(record.id);
    expect(stores.tokens.verify(token + "x")).toBeUndefined();
    stores.tokens.touch(record.id, 5000);
    expect(stores.tokens.listForJob(jobId)[0]?.lastUsedAt).toBe(5000);
  });

  it("revokes only within its job and cascades on job delete", () => {
    const { stores, jobId, hostId, db } = setup();
    const other = stores.jobs.create({ name: "k", hostId, remotePath: "/r2", localPath: "/l2" });
    const { token, record } = stores.tokens.create(jobId, "a");
    expect(stores.tokens.revoke(other, record.id)).toBe(false);
    expect(stores.tokens.verify(token)).toBeDefined();
    db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
    expect(stores.tokens.verify(token)).toBeUndefined();
  });
});
