import { afterEach, describe, expect, it } from "vitest";
import { commonDir, createArrStep, mapToArrPath, testArr } from "../../src/post/arr.js";
import { buildLogger } from "../../src/logger.js";
import type { JobConfig } from "../../src/domain.js";
import { setup } from "../store/helpers.js";
import { startStub, type Stub } from "./stub-server.js";

let stub: Stub | undefined;
afterEach(async () => { await stub?.close(); stub = undefined; });
const logger = buildLogger("silent", false);
const KEY = "super-secret-key-123";

async function fixture(reply?: Parameters<typeof startStub>[0], kind: "sonarr" | "radarr" = "sonarr") {
  stub = await startStub(reply);
  const s = setup();
  const target = s.stores.arrTargets.create({ name: "tv", kind, url: stub.url, apiKey: KEY });
  s.stores.integrations.set(s.jobId, { arrTargetId: target, arrPath: "/data/tv", notifyOn: "never", notifyChannelIds: [] });
  const job = s.stores.jobs.get(s.jobId) as JobConfig;
  const step = createArrStep({ stores: s.stores, logger });
  const input = { job: { ...job, localPath: "/l" }, runId: 1, signal: new AbortController().signal, unitKey: "Show", finalPaths: ["/l/Show/S01/a.mkv", "/l/Show/S01/b.mkv"] };
  return { s, step, input, target };
}

describe("path mapping", () => {
  it("finds the common directory and maps the prefix", () => {
    expect(commonDir(["/l/Show/S01/a.mkv", "/l/Show/S02/b.mkv"])).toBe("/l/Show");
    expect(commonDir(["/l/x.mkv"])).toBe("/l");
    expect(mapToArrPath("/l", "/data/tv/", "/l/Show/S01")).toBe("/data/tv/Show/S01");
    expect(mapToArrPath("/l", "/data/tv", "/l")).toBe("/data/tv");
    expect(mapToArrPath("/l", "/data/tv", "/other/x")).toBeNull();
    expect(mapToArrPath("/l", "D:\\tv", "/l/Show")).toBe("D:\\tv\\Show");
  });
});

describe("arr step", () => {
  it("sends one DownloadedEpisodesScan per unit with the api key header", async () => {
    const { step, input } = await fixture(() => ({ status: 201, body: "{}" }));
    expect(await step.run(input)).toEqual({ warnings: [] });
    expect(stub!.seen).toHaveLength(1);
    const r = stub!.seen[0]!;
    expect(r.method).toBe("POST");
    expect(r.url).toBe("/api/v3/command");
    expect(r.headers["x-api-key"]).toBe(KEY);
    expect(JSON.parse(r.body)).toEqual({ name: "DownloadedEpisodesScan", path: "/data/tv/Show/S01" });
  });

  it("uses DownloadedMoviesScan for radarr", async () => {
    const { step, input } = await fixture(undefined, "radarr");
    await step.run(input);
    expect(JSON.parse(stub!.seen[0]!.body).name).toBe("DownloadedMoviesScan");
  });

  it("does nothing without a target", async () => {
    const { s, step, input } = await fixture();
    s.stores.integrations.set(s.jobId, { arrTargetId: null, arrPath: null, notifyOn: "never", notifyChannelIds: [] });
    expect(await step.run(input)).toEqual({ warnings: [] });
    expect(stub!.seen).toHaveLength(0);
  });

  it("turns HTTP errors into warnings without leaking the key", async () => {
    const { step, input } = await fixture(() => ({ status: 401, body: `bad key ${KEY}` }));
    const r = await step.run(input);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("HTTP 401");
    expect(r.warnings[0]).not.toContain(KEY);
  });

  it("does not follow redirects", async () => {
    const { step, input } = await fixture(() => ({ status: 302, headers: { location: "http://127.0.0.1:1/x" } }));
    const r = await step.run(input);
    expect(r.warnings[0]).toContain("redirect");
  });

  it("warns on connection failure and on files outside the local path", async () => {
    const { s, step, input, target } = await fixture();
    expect((await step.run({ ...input, finalPaths: ["/elsewhere/a.mkv"] })).warnings[0]).toContain("not inside");
    s.stores.arrTargets.update(target, { url: "http://127.0.0.1:1" });
    const r = await step.run(input);
    expect(r.warnings[0]).toContain("network error");
    expect(r.warnings[0]).not.toContain(KEY);
  });

  it("skips quietly when the target was deleted (reference nulled)", async () => {
    const { s, step, input, target } = await fixture();
    s.stores.arrTargets.delete(target);
    expect((await step.run(input)).warnings).toEqual([]);
    expect(stub!.seen).toHaveLength(0);
    expect(s.stores.integrations.get(s.jobId).arrTargetId).toBeNull();
  });
});

describe("testArr", () => {
  it("GETs system/status", async () => {
    stub = await startStub(() => ({ status: 200, body: JSON.stringify({ appName: "Sonarr", version: "4.0.1" }) }));
    const r = await testArr({ id: 1, name: "x", kind: "sonarr", url: `${stub.url}/`, apiKey: KEY });
    expect(r).toEqual({ ok: true, message: "Connected to Sonarr 4.0.1." });
    expect(stub.seen[0]).toMatchObject({ method: "GET", url: "/api/v3/system/status" });
  });

  it("reports a rejected key", async () => {
    stub = await startStub(() => ({ status: 401 }));
    const r = await testArr({ id: 1, name: "x", kind: "sonarr", url: stub.url, apiKey: KEY });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("401");
  });

  it("times out", async () => {
    stub = await startStub(() => ({ status: 200, delayMs: 300 }));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const r = await testArr({ id: 1, name: "x", kind: "sonarr", url: stub.url, apiKey: KEY }, ac.signal);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("timed out");
  });

  it("reads a status body larger than 500 bytes (up to 64 KB) and shows app name and version", async () => {
    stub = await startStub(() => ({ status: 200, body: JSON.stringify({ padding: "x".repeat(5000), appName: "Radarr", version: "5.1.2" }) }));
    const r = await testArr({ id: 1, name: "x", kind: "radarr", url: stub.url, apiKey: KEY });
    expect(r).toEqual({ ok: true, message: "Connected to Radarr 5.1.2." });
  });

  it.each([["not JSON at all", "<html>login</html>"], ["JSON without appName", JSON.stringify({ version: "1" })], ["appName not a string", JSON.stringify({ appName: 4 })]])("fails for %s", async (_n, body) => {
    stub = await startStub(() => ({ status: 200, body }));
    const r = await testArr({ id: 1, name: "x", kind: "sonarr", url: stub.url, apiKey: KEY });
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain(KEY);
  });
});
