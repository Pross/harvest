import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AppEvent } from "../../src/run/events.js";
import { ProgressThrottle, frame } from "../../src/web/sse.js";
import { HOST, ORIGIN, cookieOf, login, makeHarness, req, type Harness } from "./harness.js";

const progress = (runId: number, bytesDone = 10): AppEvent =>
  ({ type: "run.progress", runId, jobId: 1, bytesDone, bytesTotal: 100, speedBps: 5, activeFiles: [] });

let open: Harness | undefined;
afterEach(async () => { await open?.app.close(); open = undefined; });

/** Opens /events on a real socket and collects the text received so far. */
async function connect(h: Harness, sid?: string): Promise<{ status: number; text: () => string; close: () => void }> {
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (h.app.server.address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: HOST, origin: ORIGIN };
    if (sid) headers["cookie"] = `harvest_sid=${sid}`;
    const r = http.get({ port, host: "127.0.0.1", path: "/events", headers }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => { buf += d; });
      resolve({ status: res.statusCode ?? 0, text: () => buf, close: () => r.destroy() });
    });
    r.on("error", reject);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("/events", () => {
  it("requires auth", async () => {
    const h = open = await makeHarness();
    const res = await req(h, { method: "GET", url: "/events" });
    expect(res.statusCode).toBe(303);
  });

  it("streams named events from the bus and cleans up on close", async () => {
    const h = open = await makeHarness();
    const sid = cookieOf(await login(h), "harvest_sid") ?? "";
    const c = await connect(h, sid);
    expect(c.status).toBe(200);
    h.deps.bus.emit({ type: "activity", id: 42 });
    h.deps.bus.emit({ type: "run.state", runId: 7, jobId: 1, state: "transferring" });
    h.deps.bus.emit(progress(7));
    await wait(100);
    const text = c.text();
    expect(text).toContain("event: activity\ndata: 42\n\n");
    expect(text).toContain("event: run-state\ndata: 7:transferring");
    expect(text).toContain("event: run-progress");
    expect(text).toContain("No transfers running.");
    c.close();
    await wait(100);
    // Closed client is unsubscribed: later events are not written.
    h.deps.bus.emit({ type: "activity", id: 43 });
    await wait(50);
    expect(c.text()).not.toContain("data: 43");
  });

  it("works in none mode without a cookie", async () => {
    const h = open = await makeHarness({ env: { AUTH_MODE: "none" }, user: false });
    const c = await connect(h);
    expect(c.status).toBe(200);
    c.close();
  });
});

describe("progress throttle", () => {
  it("allows one progress frame per second per run", async () => {
    let now = 0;
    const h = open = await makeHarness({ server: { now: () => now } });
    const sid = cookieOf(await login(h), "harvest_sid") ?? "";
    const c = await connect(h, sid);
    const frames = () => (c.text().match(/event: run-progress/g) ?? []).length;
    h.deps.bus.emit(progress(1));
    h.deps.bus.emit(progress(1));
    h.deps.bus.emit(progress(2));
    await wait(100);
    expect(frames()).toBe(2);
    now = 1500;
    h.deps.bus.emit(progress(1));
    await wait(100);
    expect(frames()).toBe(3);
    c.close();
  });

  it("unit: tracks runs independently and honors the interval", () => {
    let now = 0;
    const t = new ProgressThrottle(() => now, 1000);
    expect(t.take(1)).toBe(true);
    expect(t.take(1)).toBe(false);
    expect(t.take(2)).toBe(true);
    now = 999;
    expect(t.take(1)).toBe(false);
    now = 1000;
    expect(t.take(1)).toBe(true);
    t.forget(2);
    expect(t.take(2)).toBe(true);
  });
});

describe("frame", () => {
  it("splits multi-line data into data lines", () => {
    expect(frame("x", "a\nb")).toBe("event: x\ndata: a\ndata: b\n\n");
  });
});
