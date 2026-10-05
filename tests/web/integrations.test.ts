import { afterEach, describe, expect, it } from "vitest";
import { registerIntegrationRoutes } from "../../src/web/routes-integrations.js";
import { registerJobRoutes } from "../../src/web/routes-jobs.js";
import { startStub, type Stub } from "../post/stub-server.js";
import { makeHarness, req, session, type Harness } from "./harness.js";

const stubs: Stub[] = [];
afterEach(async () => { await Promise.all(stubs.splice(0).map((s) => s.close())); });
const form = (o: Record<string, string | string[]>) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => [k, x] as [string, string]))).toString();
const CT = { "content-type": "application/x-www-form-urlencoded" };

async function boot() {
  const h = await makeHarness({ routes: [registerIntegrationRoutes, registerJobRoutes] });
  const { sid, csrf } = await session(h);
  const post = (url: string, o: Record<string, string | string[]>, extra: Record<string, string> = {}) =>
    req(h, { method: "POST", url, sid, headers: { ...CT, ...extra }, payload: form({ ...o, _csrf: csrf }) });
  const get = (url: string) => req(h, { method: "GET", url, sid });
  return { h, post, get };
}
const hostJob = (h: Harness) => {
  const hostId = h.deps.stores.hosts.create({ name: "h", protocol: "sftp", host: "e.com", port: 22, username: "u", secret: { password: "p" } });
  return h.deps.stores.jobs.create({ name: "tvjob", hostId, remotePath: "/r", localPath: "/l" });
};

describe("arr target pages", () => {
  it("creates, never shows the key, keeps it when blank on edit, tests, deletes", async () => {
    const { h, post, get } = await boot();
    const stub = await startStub(() => ({ status: 200, body: JSON.stringify({ appName: "Sonarr", version: "4" }) }));
    stubs.push(stub);
    expect((await post("/arr-targets", { name: "tv", kind: "sonarr", url: stub.url, api_key: "KEY-ONE" })).statusCode).toBe(303);
    const id = h.deps.stores.arrTargets.listPublic()[0]!.id;
    const page = (await get(`/arr-targets/${id}`)).body;
    expect(page).not.toContain("KEY-ONE");
    expect(page).toContain('placeholder="unchanged"');
    expect((await post(`/arr-targets/${id}`, { name: "tv2", kind: "sonarr", url: stub.url, api_key: "" })).statusCode).toBe(303);
    expect(h.deps.stores.arrTargets.getConfig(id)).toMatchObject({ name: "tv2", apiKey: "KEY-ONE" });
    const t = await post(`/arr-targets/${id}/test`, {}, { "hx-request": "true" });
    expect(t.body).toContain("Connected to Sonarr 4.");
    expect(stub.seen[0]!.headers["x-api-key"]).toBe("KEY-ONE");
    expect((await post(`/arr-targets/${id}/delete`, {})).statusCode).toBe(303);
    expect(h.deps.stores.arrTargets.listPublic()).toHaveLength(0);
    expect(h.logs.join("")).not.toContain("KEY-ONE");
  });

  it("validates url scheme, requires key on create, rejects duplicate names", async () => {
    const { post } = await boot();
    expect((await post("/arr-targets", { name: "a", kind: "sonarr", url: "ftp://x", api_key: "k" })).statusCode).toBe(400);
    expect((await post("/arr-targets", { name: "a", kind: "sonarr", url: "http://x:1", api_key: "" })).statusCode).toBe(400);
    expect((await post("/arr-targets", { name: "a", kind: "sonarr", url: "http://x:1", api_key: "k" })).statusCode).toBe(303);
    expect((await post("/arr-targets", { name: "A", kind: "radarr", url: "http://x:1", api_key: "k" })).statusCode).toBe(400);
  });

  it("escapes names", async () => {
    const { h, post, get } = await boot();
    await post("/arr-targets", { name: "<script>x</script>", kind: "radarr", url: "http://x:1", api_key: "k" });
    expect(h.deps.stores.arrTargets.listPublic()).toHaveLength(1);
    const html = (await get("/arr-targets")).body;
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("channel pages", () => {
  it("creates a webhook channel, hides secrets, keeps them when blank, sends test", async () => {
    const { h, post, get } = await boot();
    const stub = await startStub();
    stubs.push(stub);
    expect((await get("/channels/new")).body).toContain("/channels/new?kind=ntfy");
    const bad = await post("/channels?kind=webhook", { name: "w", cfg_url: "ftp://nope" });
    expect(bad.statusCode).toBe(400);
    expect((await post("/channels?kind=webhook", { name: "w", enabled: "on", cfg_url: `${stub.url}/h`, cfg_bearerToken: "BEARER-1" })).statusCode).toBe(303);
    const id = h.deps.stores.channels.listPublic()[0]!.id;
    const page = (await get(`/channels/${id}`)).body;
    expect(page).not.toContain("BEARER-1");
    expect(page).toContain("unchanged");
    await post(`/channels/${id}`, { name: "w2", enabled: "on", cfg_url: `${stub.url}/h2`, cfg_bearerToken: "" });
    expect(h.deps.stores.channels.getConfig(id).config).toEqual({ url: `${stub.url}/h2`, bearerToken: "BEARER-1" });
    const t = await post(`/channels/${id}/test`, {}, { "hx-request": "true" });
    expect(t.body).toContain("Test notification sent.");
    expect(stub.seen[0]!.headers["authorization"]).toBe("Bearer BEARER-1");
    expect(h.logs.join("")).not.toContain("BEARER-1");
  });

  it("reports test failures without leaking the url", async () => {
    const { h, post } = await boot();
    const stub = await startStub(() => ({ status: 500 }));
    stubs.push(stub);
    const id = h.deps.stores.channels.create({ name: "w", kind: "webhook", config: { url: `${stub.url}/tok-123` } });
    const t = await post(`/channels/${id}/test`, {}, { "hx-request": "true" });
    expect(t.body).toContain("HTTP 500");
    expect(t.body).not.toContain("tok-123");
  });
});

describe("job integrations and deletion of referenced rows", () => {
  it("saves wiring, then deleting target/channel nulls/removes references", async () => {
    const { h, post, get } = await boot();
    const jobId = hostJob(h);
    const arr = h.deps.stores.arrTargets.create({ name: "tv", kind: "sonarr", url: "http://x:1", apiKey: "k" });
    const c1 = h.deps.stores.channels.create({ name: "c1", kind: "webhook", config: { url: "http://x:1" } });
    const c2 = h.deps.stores.channels.create({ name: "c2", kind: "webhook", config: { url: "http://x:1" } });
    expect((await get(`/jobs/${jobId}/integrations`)).statusCode).toBe(200);
    expect((await post(`/jobs/${jobId}/integrations`, { arr_target_id: String(arr), arr_path: "", notify_on: "always" })).statusCode).toBe(400);
    const ok = await post(`/jobs/${jobId}/integrations`, { arr_target_id: String(arr), arr_path: "/data/tv", notify_on: "always", channel: [String(c1), String(c2), "999"] });
    expect(ok.statusCode).toBe(303);
    expect(h.deps.stores.integrations.get(jobId)).toEqual({ arrTargetId: arr, arrPath: "/data/tv", notifyOn: "always", notifyChannelIds: [c1, c2] });
    const del = await post(`/channels/${c1}/delete`, {});
    expect(del.statusCode).toBe(303);
    expect(h.deps.stores.integrations.get(jobId).notifyChannelIds).toEqual([c2]);
    await post(`/arr-targets/${arr}/delete`, {});
    expect(h.deps.stores.integrations.get(jobId).arrTargetId).toBeNull();
  });

  it("job deletion cascades the integration row", async () => {
    const { h } = await boot();
    const jobId = hostJob(h);
    h.deps.stores.integrations.set(jobId, { arrTargetId: null, arrPath: null, notifyOn: "success", notifyChannelIds: [] });
    h.deps.stores.jobs.delete(jobId);
    expect(h.deps.db.prepare("SELECT COUNT(*) AS n FROM job_integrations").get()).toEqual({ n: 0 });
  });
});
