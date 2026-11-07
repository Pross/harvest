import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLogger } from "../../src/logger.js";
import { createPostPipeline } from "../../src/post/index.js";
import { NFO_MARKER } from "../../src/post/title-nfo.js";
import { createTitleStep } from "../../src/post/title-nfo.js";
import { makeData } from "../helpers/fake-session.js";
import { makeHarness } from "./executor-harness.js";

const VIDEO = "05.F1.2026.R20.Grand.Prix.SkyF1HD.1080P.mkv";
const NFO = "05.F1.2026.R20.Grand.Prix.SkyF1HD.1080P.nfo";
const names = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((n) => !n.startsWith(".harvest-staging")).sort();

/** A harness whose pipeline has the real title step (extract and chmod are inert). */
function titled(job: Record<string, unknown> = {}, strip = "SkyF1HD, 1080P") {
  const h = makeHarness({ job });
  h.stores.post.set(h.jobId, { extract: "off", chmodFile: null, chmodDir: null, titleNfo: true, titleStrip: strip });
  const nothing = { run: async () => ({ warnings: [] }) };
  h.deps.post = createPostPipeline({
    postStore: h.stores.post, extract: { run: async () => ({ warnings: [], added: [], removed: [] }) }, chmod: nothing,
    title: createTitleStep({ postStore: h.stores.post }), logger: buildLogger("silent", false),
  });
  return h;
}

describe("title nfo through the executor", () => {
  it("promotes the .nfo with the video; the ledger only tracks the video and the video bytes are untouched", async () => {
    const h = titled();
    const data = makeData(3000, 1);
    h.session.set(VIDEO, data);
    expect((await h.settled()).state).toBe("succeeded");
    expect(names(h.local)).toEqual([VIDEO, NFO]);
    expect(readFileSync(path.join(h.local, NFO), "utf8")).toContain("<title>05 F1 2026 R20 Grand Prix</title>");
    expect(readFileSync(path.join(h.local, VIDEO)).equals(Buffer.from(data))).toBe(true);
    expect([...h.stores.ledger.active(h.jobId).keys()]).toEqual([VIDEO]);
    expect(h.stores.ledger.active(h.jobId).get(VIDEO)?.size).toBe(3000);
  });

  it("writes the .nfo inside a directory unit too (whole-folder promote)", async () => {
    const h = titled();
    h.session.set(`Show/${VIDEO}`, makeData(3000, 1));
    expect((await h.settled()).state).toBe("succeeded");
    expect(names(h.local)).toEqual(["Show", `Show/${VIDEO}`, `Show/${NFO}`]);
  });

  it("does nothing for a job with the switch off", async () => {
    const h = titled();
    h.stores.post.set(h.jobId, { extract: "off", chmodFile: null, chmodDir: null, titleNfo: false, titleStrip: "" });
    h.session.set(VIDEO, makeData(3000, 1));
    await h.settled();
    expect(names(h.local)).toEqual([VIDEO]);
  });

  it("an .nfo the remote ships is kept, ours is not written over it", async () => {
    const h = titled();
    h.session.set(VIDEO, makeData(3000, 1));
    h.session.set(NFO, makeData(40, 2));
    expect((await h.settled()).state).toBe("succeeded");
    expect(readFileSync(path.join(h.local, NFO)).length).toBe(40);
  });
});

describe("title nfo in mirror mode", () => {
  const armed = { mode: "mirror" as const, mirrorArmedAt: 1 };

  it("deletes the Harvest .nfo together with its video (after the two-sighting wait)", async () => {
    const h = titled(armed);
    h.session.set(VIDEO, makeData(3000, 1));
    h.session.set("keep.mkv", makeData(3000, 2));
    await h.settled();
    expect(existsSync(path.join(h.local, NFO))).toBe(true);
    h.session.files.delete(`/remote/${VIDEO}`);
    await h.exec();
    expect(existsSync(path.join(h.local, NFO))).toBe(true);
    await h.exec();
    expect(existsSync(path.join(h.local, VIDEO))).toBe(false);
    expect(existsSync(path.join(h.local, NFO))).toBe(false);
    expect(existsSync(path.join(h.local, "keep.mkv"))).toBe(true);
  });

  it("never deletes an .nfo that is not Harvest's", async () => {
    const h = titled(armed);
    h.session.set(VIDEO, makeData(3000, 1));
    h.session.set("keep.mkv", makeData(3000, 2));
    await h.settled();
    writeFileSync(path.join(h.local, NFO), "<episodedetails><title>Mine</title></episodedetails>");
    expect(readFileSync(path.join(h.local, NFO), "utf8")).not.toContain(NFO_MARKER);
    h.session.files.delete(`/remote/${VIDEO}`);
    await h.exec();
    await h.exec();
    expect(existsSync(path.join(h.local, VIDEO))).toBe(false);
    expect(readFileSync(path.join(h.local, NFO), "utf8")).toContain("Mine");
  });
});
