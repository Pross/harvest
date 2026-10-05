import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineSession, RemoteEntry, TransferEngine } from "../../src/engine/types.js";
import type { HostConfig } from "../../src/domain.js";
import { AuthError, PermanentError } from "../../src/errors.js";
import { registerBrowseRoutes } from "../../src/web/routes-browse.js";
import { makeHarness, req, session, type Harness } from "./harness.js";

class BrowseEngine implements TransferEngine {
  readonly id = "rclone" as const;
  readonly capabilities = { hash: false, parallelRanges: true };
  opened: HostConfig[] = [];
  listed: string[] = [];
  closed = 0;
  entries: RemoteEntry[] = [];
  listError: Error | null = null;
  openError: Error | null = null;
  testConnection(): Promise<{ ok: true; rootListing: RemoteEntry[] }> {
    return Promise.resolve({ ok: true, rootListing: [] });
  }
  async open(host: HostConfig): Promise<EngineSession> {
    this.opened.push(host);
    if (this.openError) throw this.openError;
    const self = this;
    return {
      list: async (root: string) => {
        self.listed.push(root);
        if (self.listError) throw self.listError;
        return self.entries;
      },
      close: async () => { self.closed++; },
    } as unknown as EngineSession;
  }
}

const e = (name: string, isDir: boolean, size = 0): RemoteEntry => ({ path: name, size, mtimeMs: null, isDir });
const HX = { "hx-request": "true" };
type Ctx = { h: Harness; sid: string; engine: BrowseEngine; hostId: number };

let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harvest-br-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "movies", "2024"), { recursive: true });
  fs.mkdirSync(path.join(outside, "secret"), { recursive: true });
  fs.writeFileSync(path.join(root, "a-file.txt"), "x");
  fs.symlinkSync(outside, path.join(root, "escape"));
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

async function setup(): Promise<Ctx> {
  const h = await makeHarness({ routes: [registerBrowseRoutes], env: { BROWSE_ROOTS: root, CONFIG_DIR: path.join(base, "config") } });
  const engine = new BrowseEngine();
  h.deps.engine = engine;
  const hostId = h.deps.stores.hosts.create({ name: "box", protocol: "sftp", host: "h.example.org", port: 22, username: "u", secret: { password: "pw-S3CRET-value" } });
  return { h, engine, hostId, ...(await session(h)) };
}
const get = (c: Ctx, url: string, headers: Record<string, string> = HX) => req(c.h, { method: "GET", url, sid: c.sid, headers });

describe("remote browser", () => {
  it("lists one level, directories first, with breadcrumb and a use-this-folder action", async () => {
    const c = await setup();
    c.engine.entries = [e("zeta.txt", false, 2048), e("beta", true), e("Alpha", true), e("alpha.bin", false, 5)];
    const res = await get(c, `/browse/remote?host=${c.hostId}&path=/downloads/tv`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<html");
    expect(c.engine.listed).toEqual(["/downloads/tv"]);
    expect(res.body.indexOf("Alpha/")).toBeLessThan(res.body.indexOf("beta/"));
    expect(res.body.indexOf("beta/")).toBeLessThan(res.body.indexOf("alpha.bin"));
    expect(res.body).toContain("2.00 KiB");
    expect(res.body).toContain(`/browse/remote?host=${c.hostId}&amp;path=%2Fdownloads%2Ftv%2Fbeta`);
    expect(res.body).toContain("/browse/pick?field=remote_path&amp;value=%2Fdownloads%2Ftv");
    expect(res.body).toContain('hx-target="#remote_path-wrap"');
    expect(res.body).toContain(">downloads<");
  });

  it("uses the decrypted host config, closes the session and defaults to the root", async () => {
    const c = await setup();
    await get(c, `/browse/remote?host=${c.hostId}`);
    expect(c.engine.opened[0]?.secret.password).toBe("pw-S3CRET-value");
    expect(c.engine.listed).toEqual(["/"]);
    expect(c.engine.closed).toBe(1);
  });

  it("accepts the form field names host_id and remote_path", async () => {
    const c = await setup();
    await get(c, `/browse/remote?host_id=${c.hostId}&remote_path=/x/y/`);
    expect(c.engine.listed).toEqual(["/x/y"]);
  });

  it("collapses .. and never lets a path climb above the root", async () => {
    const c = await setup();
    await get(c, `/browse/remote?host=${c.hostId}&path=/a/../../..//b`);
    expect(c.engine.listed).toEqual(["/b"]);
  });

  it("asks for a host when none or an unknown one is given", async () => {
    const c = await setup();
    for (const q of ["", "?host=", "?host=999", "?host=abc"]) {
      const res = await get(c, `/browse/remote${q}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("Choose a host first");
    }
    expect(c.engine.opened).toHaveLength(0);
  });

  it("renders listing errors inline without secrets and still closes the session", async () => {
    const c = await setup();
    c.engine.listError = new PermanentError("550 /nope: no such directory pw-S3CRET-value\nstderr dump");
    const res = await get(c, `/browse/remote?host=${c.hostId}&path=/nope`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("The server refused the request");
    expect(res.body).toContain("no such directory");
    expect(res.body).not.toContain("pw-S3CRET-value");
    expect(res.body).not.toContain("stderr dump");
    expect(c.engine.closed).toBe(1);
  });

  it("renders connection errors inline", async () => {
    const c = await setup();
    c.engine.openError = new AuthError("bad login pw-S3CRET-value");
    const res = await get(c, `/browse/remote?host=${c.hostId}`);
    expect(res.body).toContain("Authentication failed");
    expect(res.body).not.toContain("pw-S3CRET-value");
    expect(c.engine.closed).toBe(0);
  });

  it("serves a full page without htmx", async () => {
    const c = await setup();
    c.engine.entries = [e("movies", true)];
    const res = await get(c, `/browse/remote?host=${c.hostId}`, {});
    expect(res.body).toContain("<html");
    expect(res.body).toContain("movies/");
  });

  it("escapes names from the remote server", async () => {
    const c = await setup();
    c.engine.entries = [e("<img src=x onerror=alert(1)>", true)];
    const res = await get(c, `/browse/remote?host=${c.hostId}`);
    expect(res.body).not.toContain("<img src=x");
    expect(res.body).toContain("&lt;img src=x");
  });

  it("requires a session", async () => {
    const c = await setup();
    const res = await req(c.h, { method: "GET", url: `/browse/remote?host=${c.hostId}` });
    expect(res.statusCode).toBe(303);
    expect(c.engine.opened).toHaveLength(0);
  });
});

describe("local browser", () => {
  it("shows the roots with free space at the top level", async () => {
    const c = await setup();
    const res = await get(c, "/browse/local");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(root);
    expect(res.body).toMatch(/free \d/);
    expect(res.body).not.toContain("Use this folder");
  });

  it("lists directories only, with breadcrumb, free space and a use-this-folder action", async () => {
    const c = await setup();
    const res = await get(c, `/browse/local?path=${encodeURIComponent(root)}`);
    expect(res.body).toContain("movies/");
    expect(res.body).not.toContain("a-file.txt");
    expect(res.body).toContain("Free space:");
    expect(res.body).toContain(`/browse/pick?field=local_path&amp;value=${encodeURIComponent(root)}`);
  });

  it("accepts the form field name local_path", async () => {
    const c = await setup();
    const res = await get(c, `/browse/local?local_path=${encodeURIComponent(path.join(root, "movies"))}`);
    expect(res.body).toContain("2024/");
  });

  it("refuses a symlink escape, outside paths and .. tricks", async () => {
    const c = await setup();
    for (const p of [path.join(root, "escape"), path.join(root, "escape", "secret"), outside, `${root}/movies/../../outside`, "/etc"]) {
      const res = await get(c, `/browse/local?path=${encodeURIComponent(p)}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("banner-warn");
      expect(res.body).not.toContain("secret/");
      expect(res.body).not.toContain("Use this folder");
    }
  });

  it("does not list the escaping symlink inside the root", async () => {
    const c = await setup();
    const res = await get(c, `/browse/local?path=${encodeURIComponent(root)}`);
    expect(res.body).not.toContain("escape/");
  });

  it("serves a full page without htmx", async () => {
    const c = await setup();
    expect((await get(c, "/browse/local", {})).body).toContain("<html");
  });
});

describe("pick fragment", () => {
  it("returns the input with the chosen value and empties the browser panel out of band", async () => {
    const c = await setup();
    const res = await get(c, `/browse/pick?field=remote_path&value=${encodeURIComponent("/downloads/tv")}`);
    expect(res.body).toContain('id="remote_path-wrap"');
    expect(res.body).toContain('name="remote_path" value="/downloads/tv"');
    expect(res.body).toContain('id="remote_path-browser" hx-swap-oob="true"');
  });

  it("escapes the value and rejects unknown fields", async () => {
    const c = await setup();
    const res = await get(c, `/browse/pick?field=local_path&value=${encodeURIComponent('"><script>x</script>')}`);
    expect(res.body).not.toContain("<script>");
    expect((await get(c, "/browse/pick?field=name&value=x")).statusCode).toBe(404);
    expect((await get(c, "/browse/pick?value=x")).statusCode).toBe(404);
  });
});
