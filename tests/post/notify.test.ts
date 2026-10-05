import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigUnreadableError } from "../../src/store/errors.js";
import { buildLogger } from "../../src/logger.js";
import { parseChannelConfig } from "../../src/post/notify/config.js";
import { buildEvent, createRunNotifier, sendToChannel, shouldNotify } from "../../src/post/notify/index.js";
import type { ChannelKind } from "../../src/store/channel-store.js";
import type { JobConfig } from "../../src/domain.js";
import type { RunSummary } from "../../src/post/types.js";
import { setup } from "../store/helpers.js";
import { startStub, type Stub } from "./stub-server.js";

const stubs: Stub[] = [];
afterEach(async () => { await Promise.all(stubs.splice(0).map((s) => s.close())); });
const logger = buildLogger("silent", false);
const summary: RunSummary = { filesOk: 3, filesFailed: 1, filesSkipped: 0, bytesDone: 5e6, durationMs: 12000, error: "boom ".repeat(200), warnings: [] };
const event = buildEvent({ name: "tv" }, 7, "partial", summary);

async function stubFor(reply?: Parameters<typeof startStub>[0]) {
  const s = await startStub(reply);
  stubs.push(s);
  return s;
}
const ch = (kind: ChannelKind, config: Record<string, string>) => ({ id: 1, name: "c", kind, enabled: true, config });

describe("event", () => {
  it("is concise and truncated", () => {
    expect(event.title).toBe("Harvest: tv partial");
    expect(event.text).toContain("Files ok 3, failed 1");
    expect(event.text).toContain("5.0 MB in 12 s");
    expect(event.text.length).toBeLessThanOrEqual(900);
    expect(event.text).toContain("\u2026");
  });
  it("selects by notify_on", () => {
    expect(shouldNotify("failure", "failed")).toBe(true);
    expect(shouldNotify("failure", "partial")).toBe(true);
    expect(shouldNotify("failure", "skipped_space")).toBe(true);
    expect(shouldNotify("failure", "skipped_locked")).toBe(false);
    expect(shouldNotify("success", "skipped_space")).toBe(false);
    expect(shouldNotify("always", "skipped_locked")).toBe(true);
    expect(shouldNotify("failure", "succeeded")).toBe(false);
    expect(shouldNotify("success", "succeeded")).toBe(true);
    expect(shouldNotify("success", "failed")).toBe(false);
    expect(shouldNotify("never", "failed")).toBe(false);
    expect(shouldNotify("always", "cancelled")).toBe(true);
  });
});

describe("config validation", () => {
  it("requires http(s) URLs and required fields", () => {
    expect(parseChannelConfig("webhook", { url: "ftp://x/y" }).ok).toBe(false);
    expect(parseChannelConfig("webhook", { url: "javascript:alert(1)" }).ok).toBe(false);
    expect(parseChannelConfig("webhook", { url: "https://user:pass@hooks.example/x" }).ok).toBe(false);
    expect(parseChannelConfig("ntfy", { topic: "t", server: "http://u@ntfy.local" }).ok).toBe(false);
    expect(parseChannelConfig("discord", { webhookUrl: "https://:secret@discord.com/api/webhooks/1/x" }).ok).toBe(false);
    expect(parseChannelConfig("ntfy", { topic: "" }).ok).toBe(false);
    expect(parseChannelConfig("ntfy", { topic: "t", server: "file:///x" }).ok).toBe(false);
    expect(parseChannelConfig("discord", { webhookUrl: "https://discord.com/api/webhooks/1/x" }).ok).toBe(true);
    expect(parseChannelConfig("ntfy", { topic: "t", server: "", token: "" })).toEqual({ ok: true, config: { topic: "t" } });
  });
});

describe("senders", () => {
  it("ntfy publishes JSON with bearer token", async () => {
    const s = await stubFor();
    await sendToChannel(ch("ntfy", { server: s.url, topic: "harvest", token: "tk" }), event);
    const r = s.seen[0]!;
    expect(r.headers["authorization"]).toBe("Bearer tk");
    expect(JSON.parse(r.body)).toMatchObject({ topic: "harvest", title: "Harvest: tv partial", priority: 4 });
  });
  it("discord posts content", async () => {
    const s = await stubFor();
    await sendToChannel(ch("discord", { webhookUrl: `${s.url}/api/webhooks/1/abc` }), event);
    expect(s.seen[0]!.url).toBe("/api/webhooks/1/abc");
    expect(JSON.parse(s.seen[0]!.body).content).toContain("Harvest: tv partial");
  });
  it("telegram posts sendMessage", async () => {
    const s = await stubFor();
    await sendToChannel(ch("telegram", { botToken: "123:abc", chatId: "42", server: s.url }), event);
    expect(s.seen[0]!.url).toBe("/bot123%3Aabc/sendMessage");
    expect(JSON.parse(s.seen[0]!.body)).toMatchObject({ chat_id: "42" });
  });
  it("pushover posts messages.json", async () => {
    const s = await stubFor();
    await sendToChannel(ch("pushover", { appToken: "a", userKey: "u", server: s.url }), event);
    expect(s.seen[0]!.url).toBe("/1/messages.json");
    expect(JSON.parse(s.seen[0]!.body)).toMatchObject({ token: "a", user: "u" });
  });
  it("webhook posts JSON with optional bearer", async () => {
    const s = await stubFor();
    await sendToChannel(ch("webhook", { url: `${s.url}/hook` }), event);
    expect(s.seen[0]!.headers["authorization"]).toBeUndefined();
    await sendToChannel(ch("webhook", { url: `${s.url}/hook`, bearerToken: "bt" }), event);
    expect(s.seen[1]!.headers["authorization"]).toBe("Bearer bt");
    expect(JSON.parse(s.seen[1]!.body)).toMatchObject({ job: "tv", runId: 7, state: "partial" });
  });
  it("errors never contain the URL or secrets", async () => {
    const s = await stubFor(() => ({ status: 500, body: "secret-hook-token" }));
    const err = await sendToChannel(ch("webhook", { url: `${s.url}/secret-hook-token` }), event).catch((e: Error) => e);
    expect((err as Error).message).toBe("HTTP 500");
  });
  it("does not follow redirects", async () => {
    const s = await stubFor(() => ({ status: 307, headers: { location: "http://127.0.0.1:1/" } }));
    await expect(sendToChannel(ch("webhook", { url: s.url, bearerToken: "bt" }), event)).rejects.toThrow(/redirect/);
    expect(s.seen).toHaveLength(1);
  });
});

describe("run notifier", () => {
  async function fixture() {
    const bad = await stubFor(() => ({ status: 500 }));
    const good = await stubFor();
    const s = setup();
    const a = s.stores.channels.create({ name: "bad", kind: "webhook", config: { url: bad.url } });
    const b = s.stores.channels.create({ name: "good", kind: "webhook", config: { url: good.url } });
    const off = s.stores.channels.create({ name: "off", kind: "webhook", config: { url: good.url }, enabled: false });
    s.stores.integrations.set(s.jobId, { arrTargetId: null, arrPath: null, notifyOn: "failure", notifyChannelIds: [a, b, off] });
    const job = s.stores.jobs.get(s.jobId) as JobConfig;
    return { s, job, good, bad, notifier: createRunNotifier(s.stores, logger) };
  }

  it("one failing channel does not block others; the failure is returned as a warning (the caller records the activity)", async () => {
    const { job, good, notifier } = await fixture();
    const r = await notifier.run({ job, runId: 2, state: "failed", summary });
    expect(good.seen).toHaveLength(1);
    expect(r.warnings).toEqual(["notification bad failed: HTTP 500"]);
  });

  it("sends nothing when the state does not match", async () => {
    const { job, good, bad, notifier } = await fixture();
    expect(await notifier.run({ job, runId: 2, state: "succeeded", summary })).toEqual({ warnings: [] });
    expect(good.seen.length + bad.seen.length).toBe(0);
  });
});

describe("error classification", () => {
  it("separates an unreadable config from an unexpected error and logs the real error", async () => {
    const { job, notifier, s, errors } = await classFixture();
    const id = s.stores.integrations.get(job.id).notifyChannelIds[0]!;
    s.stores.channels.getConfig = () => { throw new ConfigUnreadableError("channel", id, new Error("bad decrypt")); };
    expect((await notifier.run({ job, runId: 1, state: "failed", summary })).warnings).toEqual(["notification c failed: channel config could not be read (APP_SECRET changed?)"]);
    s.stores.channels.getConfig = () => { throw new TypeError("internal-bug"); };
    const r = await notifier.run({ job, runId: 1, state: "failed", summary });
    expect(r.warnings).toEqual(["notification c failed: unexpected error (see the log)"]);
    expect(errors.join("")).toContain("internal-bug");
  });
});

async function classFixture() {
  const s = setup();
  const id = s.stores.channels.create({ name: "c", kind: "webhook", config: { url: "http://127.0.0.1:1/x" } });
  s.stores.integrations.set(s.jobId, { arrTargetId: null, arrPath: null, notifyOn: "failure", notifyChannelIds: [id] });
  const errors: string[] = [];
  const sink = { write: (m: string) => void errors.push(m) };
  const log = pino({ level: "warn" }, sink);
  const job = s.stores.jobs.get(s.jobId) as JobConfig;
  return { s, job, errors, notifier: createRunNotifier(s.stores, log) };
}
