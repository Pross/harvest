import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { registerSettingsRoutes } from "../../src/web/routes-settings.js";
import { MAX_STREAMS } from "../../src/web/stream-hub.js";
import { HOST, ORIGIN, PASSWORD, cookieOf, login, makeHarness, req, session, type Harness } from "./harness.js";

let open: Harness | undefined;
afterEach(async () => { await open?.app.close(); open = undefined; });

type Conn = { status: number; ended: Promise<void>; close: () => void };

async function connect(h: Harness, sid: string): Promise<Conn> {
  if (!h.app.server.listening) await h.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (h.app.server.address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const r = http.get({ port, host: "127.0.0.1", path: "/events", headers: { host: HOST, origin: ORIGIN, cookie: `harvest_sid=${sid}` } }, (res) => {
      res.resume();
      const ended = new Promise<void>((done) => { res.on("end", done); res.on("close", done); });
      resolve({ status: res.statusCode ?? 0, ended, close: () => r.destroy() });
    });
    r.on("error", reject);
  });
}

const settled = (p: Promise<void>, ms = 2000): Promise<boolean> =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

describe("SSE streams and sessions", () => {
  it("closes the user's streams on logout", async () => {
    const h = open = await makeHarness();
    const { sid, csrf } = await session(h);
    const c = await connect(h, sid);
    expect(c.status).toBe(200);
    await req(h, { method: "POST", url: "/logout", sid, headers: { "x-csrf-token": csrf } });
    expect(await settled(c.ended)).toBe(true);
    expect(h.app.streams.size).toBe(0);
  });

  it("keeps other sessions' streams open on logout", async () => {
    const h = open = await makeHarness();
    const a = await session(h);
    const b = cookieOf(await login(h), "harvest_sid") ?? "";
    const ca = await connect(h, a.sid);
    const cb = await connect(h, b);
    await req(h, { method: "POST", url: "/logout", sid: a.sid, headers: { "x-csrf-token": a.csrf } });
    expect(await settled(ca.ended)).toBe(true);
    expect(await settled(cb.ended, 300)).toBe(false);
    cb.close();
  });

  it("closes streams when the password changes", async () => {
    const h = open = await makeHarness({ routes: [registerSettingsRoutes] });
    const { sid, csrf } = await session(h);
    const c = await connect(h, sid);
    const res = await req(h, {
      method: "POST", url: "/settings/password", sid, headers: { "x-csrf-token": csrf },
      payload: { current: PASSWORD, password: "another-password-1", confirm: "another-password-1" },
    });
    expect(res.statusCode).toBe(303);
    expect(await settled(c.ended)).toBe(true);
  });

  it("closes streams whose session expired (checked on the heartbeat)", async () => {
    let clock = 1_000_000;
    const h = open = await makeHarness({ server: { now: () => clock, heartbeatMs: 20 } });
    const { sid } = await session(h);
    const c = await connect(h, sid);
    expect(await settled(c.ended, 150)).toBe(false);
    clock += 15 * 24 * 3600 * 1000;
    expect(await settled(c.ended)).toBe(true);
  });

  it("answers 503 beyond the stream cap", async () => {
    const h = open = await makeHarness();
    const { sid } = await session(h);
    const conns: Conn[] = [];
    for (let i = 0; i < MAX_STREAMS; i++) conns.push(await connect(h, sid));
    expect(conns.every((c) => c.status === 200)).toBe(true);
    expect((await connect(h, sid)).status).toBe(503);
    conns[0]?.close();
    await new Promise((r) => setTimeout(r, 100));
    const again = await connect(h, sid);
    expect(again.status).toBe(200);
    again.close();
    conns.forEach((c) => c.close());
  });
});
