import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { HostConfig } from "../../src/domain.js";
import { AuthError } from "../../src/errors.js";
import type { EngineSession, RemoteEntry, TransferEngine } from "../../src/engine/types.js";
import { registerHostProbeRoutes } from "../../src/web/routes-host-probe.js";
import { registerHostRoutes } from "../../src/web/routes-hosts.js";
import { makeHarness, req, session, type Harness } from "./harness.js";

const form = (o: Record<string, string>): string => new URLSearchParams(o).toString();
const HX = { "hx-request": "true" };
const root: RemoteEntry[] = [{ path: "debian.iso", size: 50_000, mtimeMs: 123, isDir: false }];

/** An FTP server that accepts only the methods `accepts` allows, with plenty of logins. */
function fakeEngine(accepts: (c: HostConfig) => boolean): TransferEngine & { tested: HostConfig[] } {
  const tested: HostConfig[] = [];
  const s: EngineSession = {
    async list() { return root; }, async stat() { return null; }, async remove() {}, async move() {}, async close() {},
    openRange(_p, offset, count) { return Readable.from([Buffer.alloc(count, offset > 0 ? 1 : 1)]); },
  };
  return {
    id: "rclone", capabilities: { hash: false, parallelRanges: true }, tested,
    async testConnection(cfg) {
      tested.push(cfg);
      if (!accepts(cfg)) throw new AuthError("530 Login incorrect");
      return { ok: true, rootListing: root };
    },
    async open() { return s; },
  };
}

type Ctx = { h: Harness; sid: string; csrf: string; engine: ReturnType<typeof fakeEngine> };
async function setup(accepts: (c: HostConfig) => boolean = () => true): Promise<Ctx> {
  const h = await makeHarness({ routes: [registerHostRoutes, registerHostProbeRoutes] });
  const engine = fakeEngine(accepts);
  h.deps.engine = engine;
  return { h, engine, ...(await session(h)) };
}
const body = (o: Record<string, string> = {}) => ({
  name: "Seedbox", protocol: "ftp", host: "seedbox.example", port: "21", username: "me", password: "s3cret-pw", max_connections: "4", ...o,
});
const post = (c: Ctx, data: Record<string, string>, headers: Record<string, string> = {}) =>
  req(c.h, { method: "POST", url: "/hosts/probe", sid: c.sid, payload: form({ _csrf: c.csrf, ...data }), headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });

describe("detect best settings", () => {
  it("probes the posted values and offers the best working settings to apply", async () => {
    const c = await setup();
    const res = await post(c, body(), HX);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("FTPS (explicit TLS), verified certificate");
    expect(res.body).toContain("Best working method");
    expect(res.body).toContain('data-protocol="ftps_explicit"');
    expect(res.body).toContain('data-port="21"');
    expect(res.body).toContain('data-max-connections="4"');
    expect(res.body).toContain("works");
    expect(c.engine.tested[0]).toMatchObject({ host: "seedbox.example", username: "me", secret: { password: "s3cret-pw" } });
  });

  it("describes a certificate failure plainly instead of showing the raw error", async () => {
    const c = await setup((cfg) => cfg.tlsAcceptSelfSigned);
    const failing = c.engine.testConnection.bind(c.engine);
    c.engine.testConnection = async (cfg) => {
      if (!cfg.tlsAcceptSelfSigned) throw new Error("rclone exit 1: NewFs: tls: failed to verify certificate: x509: certificate signed by unknown authority");
      return failing(cfg);
    };
    const res = await post(c, body(), HX);
    expect(res.body).toContain("TLS certificate could not be verified");
    expect(res.body).not.toContain("x509");
  });

  it("falls back to plain FTP only when nothing encrypted works, and warns loudly", async () => {
    const c = await setup((cfg) => cfg.protocol === "ftp");
    const res = await post(c, body(), HX);
    expect(res.body).toContain("Only plain FTP works");
    expect(res.body).toContain('data-protocol="ftp"');
    expect(res.body).toContain("failed");
  });

  it("flags an accepted self-signed certificate in the settings it offers", async () => {
    const c = await setup((cfg) => cfg.tlsAcceptSelfSigned);
    const res = await post(c, body(), HX);
    expect(res.body).toContain('data-protocol="ftps_explicit"');
    expect(res.body).toContain('data-self-signed="1"');
    expect(res.body).toContain("could not be verified");
  });

  it("explains a total failure without leaking the password", async () => {
    const c = await setup(() => false);
    const res = await post(c, body(), HX);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("No connection method worked");
    expect(res.body).not.toContain("data-apply-probe");
    expect(res.body).not.toContain("s3cret-pw");
  });

  it("leaves SFTP hosts to the normal connection test", async () => {
    const c = await setup();
    const res = await post(c, body({ protocol: "sftp", port: "22" }), HX);
    expect(res.body).toContain("FTP and FTPS servers");
    expect(c.engine.tested).toEqual([]);
  });

  it("reports form mistakes instead of probing", async () => {
    const c = await setup();
    const res = await post(c, body({ host: "" }), HX);
    expect(res.body).toContain("Fix the form first");
    expect(c.engine.tested).toEqual([]);
  });

  it("works without htmx as a full page, and the host form offers the button and its script", async () => {
    const c = await setup();
    const page = await post(c, body());
    expect(page.body).toContain("<h2>Detect best settings</h2>");
    expect(page.body).toContain("<html");
    const formPage = (await req(c.h, { method: "GET", url: "/hosts/new", sid: c.sid })).body;
    expect(formPage).toContain('hx-post="/hosts/probe"');
    expect(formPage).toContain('src="/static/host-probe.js"');
  });

  it("needs a login and a CSRF token like every other mutation", async () => {
    const c = await setup();
    const anon = await req(c.h, { method: "POST", url: "/hosts/probe", payload: form(body()), headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect([303, 401, 403]).toContain(anon.statusCode);
    const noToken = await req(c.h, { method: "POST", url: "/hosts/probe", sid: c.sid, payload: form(body()), headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(noToken.statusCode).toBe(403);
    expect(c.engine.tested).toEqual([]);
  });
});
