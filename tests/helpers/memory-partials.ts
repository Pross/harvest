import type { PartialRow, PartialsStore, RangeRow } from "../../src/run/types.js";

export type MemoryPartials = PartialsStore & {
  /** Event names in call order: "create", "checkpoint", "discard". Shared with fsync spies when passed in. */
  log: string[];
  checkpoints: { partialId: number; snapshots: { idx: number; durableBytes: number }[] }[];
  discards: number[];
  /** Runs inside checkpoint() before the state changes (throw to simulate a DB failure). */
  onCheckpoint?: (partialId: number, snapshots: { idx: number; durableBytes: number }[]) => void;
};

export function createMemoryPartials(log: string[] = []): MemoryPartials {
  const rows = new Map<number, PartialRow>();
  const rangeRows = new Map<number, RangeRow[]>();
  let nextId = 1;
  const store: MemoryPartials = {
    log,
    checkpoints: [],
    discards: [],
    get(jobId, remotePath) {
      return [...rows.values()].find((r) => r.jobId === jobId && r.remotePath === remotePath);
    },
    create(row, ranges) {
      const created: PartialRow = { ...row, id: nextId++, promoteState: "downloading", finalPath: null };
      rows.set(created.id, created);
      rangeRows.set(created.id, ranges.map((r) => ({ ...r, partialId: created.id, durableBytes: 0 })));
      log.push("create");
      return created;
    },
    ranges(partialId) {
      return (rangeRows.get(partialId) ?? []).map((r) => ({ ...r }));
    },
    checkpoint(partialId, snapshots) {
      store.onCheckpoint?.(partialId, snapshots);
      const list = rangeRows.get(partialId);
      if (!list) throw new Error(`unknown partial ${partialId}`);
      for (const s of snapshots) {
        const r = list.find((x) => x.idx === s.idx);
        if (!r) throw new Error(`unknown range ${s.idx}`);
        r.durableBytes = s.durableBytes;
      }
      store.checkpoints.push({ partialId, snapshots: snapshots.map((s) => ({ ...s })) });
      log.push("checkpoint");
    },
    setPromoting(partialId, finalPath) {
      const r = rows.get(partialId);
      if (r) rows.set(partialId, { ...r, promoteState: "promoting", finalPath });
    },
    discard(partialId) {
      rows.delete(partialId);
      rangeRows.delete(partialId);
      store.discards.push(partialId);
      log.push("discard");
    },
    listPromoting() {
      return [...rows.values()].filter((r) => r.promoteState === "promoting");
    },
  };
  return store;
}
