import type { FastifyInstance } from "fastify";

export const MAX_STREAMS = 20;

export type Stream = {
  /** Cookie value of the session that opened the stream; null in AUTH_MODE=none. */
  sessionId: string | null;
  userId: number | null;
  close: () => void;
};

/** Registry of open SSE streams, so logout, password change and session expiry can end them and the total stays capped. */
export class StreamHub {
  private readonly streams = new Set<Stream>();

  constructor(private readonly max = MAX_STREAMS) {}

  get size(): number {
    return this.streams.size;
  }

  /** False when the cap is reached (the caller answers 503). */
  add(s: Stream): boolean {
    if (this.streams.size >= this.max) return false;
    this.streams.add(s);
    return true;
  }

  remove(s: Stream): void {
    this.streams.delete(s);
  }

  closeSession(sessionId: string): void {
    this.closeWhere((s) => s.sessionId === sessionId);
  }

  closeUser(userId: number): void {
    this.closeWhere((s) => s.userId === userId);
  }

  closeAll(): void {
    this.closeWhere(() => true);
  }

  private closeWhere(match: (s: Stream) => boolean): void {
    for (const s of [...this.streams]) if (match(s)) s.close();
  }
}

declare module "fastify" {
  interface FastifyInstance {
    streams: StreamHub;
  }
}

export function registerStreamHub(app: FastifyInstance): StreamHub {
  const hub = new StreamHub();
  app.decorate("streams", hub);
  return hub;
}
