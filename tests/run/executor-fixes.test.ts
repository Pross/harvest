import { existsSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthError } from "../../src/errors.js";
import { createSlots, type Slots } from "../../src/run/connection-slots.js";
import { makeData } from "../helpers/fake-session.js";
import { makeHarness } from "./executor-harness.js";

const NFD = "Café/a.mkv";
const NFC = "Café/a.mkv";

describe("NFD remote names (item 6)", () => {
  it("uses the server's spelling for engine calls and the NFC form for ledger and local paths", async () => {
    const h = makeHarness({ job: { afterSync: "delete" }, session: { onStat: () => {} } });
    const data = makeData(6000, 1);
    h.session.set(NFD, data);
    const r = await h.settled();
    expect(r.state).toBe("succeeded");
    expect([...h.stores.ledger.active(h.jobId).keys()]).toEqual([NFC]);
    expect(readFileSync(path.join(h.local, NFC)).equals(data)).toBe(true);
    expect(h.session.removed).toEqual([`/remote/${NFD}`]);
    expect(h.stores.observations.all(h.jobId).has(NFC)).toBe(true);
  });
});

describe("connection slots for spawned commands (item 9)", () => {
  it("list, partial-reuse stat, recheck stat and hash all run while holding a slot", async () => {
    const slots = createSlots(9);
    let held = 0;
    const wrapped: Slots = { ...slots, acquireOne: async (s) => { const rel = await slots.acquireOne(s); held++; return () => { held--; rel(); }; } };
    const bad: string[] = [];
    const h = makeHarness({
      job: { verify: "checksum" },
      deps: { slotsFor: () => wrapped },
      session: { hash: async () => null },
    });
    const guard = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...a: A): R => (held === 0 && bad.push(name), fn(...a));
    h.session.list = guard("list", h.session.list.bind(h.session));
    h.session.stat = guard("stat", h.session.stat.bind(h.session));
    h.session.hash = guard("hash", h.session.hash!.bind(h.session));
    h.session.set("a.bin", makeData(5000, 1));
    await h.settled();
    expect(bad).toEqual([]);
    expect(held).toBe(0);
  });
});

describe("fatal errors abort sibling downloads (item 10)", () => {
  it("an AuthError in one file kills the in-flight sibling and fails the run promptly", async () => {
    const h = makeHarness({ job: { retries: 0, parallelFiles: 2 } });
    h.session.set("P/a.bin", makeData(8000, 1));
    h.session.set("P/b.bin", makeData(8000, 2));
    let hungSignal: AbortSignal | undefined;
    h.session.openRange = (abs, _o, _c, signal) => {
      if (abs.endsWith("b.bin")) {
        const s = new Readable({ read() {} });
        setTimeout(() => s.destroy(new AuthError("530 Login incorrect")), 20);
        return s;
      }
      hungSignal = signal;
      const s = new Readable({ read() {} });
      signal.addEventListener("abort", () => s.destroy(Object.assign(new Error("killed"), { name: "AbortError" })), { once: true });
      return s; // never delivers anything
    };
    const started = Date.now();
    const r = await h.settled();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.state).toBe("failed");
    expect(hungSignal?.aborted).toBe(true);
    expect(r.row.error).toContain("530");
  });
});

describe("progress bookkeeping (item 19)", () => {
  it("a held unit leaves no finished file in the active progress list", async () => {
    const h = makeHarness({ job: { retries: 0 } });
    h.session.set("P/a.bin", makeData(5000, 1));
    h.session.set("P/b.bin", makeData(5000, 2));
    const open = h.session.openRange.bind(h.session);
    h.session.openRange = (abs, off, count, signal) => {
      if (abs.endsWith("b.bin")) throw new Error("nope");
      return open(abs, off, count, signal);
    };
    await h.settled();
    const progress = h.events.filter((e) => e.type === "run.progress");
    expect(progress.at(-1)).toMatchObject({ activeFiles: [] });
  });

  it("flushes pending bytes when a fatal error propagates", async () => {
    let fail: (() => void) | undefined;
    const h = makeHarness({
      job: { retries: 0, parallelFiles: 2 },
      session: { onChunk: (sent) => void (sent > 20_000 && fail?.()) },
    });
    h.session.set("P/a.bin", makeData(200_000, 1));
    h.session.set("P/b.bin", makeData(8000, 2));
    const open = h.session.openRange.bind(h.session);
    h.session.openRange = (abs, off, count, signal) => {
      if (!abs.endsWith("b.bin")) return open(abs, off, count, signal);
      const s = new Readable({ read() {} });
      fail = () => s.destroy(new AuthError("530 nope"));
      return s;
    };
    const r = await h.settled();
    expect(r.state).toBe("failed");
    expect(r.row.bytesDone).toBeGreaterThan(0);
  });
});

describe("free space re-check before each unit (item 12)", () => {
  it("drops a unit that no longer fits, records a reason and counts its files as skipped", async () => {
    let calls = 0;
    const h = makeHarness({ deps: { statfs: async () => ({ bavail: ++calls <= 2 ? 1e12 : 100, bsize: 1 }) } });
    h.session.set("A/a.bin", makeData(5000, 1));
    h.session.set("B/a.bin", makeData(5000, 2));
    h.session.set("B/b.bin", makeData(5000, 3));
    const r = await h.settled();
    expect(r.state).toBe("partial");
    expect(existsSync(path.join(h.local, "A/a.bin"))).toBe(true);
    expect(existsSync(path.join(h.local, "B"))).toBe(false);
    expect(r.row.filesSkipped).toBe(2);
    expect(r.row.filesOk).toBe(1);
    expect(h.activity().some((a) => a.category === "space" && a.summary.includes("B") && a.summary.includes("transfer time"))).toBe(true);
  });

  it("counts files of units dropped by the initial fit as skipped", async () => {
    const h = makeHarness({ freeBytes: 12_000 });
    h.session.set("Big/a.bin", makeData(10_000, 1));
    h.session.set("Big/b.bin", makeData(10_000, 2));
    h.session.set("Small/a.bin", makeData(5000, 3));
    expect((await h.settled()).row.filesSkipped).toBe(2);
  });
});
