import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryPartials } from "../helpers/memory-partials.js";
import { PermanentError } from "../../src/errors.js";
import { verifyComplete, verifyStagedSize } from "../../src/run/verify.js";

type R = { idx: number; startByte: number; endByte: number; durable: number };
function build(ranges: R[], size = 100) {
  const p = createMemoryPartials();
  const row = p.create(
    { jobId: 1, remotePath: "a", remoteSize: size, remoteMtimeMs: null, stagingPath: "/x" },
    ranges.map(({ idx, startByte, endByte }) => ({ idx, startByte, endByte })),
  );
  p.checkpoint(row.id, ranges.map((r) => ({ idx: r.idx, durableBytes: r.durable })));
  return { p, id: row.id };
}

describe("verifyComplete", () => {
  it("accepts ranges that tile the file and are fully durable", () => {
    const { p, id } = build([
      { idx: 0, startByte: 0, endByte: 40, durable: 40 },
      { idx: 1, startByte: 40, endByte: 100, durable: 60 },
    ]);
    expect(() => verifyComplete(p, id, 100)).not.toThrow();
  });

  it("accepts ranges stored out of order", () => {
    const { p, id } = build([
      { idx: 1, startByte: 50, endByte: 100, durable: 50 },
      { idx: 0, startByte: 0, endByte: 50, durable: 50 },
    ]);
    expect(() => verifyComplete(p, id, 100)).not.toThrow();
  });

  it("accepts an empty file with one empty range or none", () => {
    const a = build([{ idx: 0, startByte: 0, endByte: 0, durable: 0 }], 0);
    expect(() => verifyComplete(a.p, a.id, 0)).not.toThrow();
    const b = build([], 0);
    expect(() => verifyComplete(b.p, b.id, 0)).not.toThrow();
  });

  it("fails on a hole between ranges", () => {
    const { p, id } = build([
      { idx: 0, startByte: 0, endByte: 40, durable: 40 },
      { idx: 1, startByte: 50, endByte: 100, durable: 50 },
    ]);
    expect(() => verifyComplete(p, id, 100)).toThrow(/gap/);
  });

  it("fails on overlapping ranges", () => {
    const { p, id } = build([
      { idx: 0, startByte: 0, endByte: 60, durable: 60 },
      { idx: 1, startByte: 50, endByte: 100, durable: 50 },
    ]);
    expect(() => verifyComplete(p, id, 100)).toThrow(/overlap/);
  });

  it("fails when a range is short of durable bytes", () => {
    const { p, id } = build([
      { idx: 0, startByte: 0, endByte: 50, durable: 50 },
      { idx: 1, startByte: 50, endByte: 100, durable: 49 },
    ]);
    expect(() => verifyComplete(p, id, 100)).toThrow(PermanentError);
  });

  it("fails when durable exceeds the range length", () => {
    const { p, id } = build([{ idx: 0, startByte: 0, endByte: 100, durable: 101 }]);
    expect(() => verifyComplete(p, id, 100)).toThrow(/durable/);
  });

  it("fails when the ranges do not start at 0 or end at the expected size", () => {
    const a = build([{ idx: 0, startByte: 10, endByte: 100, durable: 90 }]);
    expect(() => verifyComplete(a.p, a.id, 100)).toThrow(/gap/);
    const b = build([{ idx: 0, startByte: 0, endByte: 90, durable: 90 }]);
    expect(() => verifyComplete(b.p, b.id, 100)).toThrow(/expected 100/);
    const c = build([]);
    expect(() => verifyComplete(c.p, c.id, 100)).toThrow(PermanentError);
  });
});

describe("verifyStagedSize", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes on the exact size and fails otherwise", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "verify-"));
    const f = path.join(dir, "f");
    writeFileSync(f, Buffer.alloc(10));
    await expect(verifyStagedSize(f, 10)).resolves.toBeUndefined();
    await expect(verifyStagedSize(f, 11)).rejects.toThrow(PermanentError);
  });

  it("propagates a missing file", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "verify-"));
    await expect(verifyStagedSize(path.join(dir, "nope"), 1)).rejects.toThrow(/ENOENT/);
  });
});
