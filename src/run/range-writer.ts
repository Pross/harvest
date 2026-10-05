import { constants, promises as fsp } from "node:fs";
import path from "node:path";
import { PermanentError } from "../errors.js";

/** A stream delivered bytes beyond the end of its range. The surplus is never written. */
export class RangeOverrun extends PermanentError {}

export interface RangeWriter {
  /** Writes `chunk` at `offset`; throws RangeOverrun (writing nothing) if it would cross `rangeEnd`. */
  write(offset: number, chunk: Uint8Array, rangeEnd: number): Promise<void>;
  fsync(): Promise<void>;
  close(): Promise<void>;
}

/** Opens (creating if needed) the staging file and sets its length to `size` once. Existing content is kept. */
export async function openRangeWriter(file: string, size: number): Promise<RangeWriter> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const fh = await fsp.open(file, constants.O_RDWR | constants.O_CREAT, 0o644);
  try {
    await fh.truncate(size);
  } catch (err) {
    await fh.close();
    throw err;
  }
  return {
    async write(offset, chunk, rangeEnd) {
      if (offset + chunk.length > rangeEnd) {
        throw new RangeOverrun(`range overrun: ${offset + chunk.length - rangeEnd} surplus bytes past offset ${rangeEnd}`);
      }
      let done = 0;
      while (done < chunk.length) {
        const { bytesWritten } = await fh.write(chunk, done, chunk.length - done, offset + done);
        if (bytesWritten === 0) throw new PermanentError(`staging write made no progress at offset ${offset + done}`);
        done += bytesWritten;
      }
    },
    fsync: () => fh.sync(),
    close: () => fh.close(),
  };
}
