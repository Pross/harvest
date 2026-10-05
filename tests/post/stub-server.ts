import http from "node:http";
import type { AddressInfo } from "node:net";

export type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
export type Stub = { url: string; seen: Seen[]; close(): Promise<void> };
export type Reply = { status: number; body?: string; headers?: Record<string, string>; delayMs?: number };

/** Local HTTP server that records requests and answers with `reply(req)`. */
export async function startStub(reply: (r: Seen) => Reply = () => ({ status: 200, body: "{}" })): Promise<Stub> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() };
      seen.push(s);
      const r = reply(s);
      setTimeout(() => res.writeHead(r.status, r.headers).end(r.body ?? ""), r.delayMs ?? 0);
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(() => ok()); }) };
}
