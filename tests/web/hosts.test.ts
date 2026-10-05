import { describe, expect, it } from "vitest";
import type { EngineSession, RemoteEntry, ScannedHostKey, TransferEngine } from "../../src/engine/types.js";
import type { HostConfig } from "../../src/domain.js";
import { AuthError, HostKeyChanged, PermanentError, TransientNetwork } from "../../src/errors.js";
import { registerBrowseRoutes } from "../../src/web/routes-browse.js";
import { registerHostRoutes } from "../../src/web/routes-hosts.js";
import { registerJobRoutes } from "../../src/web/routes-jobs.js";
import { makeHarness, req, session, type Harness } from "./harness.js";

type TestResult = { ok: true; rootListing: RemoteEntry[]; hostKeys?: ScannedHostKey[] };

export class FakeEngine implements TransferEngine {
  readonly id = "rclone" as const;
  readonly capabilities = { hash: false, parallelRanges: true };
  lastHost: HostConfig | undefined;
  calls = 0;
  onTest: (h: HostConfig) => Promise<TestResult> = async () => ({ ok: true, rootListing: [] });
  testConnection(host: HostConfig): Promise<TestResult> {
    this.lastHost = host;
    this.calls++;
    return this.onTest(host);
  }
  open(): Promise<EngineSession> {
    return Promise.reject(new Error("not used"));
  }
}

const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACDsecretsecretsecretsecretsecretsecretXX\n-----END OPENSSH PRIVATE KEY-----";
const KEYS: ScannedHostKey[] = [
  { type: "ssh-ed25519", line: "host ssh-ed25519 AAAAC3Nza", sha256: "SHA256:aaaaFINGERPRINTed25519" },
  { type: "ssh-rsa", line: "host ssh-rsa AAAAB3Nza", sha256: "SHA256:bbbbFINGERPRINTrsa" },
];

const form = (o: Record<string, string | string[]>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
  return p.toString();
};

type Ctx = { h: Harness; sid: string; csrf: string; engine: FakeEngine };
async function setup(): Promise<Ctx> {
  const h = await makeHarness({ routes: [registerHostRoutes, registerJobRoutes, registerBrowseRoutes] });
  const engine = new FakeEngine();
  h.deps.engine = engine;
  return { h, engine, ...(await session(h)) };
}
const post = (c: Ctx, url: string, data: Record<string, string | string[]> = {}, headers: Record<string, string> = {}) =>
  req(c.h, { method: "POST", url, sid: c.sid, payload: form({ _csrf: c.csrf, ...data }), headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });
const get = (c: Ctx, url: string) => req(c.h, { method: "GET", url, sid: c.sid });
const HX = { "hx-request": "true" };

export function flashOf(res: { cookies: { name: string; value: string }[] }): string {
  let v = res.cookies.find((c) => c.name === "harvest_flash")?.value ?? "";
  for (let i = 0; i < 3 && v.includes("%"); i++) v = decodeURIComponent(v);
  return v;
}

const HOST = { name: "Seedbox", protocol: "sftp", host: "seed.example.org", port: "22", username: "alice", auth_kind: "password", password: "pw-S3CRET-value", max_connections: "4" };

describe("hosts CRUD", () => {
  it("lists nothing at first and requires a session", async () => {
    const c = await setup();
    expect((await get(c, "/hosts")).body).toContain("No hosts yet");
    const anon = await req(c.h, { method: "GET", url: "/hosts" });
    expect(anon.statusCode).toBe(303);
  });

  it("creates a host and stores the secret encrypted-side only", async () => {
    const c = await setup();
    const res = await post(c, "/hosts", HOST);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/hosts/1");
    const cfg = c.h.deps.stores.hosts.getConfig(1);
    expect(cfg).toMatchObject({ name: "Seedbox", protocol: "sftp", host: "seed.example.org", port: 22, username: "alice", maxConnections: 4 });
    expect(cfg.secret.password).toBe("pw-S3CRET-value");
  });

  it.each([["ftp", "21"], ["ftps_explicit", "21"], ["ftps_implicit", "990"], ["sftp", "22"]])("defaults the port for %s to %s", async (protocol, port) => {
    const c = await setup();
    await post(c, "/hosts", { ...HOST, protocol, port: "" });
    expect(c.h.deps.stores.hosts.getPublic(1)?.port).toBe(Number(port));
  });

  it.each(["telnet", "", "rsync", "scp"])("rejects protocol %j", async (protocol) => {
    const c = await setup();
    const res = await post(c, "/hosts", { ...HOST, protocol });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("field-error");
    expect(c.h.deps.stores.hosts.listPublic()).toHaveLength(0);
  });

  it.each(["0", "65536", "abc", "-1", "22.5"])("rejects port %j", async (port) => {
    const c = await setup();
    const res = await post(c, "/hosts", { ...HOST, port });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Port must be between 1 and 65535");
  });

  it("accepts the port bounds 1 and 65535", async () => {
    const c = await setup();
    expect((await post(c, "/hosts", { ...HOST, port: "1" })).statusCode).toBe(303);
    expect((await post(c, "/hosts", { ...HOST, name: "b", port: "65535" })).statusCode).toBe(303);
  });

  it("enforces max_connections 1..32 and defaults blank to 4", async () => {
    const c = await setup();
    for (const bad of ["0", "33", "x"]) {
      const res = await post(c, "/hosts", { ...HOST, max_connections: bad });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("Max connections must be between 1 and 32");
    }
    await post(c, "/hosts", { ...HOST, max_connections: "32" });
    await post(c, "/hosts", { ...HOST, name: "two", max_connections: "" });
    expect(c.h.deps.stores.hosts.getPublic(1)?.maxConnections).toBe(32);
    expect(c.h.deps.stores.hosts.getPublic(2)?.maxConnections).toBe(4);
  });

  it("requires name, host and username and redisplays what was typed", async () => {
    const c = await setup();
    const res = await post(c, "/hosts", { ...HOST, name: "", host: "", username: "", password: "pw-S3CRET-value" });
    expect(res.statusCode).toBe(400);
    for (const m of ["Name is required", "Host is required", "Username is required"]) expect(res.body).toContain(m);
    const typed = await post(c, "/hosts", { ...HOST, host: "bad host!" });
    expect(typed.body).toContain("Enter a host name or IP address");
    expect(typed.body).toContain('value="Seedbox"');
  });

  it("rejects duplicate names", async () => {
    const c = await setup();
    await post(c, "/hosts", HOST);
    const res = await post(c, "/hosts", { ...HOST, name: "seedbox" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("already exists");
  });

  it("limits key authentication to SFTP and needs a PEM", async () => {
    const c = await setup();
    const ftp = await post(c, "/hosts", { ...HOST, protocol: "ftp", auth_kind: "key", private_key: PEM });
    expect(ftp.body).toContain("only available for SFTP");
    const none = await post(c, "/hosts", { ...HOST, auth_kind: "key", password: "" });
    expect(none.statusCode).toBe(400);
    expect(none.body).toContain("Paste the private key");
    const ok = await post(c, "/hosts", { ...HOST, auth_kind: "key", private_key: PEM, key_passphrase: "pp-PHRASE-1" });
    expect(ok.statusCode).toBe(303);
    expect(c.h.deps.stores.hosts.getConfig(1).secret).toEqual({ privateKey: PEM, keyPassphrase: "pp-PHRASE-1" });
  });

  it("never renders secrets back, on any page or error re-render", async () => {
    const c = await setup();
    await post(c, "/hosts", { ...HOST, auth_kind: "key", private_key: PEM, key_passphrase: "pp-PHRASE-1" });
    const pages = [await get(c, "/hosts"), await get(c, "/hosts/1"), await get(c, "/hosts/new")];
    pages.push(await post(c, "/hosts/1", { ...HOST, auth_kind: "key", port: "99999", private_key: PEM, key_passphrase: "pp-PHRASE-1", password: "pw-S3CRET-value" }));
    pages.push(await post(c, "/hosts", { ...HOST, port: "0", password: "pw-S3CRET-value" }));
    for (const p of pages) {
      for (const secret of ["pw-S3CRET-value", "pp-PHRASE-1", "secretsecretsecret", "BEGIN OPENSSH"]) {
        if (secret === "BEGIN OPENSSH" && p.body.includes("placeholder=\"-----BEGIN OPENSSH PRIVATE KEY-----\"")) continue;
        expect(p.body).not.toContain(secret);
      }
    }
    expect(pages[1]?.body).toContain("unchanged");
  });

  it("keeps the stored secret when the update posts none, and overwrites when one is posted", async () => {
    const c = await setup();
    await post(c, "/hosts", HOST);
    const keep = await post(c, "/hosts/1", { ...HOST, name: "Renamed", password: "" });
    expect(keep.statusCode).toBe(303);
    expect(c.h.deps.stores.hosts.getConfig(1)).toMatchObject({ name: "Renamed", secret: { password: "pw-S3CRET-value" } });
    await post(c, "/hosts/1", { ...HOST, name: "Renamed", password: "brand-new-pw" });
    expect(c.h.deps.stores.hosts.getConfig(1).secret.password).toBe("brand-new-pw");
  });

  it("keeps the PEM when only the passphrase is replaced", async () => {
    const c = await setup();
    await post(c, "/hosts", { ...HOST, auth_kind: "key", private_key: PEM, key_passphrase: "old-phrase" });
    await post(c, "/hosts/1", { ...HOST, auth_kind: "key", private_key: "", key_passphrase: "new-phrase", password: "" });
    expect(c.h.deps.stores.hosts.getConfig(1).secret).toEqual({ privateKey: PEM, keyPassphrase: "new-phrase" });
  });

  it("requires a new secret when the auth kind changes", async () => {
    const c = await setup();
    await post(c, "/hosts", HOST);
    const res = await post(c, "/hosts/1", { ...HOST, auth_kind: "key", password: "" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Paste the private key");
    expect(c.h.deps.stores.hosts.getPublic(1)?.authKind).toBe("password");
  });

  it("shows the edit form with 404 for unknown ids and 400 on invalid update", async () => {
    const c = await setup();
    await post(c, "/hosts", HOST);
    expect((await get(c, "/hosts/1")).body).toContain("Edit host");
    expect((await get(c, "/hosts/99")).statusCode).toBe(404);
    expect((await get(c, "/hosts/abc")).statusCode).toBe(404);
    expect((await post(c, "/hosts/99", HOST)).statusCode).toBe(404);
    expect((await post(c, "/hosts/1", { ...HOST, port: "0" })).statusCode).toBe(400);
  });

  it("renders the self-signed warning and greys out rsync and scp", async () => {
    const c = await setup();
    const body = (await get(c, "/hosts/new")).body;
    expect(body).toContain("rclone cannot pin a certificate: this trusts any certificate");
    expect(body).toMatch(/<option value="rsync" disabled/);
    expect(body).toMatch(/<option value="scp" disabled/);
    expect(body).toContain('name="max_connections"');
  });

  it("stores the self-signed flag only when ticked", async () => {
    const c = await setup();
    await post(c, "/hosts", { ...HOST, protocol: "ftps_explicit", tls_accept_self_signed: "on" });
    await post(c, "/hosts", { ...HOST, name: "b", protocol: "ftps_explicit" });
    expect(c.h.deps.stores.hosts.getPublic(1)?.tlsAcceptSelfSigned).toBe(true);
    expect(c.h.deps.stores.hosts.getPublic(2)?.tlsAcceptSelfSigned).toBe(false);
  });

  it("deletes a host without jobs and refuses one with jobs", async () => {
    const c = await setup();
    await post(c, "/hosts", HOST);
    await post(c, "/hosts", { ...HOST, name: "Other" });
    c.h.deps.stores.jobs.create({ name: "j", hostId: 1, remotePath: "/r", localPath: "/l" });
    const refused = await post(c, "/hosts/1/delete");
    expect(refused.statusCode).toBe(303);
    expect(flashOf(refused)).toContain("used by 1 job");
    expect(c.h.deps.stores.hosts.getPublic(1)).toBeDefined();
    const ok = await post(c, "/hosts/2/delete");
    expect(flashOf(ok)).toContain("deleted");
    expect(c.h.deps.stores.hosts.getPublic(2)).toBeUndefined();
    expect((await post(c, "/hosts/2/delete")).statusCode).toBe(404);
  });

  it("lists protocol, address, user, key status and job count", async () => {
    const c = await setup();
    await post(c, "/hosts", HOST);
    await post(c, "/hosts", { ...HOST, name: "plain", protocol: "ftp", port: "21" });
    c.h.deps.stores.jobs.create({ name: "j", hostId: 1, remotePath: "/r", localPath: "/l" });
    let body = (await get(c, "/hosts")).body;
    expect(body).toContain("seed.example.org:22");
    expect(body).toContain("alice");
    expect(body).toContain("not pinned");
    c.h.deps.stores.hosts.setHostKeys(1, "k", "SHA256:pinnedfp");
    body = (await get(c, "/hosts")).body;
    expect(body).toContain("SHA256:pinnedfp");
    expect(body).toContain("n/a");
  });

  it("clears the pin when the address changes", async () => {
    const c = await setup();
    await post(c, "/hosts", HOST);
    c.h.deps.stores.hosts.setHostKeys(1, "k", "SHA256:pinnedfp");
    const same = await post(c, "/hosts/1", { ...HOST, name: "x", password: "" });
    expect(flashOf(same)).not.toContain("cleared");
    expect(c.h.deps.stores.hosts.getPublic(1)?.hostKeySha256).toBe("SHA256:pinnedfp");
    const moved = await post(c, "/hosts/1", { ...HOST, host: "other.example.org", password: "" });
    expect(flashOf(moved)).toContain("cleared");
    expect(c.h.deps.stores.hosts.getPublic(1)?.hostKeySha256).toBeNull();
  });

  it("inherits CSRF and Origin enforcement", async () => {
    const c = await setup();
    const noToken = await req(c.h, { method: "POST", url: "/hosts", sid: c.sid, payload: form(HOST), headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(noToken.statusCode).toBe(403);
    const evil = await req(c.h, { method: "POST", url: "/hosts", sid: c.sid, origin: "http://evil.example", payload: form({ _csrf: c.csrf, ...HOST }), headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(evil.statusCode).toBe(403);
    expect(c.h.deps.stores.hosts.listPublic()).toHaveLength(0);
  });
});

const dirs = (...names: string[]): RemoteEntry[] => names.map((n) => ({ path: n, size: 0, mtimeMs: null, isDir: true }));

describe("test connection", () => {
  it("lists the remote root using the decrypted stored config", async () => {
    const c = await setup();
    await post(c, "/hosts", HOST);
    c.engine.onTest = async () => ({ ok: true, rootListing: [...dirs("movies"), { path: "a.txt", size: 3, mtimeMs: null, isDir: false }] });
    const res = await post(c, "/hosts/1/test", {}, HX);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<html");
    expect(res.body).toContain("movies");
    expect(res.body).toContain("a.txt");
    expect(c.engine.lastHost?.secret.password).toBe("pw-S3CRET-value");
  });

  it("works for the unsaved form and falls back to the stored secret for a saved host", async () => {
    const c = await setup();
    const fresh = await post(c, "/hosts/test", { ...HOST, protocol: "ftp", port: "" }, HX);
    expect(fresh.body).toContain("Connected");
    expect(c.engine.lastHost).toMatchObject({ protocol: "ftp", port: 21, id: 0 });
    await post(c, "/hosts", HOST);
    await post(c, "/hosts/test", { ...HOST, id: "1", password: "" }, HX);
    expect(c.engine.lastHost?.secret.password).toBe("pw-S3CRET-value");
    await post(c, "/hosts/test", { ...HOST, id: "1", password: "typed-now" }, HX);
    expect(c.engine.lastHost?.secret.password).toBe("typed-now");
    expect(c.h.deps.stores.hosts.getConfig(1).secret.password).toBe("pw-S3CRET-value");
  });

  it("reports an invalid form without calling the engine", async () => {
    const c = await setup();
    const res = await post(c, "/hosts/test", { ...HOST, port: "0" }, HX);
    expect(res.body).toContain("Fix the form first");
    expect(c.engine.calls).toBe(0);
  });

  it("serves a full page without htmx and 404s unknown hosts", async () => {
    const c = await setup();
    await post(c, "/hosts", HOST);
    const page = await post(c, "/hosts/1/test");
    expect(page.body).toContain("<html");
    expect(page.body).toContain("Connection test");
    expect((await post(c, "/hosts/9/test")).statusCode).toBe(404);
  });

  const cases: [string, () => Error, string][] = [
    ["auth", () => new AuthError("530 Login incorrect for pw-S3CRET-value"), "Authentication failed"],
    ["host key", () => new HostKeyChanged("key mismatch pw-S3CRET-value"), "does not match the pinned key"],
    ["network", () => new TransientNetwork("dial tcp: i/o timeout pw-S3CRET-value\nsecond line with detail"), "Could not reach the server"],
    ["permanent", () => new PermanentError("550 no such dir; password=pw-S3CRET-value"), "The server refused the request"],
    ["unknown", () => new Error("boom pw-S3CRET-value"), "failed unexpectedly"],
  ];
  it.each(cases)("maps %s errors to a friendly message without leaking secrets", async (_n, make, text) => {
    const c = await setup();
    await post(c, "/hosts", HOST);
    c.engine.onTest = () => Promise.reject(make());
    const res = await post(c, "/hosts/1/test", {}, HX);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(text);
    expect(res.body).not.toContain("pw-S3CRET-value");
    expect(res.body).not.toContain("second line");
    expect(c.h.logs.join("")).not.toContain("pw-S3CRET-value");
  });

  it("shows scanned keys with fingerprints and a trust-on-first-use pin form for sftp", async () => {
    const c = await setup();
    await post(c, "/hosts", HOST);
    c.engine.onTest = async () => ({ ok: true, rootListing: [], hostKeys: KEYS });
    const body = (await post(c, "/hosts/1/test", {}, HX)).body;
    expect(body).toContain("SHA256:aaaaFINGERPRINTed25519");
    expect(body).toContain("unauthenticated");
    expect(body).toContain("trust on first use");
    expect(body).toContain("Pin this key");
    expect(body).toContain('action="/hosts/1/pin"');
    expect(c.engine.lastHost?.hostKeys).toBeNull();
  });

  it("does not offer pinning for unsaved hosts or non-sftp protocols", async () => {
    const c = await setup();
    c.engine.onTest = async () => ({ ok: true, rootListing: [], hostKeys: KEYS });
    const unsaved = (await post(c, "/hosts/test", HOST, HX)).body;
    expect(unsaved).toContain("Save the host first");
    expect(unsaved).not.toContain("Pin this key");
    await post(c, "/hosts", { ...HOST, protocol: "ftp" });
    const ftp = (await post(c, "/hosts/1/test", {}, HX)).body;
    expect(ftp).not.toContain("Pin this key");
  });
});

describe("host key pinning", () => {
  const pinBody = { fingerprint: KEYS.map((k) => k.sha256) };
  async function pinned(): Promise<Ctx> {
    const c = await setup();
    await post(c, "/hosts", HOST);
    c.engine.onTest = async () => ({ ok: true, rootListing: [], hostKeys: KEYS });
    await post(c, "/hosts/1/pin", pinBody);
    return c;
  }

  it("pins the confirmed keys after re-scanning", async () => {
    const c = await pinned();
    const pub = c.h.deps.stores.hosts.getPublic(1);
    expect(pub?.hostKeys).toBe(KEYS.map((k) => k.line).join("\n"));
    expect(pub?.hostKeySha256).toBe(KEYS.map((k) => k.sha256).join("\n"));
  });

  it("refuses to pin when the keys changed between scan and confirm", async () => {
    const c = await setup();
    await post(c, "/hosts", HOST);
    c.engine.onTest = async () => ({ ok: true, rootListing: [], hostKeys: [KEYS[0] as ScannedHostKey] });
    const res = await post(c, "/hosts/1/pin", pinBody);
    expect(flashOf(res)).toContain("changed since you looked");
    expect(c.h.deps.stores.hosts.getPublic(1)?.hostKeys).toBeNull();
  });

  it("refuses without fingerprints, for non-sftp hosts and unknown ids", async () => {
    const c = await setup();
    await post(c, "/hosts", HOST);
    await post(c, "/hosts", { ...HOST, name: "f", protocol: "ftp" });
    expect(flashOf(await post(c, "/hosts/1/pin"))).toContain("Nothing to pin");
    expect(flashOf(await post(c, "/hosts/2/pin", pinBody))).toContain("Nothing to pin");
    expect((await post(c, "/hosts/9/pin", pinBody)).statusCode).toBe(404);
  });

  it("maps a scan failure during pinning to a friendly message", async () => {
    const c = await setup();
    await post(c, "/hosts", HOST);
    c.engine.onTest = () => Promise.reject(new TransientNetwork("timeout pw-S3CRET-value"));
    const res = await post(c, "/hosts/1/pin", pinBody);
    expect(flashOf(res)).toContain("Could not reach the server");
    expect(flashOf(res)).not.toContain("pw-S3CRET-value");
  });

  it("reports a matching pin without offering to pin again", async () => {
    const c = await pinned();
    const body = (await post(c, "/hosts/1/test", {}, HX)).body;
    expect(body).toContain("match the pinned key");
    expect(body).not.toContain("Pin this key");
  });

  it("warns loudly about a changed key and never updates it automatically", async () => {
    const c = await pinned();
    const other: ScannedHostKey[] = [{ type: "ssh-ed25519", line: "host ssh-ed25519 EVIL", sha256: "SHA256:EVILfingerprint" }];
    c.engine.onTest = async () => ({ ok: true, rootListing: [], hostKeys: other });
    const body = (await post(c, "/hosts/1/test", {}, HX)).body;
    expect(body).toContain("DIFFERENT");
    expect(body).toContain("banner-danger");
    expect(body).toContain("Replace pinned key");
    expect(body).toContain("confirm_replace");
    expect(c.h.deps.stores.hosts.getPublic(1)?.hostKeySha256).toBe(KEYS.map((k) => k.sha256).join("\n"));
  });

  it("needs the explicit confirmation to replace a pinned key", async () => {
    const c = await pinned();
    const other: ScannedHostKey[] = [{ type: "ssh-ed25519", line: "host ssh-ed25519 NEW", sha256: "SHA256:NEWfingerprint" }];
    c.engine.onTest = async () => ({ ok: true, rootListing: [], hostKeys: other });
    const refused = await post(c, "/hosts/1/pin", { fingerprint: "SHA256:NEWfingerprint" });
    expect(flashOf(refused)).toContain("already pinned");
    expect(c.h.deps.stores.hosts.getPublic(1)?.hostKeySha256).toContain("aaaaFINGERPRINT");
    const ok = await post(c, "/hosts/1/pin", { fingerprint: "SHA256:NEWfingerprint", confirm_replace: "1" });
    expect(flashOf(ok)).toContain("pinned");
    expect(c.h.deps.stores.hosts.getPublic(1)?.hostKeys).toBe("host ssh-ed25519 NEW");
  });

  it("shows a pinned key on the edit page and a changed-key engine error loudly", async () => {
    const c = await pinned();
    expect((await get(c, "/hosts/1")).body).toContain("SHA256:aaaaFINGERPRINTed25519");
    c.engine.onTest = () => Promise.reject(new HostKeyChanged("mismatch"));
    const res = await post(c, "/hosts/1/test", {}, HX);
    expect(res.body).toContain("banner-danger");
    expect(c.h.deps.stores.hosts.getPublic(1)?.hostKeySha256).toContain("aaaaFINGERPRINT");
  });
});
