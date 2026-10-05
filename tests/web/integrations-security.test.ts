import { afterEach, describe, expect, it } from "vitest";
import { ConfigUnreadableError } from "../../src/store/errors.js";
import { registerIntegrationRoutes } from "../../src/web/routes-integrations.js";
import { startStub, type Stub } from "../post/stub-server.js";
import { makeHarness, req, session } from "./harness.js";

const stubs: Stub[] = [];
afterEach(async () => { await Promise.all(stubs.splice(0).map((s) => s.close())); });
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const CT = { "content-type": "application/x-www-form-urlencoded" };

async function boot() {
  const h = await makeHarness({ routes: [registerIntegrationRoutes] });
  const { sid, csrf } = await session(h);
  const post = (url: string, o: Record<string, string>, extra: Record<string, string> = {}) =>
    req(h, { method: "POST", url, sid, headers: { ...CT, ...extra }, payload: form({ ...o, _csrf: csrf }) });
  const get = (url: string) => req(h, { method: "GET", url, sid });
  return { h, post, get };
}

describe("arr target URLs and credentials", () => {
  it.each(["http://user:pass@sonarr:8989", "ftp://sonarr:8989", "javascript:alert(1)", "sonarr:8989"])("rejects %s", async (url) => {
    const { post, h } = await boot();
    const r = await post("/arr-targets", { name: "tv", kind: "sonarr", url, api_key: "KEY" });
    expect(r.statusCode).toBe(400);
    expect(h.deps.stores.arrTargets.listPublic()).toEqual([]);
    expect(r.body).not.toContain("pass@");
  });

  it("requires the API key again when the URL moves to another host, but not for a path change on the same host", async () => {
    const { post, h } = await boot();
    const id = h.deps.stores.arrTargets.create({ name: "tv", kind: "sonarr", url: "http://sonarr:8989", apiKey: "KEY-ONE" });
    const moved = await post(`/arr-targets/${id}`, { name: "tv", kind: "sonarr", url: "http://evil.example:8989", api_key: "" });
    expect(moved.statusCode).toBe(400);
    expect(moved.body).toContain("different server");
    expect(h.deps.stores.arrTargets.getConfig(id)).toMatchObject({ url: "http://sonarr:8989", apiKey: "KEY-ONE" });
    expect((await post(`/arr-targets/${id}`, { name: "tv", kind: "sonarr", url: "http://sonarr:8989/sub", api_key: "" })).statusCode).toBe(303);
    expect((await post(`/arr-targets/${id}`, { name: "tv", kind: "sonarr", url: "https://other:9", api_key: "KEY-TWO" })).statusCode).toBe(303);
    expect(h.deps.stores.arrTargets.getConfig(id)).toMatchObject({ url: "https://other:9", apiKey: "KEY-TWO" });
  });
});

describe("channel URLs, secrets and endpoint moves", () => {
  it("rejects userinfo and non-http URLs in every URL field", async () => {
    const { post, h } = await boot();
    expect((await post("/channels?kind=webhook", { name: "w", cfg_url: "http://u:p@host/hook" })).statusCode).toBe(400);
    expect((await post("/channels?kind=ntfy", { name: "n", cfg_topic: "t", cfg_server: "https://u:p@ntfy.example" })).statusCode).toBe(400);
    expect((await post("/channels?kind=discord", { name: "d", cfg_webhookUrl: "ftp://x/y" })).statusCode).toBe(400);
    expect(h.deps.stores.channels.listPublic()).toEqual([]);
  });

  it("treats the webhook URL and the ntfy topic as secrets: never rendered back, blank keeps them", async () => {
    const { post, get, h } = await boot();
    const stub = await startStub();
    stubs.push(stub);
    await post("/channels?kind=webhook", { name: "w", enabled: "on", cfg_url: `${stub.url}/SECRET-HOOK-PATH`, cfg_bearerToken: "" });
    await post("/channels?kind=ntfy", { name: "n", enabled: "on", cfg_topic: "SECRET-TOPIC-NAME", cfg_server: stub.url });
    const [n, w] = h.deps.stores.channels.listPublic();
    for (const [c, secret] of [[w!, "SECRET-HOOK-PATH"], [n!, "SECRET-TOPIC-NAME"]] as const) {
      const page = (await get(`/channels/${c.id}`)).body;
      expect(page).not.toContain(secret);
      expect(page).toContain("unchanged");
    }
    const kept = await post(`/channels/${w!.id}`, { name: "w", enabled: "on", cfg_url: "", cfg_bearerToken: "" });
    expect(kept.statusCode).toBe(303);
    expect(h.deps.stores.channels.getConfig(w!.id).config["url"]).toBe(`${stub.url}/SECRET-HOOK-PATH`);
  });

  it("rejects a blank secret when the server/URL changes host, and accepts it when re-entered", async () => {
    const { post, h } = await boot();
    const id = h.deps.stores.channels.create({ name: "n", kind: "ntfy", config: { server: "http://ntfy.local", topic: "t", token: "TOK" } });
    const moved = await post(`/channels/${id}`, { name: "n", enabled: "on", cfg_server: "http://evil.example", cfg_topic: "", cfg_token: "" });
    expect(moved.statusCode).toBe(400);
    expect(moved.body).toContain("server address changed");
    expect(h.deps.stores.channels.getConfig(id).config).toEqual({ server: "http://ntfy.local", topic: "t", token: "TOK" });
    const ok = await post(`/channels/${id}`, { name: "n", enabled: "on", cfg_server: "http://new.example", cfg_topic: "t2", cfg_token: "TOK2" });
    expect(ok.statusCode).toBe(303);
    expect(h.deps.stores.channels.getConfig(id).config).toEqual({ server: "http://new.example", topic: "t2", token: "TOK2" });
    const wh = h.deps.stores.channels.create({ name: "w", kind: "webhook", config: { url: "http://a.local/h", bearerToken: "B" } });
    const bad = await post(`/channels/${wh}`, { name: "w", enabled: "on", cfg_url: "http://b.local/h", cfg_bearerToken: "" });
    expect(bad.statusCode).toBe(400);
    expect(h.deps.stores.channels.getConfig(wh).config["url"]).toBe("http://a.local/h");
  });
});

describe("errors are not mislabeled", () => {
  it("channel test: an undecryptable config says so, any other failure says unexpected and logs the real error", async () => {
    const { post, h } = await boot();
    const id = h.deps.stores.channels.create({ name: "w", kind: "webhook", config: { url: "http://a.local/h" } });
    h.deps.db.prepare("UPDATE notify_channels SET config_enc = ? WHERE id = ?").run(Buffer.from("garbage"), id);
    const t1 = await post(`/channels/${id}/test`, {}, { "hx-request": "true" });
    expect(t1.body).toContain("cannot be decrypted");
    h.deps.stores.channels.getConfig = () => { throw new TypeError("kaboom-internal"); };
    const t2 = await post(`/channels/${id}/test`, {}, { "hx-request": "true" });
    expect(t2.body).not.toContain("decrypted");
    expect(t2.body).toContain("unexpected error");
    expect(h.logs.join("")).toContain("kaboom-internal");
  });

  it("arr test: same distinction", async () => {
    const { post, h } = await boot();
    const id = h.deps.stores.arrTargets.create({ name: "tv", kind: "sonarr", url: "http://x:1", apiKey: "k" });
    h.deps.stores.arrTargets.getConfig = () => { throw new ConfigUnreadableError("*arr target", id, new Error("bad decrypt")); };
    expect((await post(`/arr-targets/${id}/test`, {}, { "hx-request": "true" })).body).toContain("cannot be decrypted");
    h.deps.stores.arrTargets.getConfig = () => { throw new TypeError("arr-internal-bug"); };
    const t2 = await post(`/arr-targets/${id}/test`, {}, { "hx-request": "true" });
    expect(t2.body).toContain("unexpected error");
    expect(h.logs.join("")).toContain("arr-internal-bug");
  });
});
