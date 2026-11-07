import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JobConfig } from "../../src/domain.js";
import { NFO_MARKER, createTitleStep, nfoPathFor, nfoXml, parseStrip, removeTitleNfo, titleFromFilename } from "../../src/post/title-nfo.js";
import type { PostConfig } from "../../src/store/post-store.js";

const NAME = "05.F1.2026.R20.São.Paulo.Grand.Prix.Free.Practice.Two.SkyF1HD.1080P.mkv";
const ctx = { job: { id: 1 } as JobConfig, runId: 1, signal: new AbortController().signal };
const step = (cfg: Partial<PostConfig> = {}) => createTitleStep({ postStore: { get: () => ({ extract: "off", chmodFile: null, chmodDir: null, titleNfo: true, titleStrip: "", ...cfg }) } });
const tmp = () => mkdtempSync(path.join(tmpdir(), "harvest-nfo-"));

describe("titleFromFilename", () => {
  it("turns dots into spaces and keeps non-ASCII", () => {
    expect(titleFromFilename(NAME, [])).toBe("05 F1 2026 R20 São Paulo Grand Prix Free Practice Two SkyF1HD 1080P");
  });
  it("removes listed tokens as whole words, ignoring case", () => {
    expect(titleFromFilename(NAME, parseStrip("skyf1hd, 1080p"))).toBe("05 F1 2026 R20 São Paulo Grand Prix Free Practice Two");
    expect(titleFromFilename("a.b1080P.c.mkv", ["1080p"])).toBe("a b1080P c");
  });
  it("handles underscores and a directory in the path", () => {
    expect(titleFromFilename("/x/y/My_Show__S01E02.mkv", [])).toBe("My Show S01E02");
  });
});

describe("nfoXml", () => {
  it("escapes markup and carries the marker", () => {
    const x = nfoXml(`A & B <"c">`);
    expect(x).toContain(NFO_MARKER);
    expect(x).toContain("<title>A &amp; B &lt;&quot;c&quot;&gt;</title>");
    expect(x.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')).toBe(true);
  });
});

describe("title step", () => {
  it("writes an .nfo beside each video and skips other files", async () => {
    const dir = tmp();
    const video = path.join(dir, NAME);
    const other = path.join(dir, "readme.txt");
    const res = await step({ titleStrip: "SkyF1HD, 1080P" }).run({ ...ctx, files: [video, other] });
    expect(res.added).toEqual([nfoPathFor(video)]);
    expect(readFileSync(nfoPathFor(video), "utf8")).toContain("<title>05 F1 2026 R20 São Paulo Grand Prix Free Practice Two</title>");
    expect(existsSync(path.join(dir, "readme.nfo"))).toBe(false);
  });

  it("does nothing when switched off", async () => {
    const dir = tmp();
    expect(await step({ titleNfo: false }).run({ ...ctx, files: [path.join(dir, NAME)] })).toEqual({ warnings: [], added: [] });
    expect(existsSync(nfoPathFor(path.join(dir, NAME)))).toBe(false);
  });

  it("leaves an .nfo that is not Harvest's alone, but rewrites its own", async () => {
    const dir = tmp();
    const video = path.join(dir, "a.mkv");
    writeFileSync(nfoPathFor(video), "<movie><title>Mine</title></movie>");
    expect((await step().run({ ...ctx, files: [video] })).added).toEqual([]);
    expect(readFileSync(nfoPathFor(video), "utf8")).toContain("Mine");
    writeFileSync(nfoPathFor(video), nfoXml("old"));
    expect((await step().run({ ...ctx, files: [video] })).added).toEqual([nfoPathFor(video)]);
    expect(readFileSync(nfoPathFor(video), "utf8")).toContain("<title>a</title>");
  });

  it("warns instead of writing an empty title", async () => {
    const dir = tmp();
    const res = await step({ titleStrip: "1080p" }).run({ ...ctx, files: [path.join(dir, "1080p.mkv")] });
    expect(res.added).toEqual([]);
    expect(res.warnings[0]).toMatch(/nothing left/);
  });
});

describe("removeTitleNfo", () => {
  it("deletes only a Harvest-generated .nfo", async () => {
    const dir = tmp();
    const video = path.join(dir, "a.mkv");
    writeFileSync(nfoPathFor(video), "<movie/>");
    await removeTitleNfo(video);
    expect(existsSync(nfoPathFor(video))).toBe(true);
    writeFileSync(nfoPathFor(video), nfoXml("x"));
    await removeTitleNfo(video);
    expect(existsSync(nfoPathFor(video))).toBe(false);
    await removeTitleNfo(video); // missing: no throw
  });
});
