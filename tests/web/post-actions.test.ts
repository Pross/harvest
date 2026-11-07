import { describe, expect, it } from "vitest";
import { registerJobRoutes } from "../../src/web/routes-jobs.js";
import { registerPostRoutes } from "../../src/web/routes-post.js";
import { makeHarness, req, session, type Harness } from "./harness.js";

const boot = () => makeHarness({ routes: [registerJobRoutes, registerPostRoutes] });

function seedJob(h: Harness): number {
  const hostId = h.deps.stores.hosts.create({ name: "h", protocol: "sftp", host: "example.org", port: 22, username: "u" });
  return h.deps.stores.jobs.create({ name: "Movies", hostId, remotePath: "/r", localPath: "/tmp/x" });
}

async function post(h: Harness, url: string, payload: Record<string, string>, htmx = false) {
  const { sid, csrf } = await session(h);
  return req(h, { method: "POST", url, sid, payload, headers: { "x-csrf-token": csrf, ...(htmx ? { "hx-request": "true" } : {}) } });
}

describe("post-actions page", () => {
  it("is linked from the job page and shows the defaults", async () => {
    const h = await boot();
    const job = seedJob(h);
    const { sid } = await session(h);
    expect((await req(h, { method: "GET", url: `/jobs/${job}`, sid })).body).toContain(`href="/jobs/${job}/post-actions"`);
    const page = await req(h, { method: "GET", url: `/jobs/${job}/post-actions`, sid });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<option value="off" selected>');
  });

  it("saves extract mode and modes, then redirects", async () => {
    const h = await boot();
    const job = seedJob(h);
    const res = await post(h, `/jobs/${job}/post-actions`, { extract: "delete", chmod_file: "644", chmod_dir: "0755" });
    expect(res.statusCode).toBe(303);
    expect(h.deps.stores.post.get(job)).toEqual({ extract: "delete", chmodFile: "644", chmodDir: "0755", titleNfo: false, titleStrip: "" });
  });

  it("clears the modes when the fields are empty", async () => {
    const h = await boot();
    const job = seedJob(h);
    h.deps.stores.post.set(job, { extract: "keep", chmodFile: "644", chmodDir: "755", titleNfo: false, titleStrip: "" });
    await post(h, `/jobs/${job}/post-actions`, { extract: "keep", chmod_file: "", chmod_dir: "" });
    expect(h.deps.stores.post.get(job)).toEqual({ extract: "keep", chmodFile: null, chmodDir: null, titleNfo: false, titleStrip: "" });
  });

  it("shows inline errors and saves nothing for invalid input", async () => {
    const h = await boot();
    const job = seedJob(h);
    const res = await post(h, `/jobs/${job}/post-actions`, { extract: "zip", chmod_file: "999", chmod_dir: "7" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Use three octal digits");
    expect(res.body.match(/Use three octal digits/g)).toHaveLength(2);
    expect(res.body).toContain("Choose how archives are handled.");
    expect(h.deps.stores.post.get(job).extract).toBe("off");
  });

  it("answers htmx requests with the form fragment (200 so htmx swaps it)", async () => {
    const h = await boot();
    const job = seedJob(h);
    const bad = await post(h, `/jobs/${job}/post-actions`, { extract: "keep", chmod_file: "abc" }, true);
    expect(bad.statusCode).toBe(200);
    expect(bad.body).toContain("octal digits");
    expect(bad.body).not.toContain("<html");
    const ok = await post(h, `/jobs/${job}/post-actions`, { extract: "keep", chmod_file: "640" }, true);
    expect(ok.body).toContain("Saved.");
    expect(h.deps.stores.post.get(job).chmodFile).toBe("640");
  });

  it("404s for an unknown job and requires a CSRF token", async () => {
    const h = await boot();
    const job = seedJob(h);
    const { sid } = await session(h);
    expect((await req(h, { method: "GET", url: "/jobs/999/post-actions", sid })).statusCode).toBe(404);
    expect((await req(h, { method: "POST", url: `/jobs/${job}/post-actions`, sid, payload: { extract: "keep" } })).statusCode).toBe(403);
  });
});

describe("post-actions page: title nfo", () => {
  it("saves the switch and the strip list, and shows them again", async () => {
    const h = await boot();
    const job = seedJob(h);
    const res = await post(h, `/jobs/${job}/post-actions`, { extract: "off", title_nfo: "on", title_strip: " SkyF1HD, 1080P " });
    expect(res.statusCode).toBe(303);
    expect(h.deps.stores.post.get(job)).toMatchObject({ titleNfo: true, titleStrip: "SkyF1HD, 1080P" });
    const { sid } = await session(h);
    const page = await req(h, { method: "GET", url: `/jobs/${job}/post-actions`, sid });
    expect(page.body).toContain('name="title_nfo" value="on" checked');
    expect(page.body).toContain('value="SkyF1HD, 1080P"');
  });

  it("is off by default and turns off when the box is cleared", async () => {
    const h = await boot();
    const job = seedJob(h);
    await post(h, `/jobs/${job}/post-actions`, { extract: "off", title_nfo: "on" });
    await post(h, `/jobs/${job}/post-actions`, { extract: "off" });
    expect(h.deps.stores.post.get(job).titleNfo).toBe(false);
  });

  it("rejects an over-long strip list and saves nothing", async () => {
    const h = await boot();
    const job = seedJob(h);
    const res = await post(h, `/jobs/${job}/post-actions`, { extract: "off", title_nfo: "on", title_strip: "x".repeat(250) }, true);
    expect(res.body).toContain("at most 200");
    expect(h.deps.stores.post.get(job).titleNfo).toBe(false);
  });
});
