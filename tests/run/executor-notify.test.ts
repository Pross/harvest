import { describe, expect, it, vi } from "vitest";
import type { PostPipeline, PostResult } from "../../src/post/types.js";
import { makeData } from "../helpers/fake-session.js";
import { makeHarness } from "./executor-harness.js";

type AfterRunInput = Parameters<PostPipeline["afterRun"]>[0];
const pipeline = (afterRun: (i: AfterRunInput) => Promise<PostResult>): PostPipeline => ({
  extractInStaging: async () => ({ warnings: [], added: [], removed: [] }),
  afterPromote: async () => ({ warnings: [] }),
  afterRun,
});

describe("executor notifications", () => {
  it("run after the terminal state is stored, with an abort signal", async () => {
    let seen: { stored: string | undefined; signal: boolean; state: string } | undefined;
    const h = makeHarness({ deps: { post: pipeline(async (i) => {
      seen = { stored: h.stores.runs.get(i.runId)?.state, signal: i.signal instanceof AbortSignal, state: i.state };
      return { warnings: [] };
    }) } });
    h.session.set("Pack/a.bin", makeData(3000, 1));
    const res = await h.settled();
    expect(res.state).toBe("succeeded");
    expect(seen).toEqual({ stored: "succeeded", signal: true, state: "succeeded" });
  });

  it("a failed run is stored first and the notifier sees its error", async () => {
    const afterRun = vi.fn(async (i: AfterRunInput) => ({ warnings: i.summary.error ? [] : ["no error in summary"] }));
    const h = makeHarness({ deps: { post: pipeline(afterRun) } });
    h.session.failList = new Error("listing exploded");
    const res = await h.exec();
    expect(res.state).toBe("failed");
    expect(afterRun.mock.calls[0]![0]).toMatchObject({ state: "failed", summary: { error: "listing exploded" } });
    expect(h.activity().some((a) => a.category === "notify")).toBe(false);
  });

  it("a notifier reporting delivery failures cannot change the stored state (activity entry only)", async () => {
    const h = makeHarness({ deps: { post: pipeline(async () => ({ warnings: ["notification hook failed: HTTP 500"] })) } });
    h.session.set("Pack/a.bin", makeData(3000, 1));
    const res = await h.settled();
    expect(res.row.state).toBe("succeeded");
    expect(h.activity().filter((a) => a.category === "notify" && a.summary.includes("HTTP 500"))).toHaveLength(1);
  });

  it("does not notify a succeeded run that had nothing to do", async () => {
    const afterRun = vi.fn(async () => ({ warnings: [] }));
    const h = makeHarness({ deps: { post: pipeline(afterRun) } });
    const res = await h.settled();
    expect(res.state).toBe("succeeded");
    expect(afterRun).not.toHaveBeenCalled();
  });

  it("still notifies a run that ended skipped_space", async () => {
    const afterRun = vi.fn(async () => ({ warnings: [] }));
    const h = makeHarness({ deps: { post: pipeline(afterRun) }, freeBytes: 10 });
    h.session.set("Pack/a.bin", makeData(3000, 1));
    const res = await h.settled();
    expect(res.state).toBe("skipped_space");
    expect(afterRun).toHaveBeenCalledTimes(1);
  });
});
