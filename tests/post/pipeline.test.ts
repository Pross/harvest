import { describe, expect, it, vi } from "vitest";
import type { JobConfig } from "../../src/domain.js";
import { buildLogger } from "../../src/logger.js";
import { createPostPipeline } from "../../src/post/index.js";
import type { AfterPromoteInput, AfterPromoteStep, ExtractStep } from "../../src/post/types.js";
import type { PostConfig } from "../../src/store/post-store.js";

const job = { id: 1 } as JobConfig;
const base = { job, runId: 1, signal: new AbortController().signal };
const logger = buildLogger("silent", false);
const mk = (cfg: Partial<PostConfig>, over: Partial<Parameters<typeof createPostPipeline>[0]> = {}) => {
  const calls: string[] = [];
  const step = (name: string, warnings: string[] = [], fail = false): AfterPromoteStep => ({
    run: async () => { calls.push(name); if (fail) throw new Error(`${name} boom`); return { warnings }; },
  });
  const extract: ExtractStep = { run: vi.fn(async () => ({ warnings: ["w"], added: ["/a"], removed: [] })) };
  const pipe = createPostPipeline({
    postStore: { get: () => ({ extract: "off", chmodFile: null, chmodDir: null, ...cfg }) }, extract, chmod: step("chmod"), arr: step("arr"), logger, ...over,
  });
  return { pipe, calls, extract, step };
};
const promoted = (): AfterPromoteInput => ({ ...base, unitKey: "u", finalPaths: ["/x"] });

describe("post pipeline", () => {
  it("skips extraction for jobs with extract off", async () => {
    const t = mk({});
    expect(await t.pipe.extractInStaging({ ...base, unitDir: "/u", files: [] })).toEqual({ warnings: [], added: [], removed: [] });
    expect(t.extract.run).not.toHaveBeenCalled();
  });

  it("extracts when enabled", async () => {
    const t = mk({ extract: "keep" });
    expect((await t.pipe.extractInStaging({ ...base, unitDir: "/u", files: [] })).added).toEqual(["/a"]);
  });

  it("turns an extraction error into a warning with empty results", async () => {
    const t = mk({ extract: "keep" }, { extract: { run: async () => { throw new Error("7z exploded"); } } });
    expect(await t.pipe.extractInStaging({ ...base, unitDir: "/u", files: [] })).toEqual({ warnings: ["extraction failed: 7z exploded"], added: [], removed: [] });
  });

  it("runs chmod before arr and merges warnings", async () => {
    const t = mk({});
    const calls: string[] = [];
    const pipe = createPostPipeline({ postStore: { get: () => ({ extract: "off", chmodFile: null, chmodDir: null }) }, extract: t.extract, logger,
      chmod: { run: async () => { calls.push("chmod"); return { warnings: ["c"] }; } }, arr: { run: async () => { calls.push("arr"); return { warnings: ["a"] }; } } });
    expect(await pipe.afterPromote(promoted())).toEqual({ warnings: ["c", "a"] });
    expect(calls).toEqual(["chmod", "arr"]);
  });

  it("a failing chmod does not stop arr and never throws", async () => {
    const t = mk({});
    const { step } = t;
    const calls: string[] = [];
    const pipe = createPostPipeline({ postStore: { get: () => ({ extract: "off", chmodFile: null, chmodDir: null }) }, extract: t.extract, logger,
      chmod: { run: async () => { calls.push("chmod"); throw new Error("nope"); } }, arr: step("arr") });
    const r = await pipe.afterPromote(promoted());
    expect(r.warnings).toEqual(["chmod failed: nope"]);
    expect(t.calls).toEqual(["arr"]);
    expect(calls).toEqual(["chmod"]);
  });

  it("afterRun is a no-op without a notifier and contains notifier errors", async () => {
    const input = { job, runId: 1, state: "succeeded" as const, summary: { filesOk: 1, filesFailed: 0, filesSkipped: 0, bytesDone: 1, durationMs: 1, error: null, warnings: [] } };
    expect(await mk({}).pipe.afterRun(input)).toEqual({ warnings: [] });
    const t = mk({}, { notifier: { run: async () => { throw new Error("smtp down"); } } });
    expect(await t.pipe.afterRun(input)).toEqual({ warnings: ["notifications failed: smtp down"] });
  });
});
