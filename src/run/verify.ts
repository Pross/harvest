import { promises as fsp } from "node:fs";
import { PermanentError } from "../errors.js";
import type { PartialsStore } from "./types.js";

/** Throws unless the ranges tile [0, expectedSize) exactly and every range is fully durable. */
export function verifyComplete(partials: PartialsStore, partialId: number, expectedSize: number): void {
  const rows = [...partials.ranges(partialId)].sort((a, b) => a.startByte - b.startByte || a.idx - b.idx);
  let pos = 0;
  for (const r of rows) {
    if (r.startByte !== pos) {
      throw new PermanentError(`range ${r.idx} starts at ${r.startByte}, expected ${pos} (${r.startByte > pos ? "gap" : "overlap"})`);
    }
    if (r.endByte < r.startByte) throw new PermanentError(`range ${r.idx} ends before it starts`);
    if (r.durableBytes !== r.endByte - r.startByte) {
      throw new PermanentError(`range ${r.idx} has ${r.durableBytes} of ${r.endByte - r.startByte} bytes durable`);
    }
    pos = r.endByte;
  }
  if (pos !== expectedSize) throw new PermanentError(`ranges cover ${pos} bytes, expected ${expectedSize}`);
}

/** Size check on the staged file. Only meaningful after verifyComplete (the file is pre-sized). */
export async function verifyStagedSize(path: string, expectedSize: number): Promise<void> {
  const st = await fsp.stat(path);
  if (st.size !== expectedSize) throw new PermanentError(`staged file is ${st.size} bytes, expected ${expectedSize}`);
}
