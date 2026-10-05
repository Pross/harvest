import { describe, expect, it } from "vitest";
import type { HostConfig } from "../../src/domain.js";
import type { EngineSession, RemoteEntry, TransferEngine } from "../../src/engine/types.js";
import { checkStoredSecrets, UNDECRYPTABLE_MESSAGE } from "../../src/web/host-config.js";
import { MAX_BROWSE_ENTRIES, registerBrowseRoutes } from "../../src/web/routes-browse.js";
import { registerHostRoutes } from "../../src/web/routes-hosts.js";
import { makeHarness, req, session, type Harness } from "./harness.js";

class Engine implements TransferEngine {
  readonly id = "rclone" as const;
  readonly capabilities = { hash: false, parallelRanges: true };
  tested: HostConfig[] = [];
  entries: RemoteEntry[] = [];
  testConnection(h: HostConfig) {
    this.tested.push(h);
    return Promise.resolve({ ok: true as const, rootListing: [] });
  }
  async open(): Promise<EngineSession> {
    return { list: async () => this.entries, close: async () => {} } as unknown as EngineSession;
  }
}

const SECRET_PW = "s3cret-pw-value";
let broken = false;
const crypto = {
  encrypt: (p: string) => Buffer.from(p),
  decrypt: (b: Buffer) => { if (broken) throw new Error("Unsupported state or unable to authenticate data"); return b.toString(); },
};

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const base = { name: "box", protocol: "ftp", host: "ftp.example.org", port: "21", username: "bob", auth_kind: "password" };

async function setup() {
  broken = false;
  const h: Harness = await makeHarness({ routes: [registerHostRoutes, registerBrowseRoutes], crypto });
  const engine = new Engine();
  h.deps.engine = engine;
  const hostId = h.deps.stores.hosts.create({ name: "box", protocol: "ftp", host: "ftp.example.org", port: 21, username: "bob", secret: { password: SECRET_PW } });
  const s = await session(h);
  const post = (url: string, data: Record<string, string>) =>
    req(h, { method: "POST", url, sid: s.sid, payload: form({ _csrf: s.csrf, ...data }), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const get = (url: string) => req(h, { method: "GET", url, sid: s.sid });
  return { h, engine, hostId, post, get };
}

describe("undecryptable stored credentials (APP_SECRET changed)", () => {
  it("shows a banner on the list and the form instead of failing with 500", async () => {
    const c = await setup();
    broken = true;
    const list = await c.get("/hosts");
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain(UNDECRYPTABLE_MESSAGE);
    expect(list.body).toContain("credentials unreadable");
    const edit = await c.get(`/hosts/${c.hostId}`);
    expect(edit.statusCode).toBe(200);
    expect(edit.body).toContain(UNDECRYPTABLE_MESSAGE);
  });

  it("answers the saved-host test and the browser with a friendly message", async () => {
    const c = await setup();
    broken = true;
    const t = await c.post(`/hosts/${c.hostId}/test`, {});
    expect(t.statusCode).toBe(200);
    expect(t.body).toContain("cannot be decrypted");
    expect(c.engine.tested).toHaveLength(0);
    const b = await c.get(`/browse/remote?host=${c.hostId}&path=%2F`);
    expect(b.statusCode).toBe(200);
    expect(b.body).toContain("cannot be decrypted");
    const pin = await c.post(`/hosts/${c.hostId}/pin`, { fingerprint: "SHA256:x" });
    expect(pin.statusCode).toBe(303);
  });

  it("requires a new password on update, then overwrites the unreadable secret", async () => {
    const c = await setup();
    broken = true;
    const missing = await c.post(`/hosts/${c.hostId}`, { ...base, name: "box2" });
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toContain(UNDECRYPTABLE_MESSAGE);
    const saved = await c.post(`/hosts/${c.hostId}`, { ...base, password: "fresh-password" });
    expect(saved.statusCode).toBe(303);
    broken = false;
    expect(c.h.deps.stores.hosts.getConfig(c.hostId).secret.password).toBe("fresh-password");
  });

  it("tests an unsaved edit only with a newly posted password", async () => {
    const c = await setup();
    broken = true;
    const none = await c.post("/hosts/test", { ...base, id: String(c.hostId) });
    expect(none.body).toContain("cannot be decrypted");
    expect(c.engine.tested).toHaveLength(0);
    await c.post("/hosts/test", { ...base, id: String(c.hostId), password: "typed-now" });
    expect(c.engine.tested[0]?.secret.password).toBe("typed-now");
  });

  it("logs one warning at startup without the secret", async () => {
    const c = await setup();
    broken = true;
    expect(checkStoredSecrets(c.h.deps)).toBe(1);
    const logs = c.h.logs.join("");
    expect(logs).toContain("cannot be decrypted");
    expect(logs).not.toContain(SECRET_PW);
  });
});

describe("POST /hosts/test with a stored password", () => {
  it("reuses the stored password for the same host, port and username", async () => {
    const c = await setup();
    await c.post("/hosts/test", { ...base, id: String(c.hostId) });
    expect(c.engine.tested[0]?.secret.password).toBe(SECRET_PW);
  });

  it.each([["host", "evil.example.net"], ["port", "2121"], ["username", "mallory"]])(
    "never sends the stored password to a changed %s", async (field, value) => {
      const c = await setup();
      const res = await c.post("/hosts/test", { ...base, id: String(c.hostId), [field]: value });
      expect(c.engine.tested).toHaveLength(0);
      expect(res.body).toContain("Enter the password");
      await c.post("/hosts/test", { ...base, id: String(c.hostId), [field]: value, password: "typed" });
      expect(c.engine.tested[0]?.secret.password).toBe("typed");
    });
});

describe("remote browse cap", () => {
  it("lists at most 500 entries and says how many are hidden", async () => {
    const c = await setup();
    c.engine.entries = Array.from({ length: 600 }, (_, i) => ({ path: `d${String(i).padStart(3, "0")}`, size: 0, mtimeMs: null, isDir: true }));
    const res = await c.get(`/browse/remote?host=${c.hostId}&path=%2F`);
    expect(res.body.match(/<li>/g)).toHaveLength(MAX_BROWSE_ENTRIES);
    expect(res.body).toContain("and 100 more not shown");
  });
});
