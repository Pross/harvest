import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { RunState } from "../../src/domain.js";
import { createEarlyNotifier } from "../../src/post/notify/early.js";
import { createRunNotifier } from "../../src/post/notify/index.js";
import { createEventBus } from "../../src/run/events.js";
import { createRunManager, type ManagedRunManager } from "../../src/run/manager.js";
import type { RunJob } from "../../src/run/manager-types.js";
import type { NotifyOn } from "../../src/store/integration-store.js";
import { startStub, type Stub } from "../post/stub-server.js";
import { setup } from "../store/helpers.js";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
// Positive assertions poll for the webhook; flush() is only for asserting that nothing arrives.
const settle = (seen: () => unknown[], n: number): Promise<void> =>
  n === 0 ? flush() : vi.waitFor(() => { expect(seen()).toHaveLength(n); }, { timeout: 2000, interval: 10 });
let stub: Stub | undefined;
let manager: ManagedRunManager | undefined;
afterEach(async () => { await manager?.stop(); await stub?.close(); stub = undefined; });

async function harness(notifyOn: NotifyOn, runJob: RunJob) {
  const base = setup();
  stub = await startStub();
  const channel = base.stores.channels.create({ name: "hook", kind: "webhook", config: { url: `${stub.url}/h` } });
  base.stores.integrations.set(base.jobId, { arrTargetId: null, arrPath: null, notifyOn, notifyChannelIds: [channel] });
  const logger = pino({ level: "silent" });
  const notifier = createRunNotifier(base.stores, logger);
  manager = createRunManager({
    runJob, stores: base.stores, bus: createEventBus(), logger, maxConcurrentRuns: 2, jitterMs: () => 0,
    notifyEnd: createEarlyNotifier(notifier, base.stores, logger),
  });
  return { ...base, manager, seen: () => stub!.seen.map((s) => JSON.parse(s.body) as { state: string; summary: { error: string } }) };
}

const throwing: RunJob = async () => { throw new Error("local path rejected: not allowed"); };
const never = (): RunJob => (_j, runId, signal) => new Promise<RunState>((resolve) => signal.addEventListener("abort", () => { resolve("cancelled"); }, { once: true }));

describe("notifications for runs that end before the executor", () => {
  it("a run that fails before the executor (e.g. rejected local path) notifies on failure mode", async () => {
    const h = await harness("failure", throwing);
    h.manager.trigger(h.jobId, "manual");
    await settle(h.seen, 1);
    expect(h.seen()[0]).toMatchObject({ state: "failed", summary: { error: "local path rejected: not allowed" } });
  });

  it("does not notify for dry runs or notify_on=never", async () => {
    const dry = await harness("always", throwing);
    dry.manager.trigger(dry.jobId, "manual", { dryRun: true });
    await flush();
    expect(dry.seen()).toEqual([]);
    await manager?.stop();
    await stub?.close();
    const never_ = await harness("never", throwing);
    never_.manager.trigger(never_.jobId, "manual");
    await flush();
    expect(never_.seen()).toEqual([]);
  });

  it("a job disabled before its run starts notifies only with notify_on=always", async () => {
    for (const [mode, expected] of [["failure", 0], ["always", 1]] as const) {
      const h = await harness(mode, never());
      h.manager.trigger(h.jobId, "manual");
      h.stores.jobs.update(h.jobId, { enabled: false });
      await settle(h.seen, expected);
      expect(h.seen()).toHaveLength(expected);
      await manager?.stop();
      await stub?.close();
    }
  });

  it("skipped_locked notifies only with notify_on=always", async () => {
    for (const [mode, expected] of [["failure", 0], ["always", 1]] as const) {
      const h = await harness(mode, never());
      h.manager.trigger(h.jobId, "manual");
      await flush();
      expect(h.manager.trigger(h.jobId, "manual").status).toBe("skipped_locked");
      await settle(h.seen, expected);
      expect(h.seen().map((e) => e.state)).toEqual(expected === 1 ? ["skipped_locked"] : []);
      await manager?.stop();
      await stub?.close();
    }
  });
});
