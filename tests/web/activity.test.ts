import { describe, expect, it } from "vitest";
import { registerActivityRoutes } from "../../src/web/routes-activity.js";
import { makeHarness, req, session, type Harness } from "./harness.js";

const boot = () => makeHarness({ routes: [registerActivityRoutes] });

const get = async (h: Harness, url: string) => {
  const { sid } = await session(h);
  return req(h, { method: "GET", url, sid });
};

type Rec = Parameters<Harness["deps"]["stores"]["activity"]["record"]>[0];
const add = (h: Harness, e: Partial<Rec> & { summary: string }) => h.deps.stores.activity.record({ category: "run.state", ...e });
const decode = (s: string) => s.replace(/&amp;/g, "&");

describe("activity page", () => {
  it("shows an empty state and the SSE hookup", async () => {
    const h = await boot();
    const res = await get(h, "/activity");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("No activity matches.");
    expect(res.body).toContain('sse-connect="/events"');
    expect(res.body).toContain('hx-trigger="sse:activity"');
  });

  it("renders rows newest first with severity styling", async () => {
    const h = await boot();
    add(h, { summary: "first event" });
    add(h, { summary: "second event", severity: "warn" });
    add(h, { summary: "third event", severity: "error" });
    const b = (await get(h, "/activity")).body;
    expect(b.indexOf("third event")).toBeLessThan(b.indexOf("second event"));
    expect(b.indexOf("second event")).toBeLessThan(b.indexOf("first event"));
    expect(b).toContain("sev-error");
    expect(b).toContain("sev-warn");
    expect(b).toContain("sev-info");
  });

  it("filters by category prefix, case-insensitively", async () => {
    const h = await boot();
    add(h, { category: "run.state", summary: "alpha" });
    add(h, { category: "ledger.forgot", summary: "bravo" });
    add(h, { category: "run.failed", summary: "charlie" });
    const b = (await get(h, "/activity?category=RUN.")).body;
    expect(b).toContain("alpha");
    expect(b).toContain("charlie");
    expect(b).not.toContain("bravo");
  });

  it("filters by severity and by job", async () => {
    const h = await boot();
    const hostId = h.deps.stores.hosts.create({ name: "h", protocol: "sftp", host: "e.org", port: 22, username: "u" });
    const job = h.deps.stores.jobs.create({ name: "Movies", hostId, remotePath: "/r", localPath: "/tmp/x" });
    add(h, { summary: "plain" });
    add(h, { summary: "warned", severity: "warn", jobId: job });
    add(h, { summary: "other warn", severity: "warn" });
    const sev = (await get(h, "/activity?severity=warn")).body;
    expect(sev).toContain("warned");
    expect(sev).not.toContain("plain");
    const byJob = (await get(h, `/activity?job=${job}`)).body;
    expect(byJob).toContain("warned");
    expect(byJob).not.toContain("other warn");
    expect(byJob).toContain(`href="/jobs/${job}"`);
  });

  it("ignores invalid filters", async () => {
    const h = await boot();
    add(h, { summary: "visible" });
    const res = await get(h, "/activity?severity=nope&job=x&before=abc");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("visible");
  });

  it("paginates by keyset with an htmx revealed trigger and a plain link", async () => {
    const h = await boot();
    for (let i = 1; i <= 5; i++) add(h, { summary: `event-${i}` });
    const first = (await get(h, "/activity?limit=2")).body;
    expect(first).toContain("event-5");
    expect(first).toContain("event-4");
    expect(first).not.toContain("event-3");
    expect(first).toContain('hx-trigger="revealed"');
    expect(first).toContain('hx-swap="outerHTML"');
    const link = decode(/href="(\/activity\?[^"]*before=[^"]+)"/.exec(first)?.[1] ?? "");
    expect(link).toContain("limit=2");
    const second = (await get(h, link)).body;
    expect(second).toContain("event-3");
    expect(second).toContain("event-2");
    expect(second).not.toContain("event-4");
  });

  it("has no older link when everything fits", async () => {
    const h = await boot();
    add(h, { summary: "only" });
    expect((await get(h, "/activity")).body).not.toContain("Load older");
  });

  it("finds sparse category matches beyond one store chunk", async () => {
    const h = await boot();
    add(h, { category: "rare.thing", summary: "needle" });
    for (let i = 0; i < 450; i++) add(h, { summary: `noise ${i}` });
    expect((await get(h, "/activity?category=rare.")).body).toContain("needle");
  });
});

describe("activity rows fragment", () => {
  it("returns older rows without layout, with the next trigger", async () => {
    const h = await boot();
    for (let i = 1; i <= 4; i++) add(h, { summary: `event-${i}` });
    const res = await get(h, "/activity/rows?limit=2&before=4");
    expect(res.body).not.toContain("<html");
    expect(res.body).toContain("event-3");
    expect(res.body).toContain("event-2");
    expect(res.body).toContain('hx-trigger="revealed"');
    expect(res.body).not.toContain("event-4");
  });

  it("after=ID returns only newer rows plus a refreshed live marker", async () => {
    const h = await boot();
    for (let i = 1; i <= 3; i++) add(h, { summary: `event-${i}` });
    const res = await get(h, "/activity/rows?after=1");
    expect(res.body).toContain("event-3");
    expect(res.body).toContain("event-2");
    expect(res.body).not.toContain("event-1");
    expect(res.body).toContain('id="activity-live"');
    expect(decode(res.body)).toContain("after=3");
    expect(res.body.indexOf("activity-live")).toBeLessThan(res.body.indexOf("event-3"));
  });

  it("after=ID with nothing new keeps the marker and renders no rows", async () => {
    const h = await boot();
    add(h, { summary: "event-1" });
    const res = await get(h, "/activity/rows?after=1");
    expect(res.body).not.toContain("act-row");
    expect(decode(res.body)).toContain("after=1");
  });

  it("after=ID honors filters", async () => {
    const h = await boot();
    add(h, { summary: "old" });
    add(h, { summary: "noisy info" });
    add(h, { summary: "bad thing", severity: "error" });
    const res = await get(h, "/activity/rows?after=1&severity=error");
    expect(res.body).toContain("bad thing");
    expect(res.body).not.toContain("noisy info");
    expect(decode(res.body)).toContain("severity=error");
  });

  it("the page marker does not appear when paging older", async () => {
    const h = await boot();
    for (let i = 1; i <= 3; i++) add(h, { summary: `event-${i}` });
    expect((await get(h, "/activity?before=3")).body).not.toContain('id="activity-live"');
  });
});

describe("meta rendering", () => {
  it("renders meta as an escaped key/value list in a collapsed details element", async () => {
    const h = await boot();
    add(h, { summary: "with meta", meta: { path: "<script>alert(1)</script>", count: 3, nested: { a: "<b>" } } });
    const b = (await get(h, "/activity")).body;
    expect(b).toContain("<details");
    expect(b).not.toContain("<details open");
    expect(b).toContain("<dt>path</dt>");
    expect(b).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(b).not.toContain("<script>alert(1)");
    expect(b).toContain("<dt>count</dt><dd>3</dd>");
    expect(b).toContain("&lt;b&gt;");
    expect(b).not.toContain("<b>");
  });

  it("handles scalar and array meta and rows without meta", async () => {
    const h = await boot();
    add(h, { summary: "scalar", meta: "just text" });
    add(h, { summary: "array", meta: [1, 2] });
    add(h, { summary: "none" });
    const b = (await get(h, "/activity")).body;
    expect(b).toContain("just text");
    expect(b).toContain("[1,2]");
    expect((b.match(/<details/g) ?? []).length).toBe(2);
  });

  it("escapes summaries and categories", async () => {
    const h = await boot();
    add(h, { category: "x.<i>", summary: "<script>1</script>" });
    const b = (await get(h, "/activity")).body;
    expect(b).not.toContain("<script>1</script>");
    expect(b).not.toContain("<i>");
  });

  it("links to the run", async () => {
    const h = await boot();
    add(h, { summary: "linked", runId: 7 });
    expect((await get(h, "/activity")).body).toContain('href="/runs/7"');
  });
});

describe("activity access", () => {
  it("requires a session", async () => {
    const h = await boot();
    expect((await req(h, { method: "GET", url: "/activity" })).statusCode).toBe(303);
    expect((await req(h, { method: "GET", url: "/activity/rows" })).statusCode).toBe(303);
  });
});
