/** Failure of an outbound integration call. The message never contains the URL, headers or body (they may hold secrets). */
export class IntegrationHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationHttpError";
  }
}

export const REQUEST_TIMEOUT_MS = 15_000;

export type HttpRequest = {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  json?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Most bytes of the response body to read (default 500, enough for an error hint). */
  maxBytes?: number;
};

export type HttpResult = { status: number; text: string };

function describe(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "request timed out or was cancelled";
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" ? `network error (${code})` : "network error";
}

/** Reads at most `max` bytes of the body and cancels the rest. A body that cannot be read yields what was read so far. */
async function readText(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  try {
    while (got < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
    }
  } catch {
    /* partial body: use what arrived */
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

/**
 * One request with a timeout and no automatic redirects (secret-bearing requests must not follow a redirect to another host).
 * Returns 2xx results; throws IntegrationHttpError for network errors, redirects and non-2xx statuses.
 */
export async function httpRequest(req: HttpRequest): Promise<HttpResult> {
  const timeout = AbortSignal.timeout(req.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = req.signal ? AbortSignal.any([timeout, req.signal]) : timeout;
  const headers: Record<string, string> = { ...req.headers };
  if (req.json !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method ?? "GET", headers, redirect: "manual", signal,
      ...(req.json !== undefined ? { body: JSON.stringify(req.json) } : {}),
    });
  } catch (err) {
    throw new IntegrationHttpError(describe(err));
  }
  const text = await readText(res, req.maxBytes ?? 500);
  if (res.status >= 300 && res.status < 400) throw new IntegrationHttpError(`unexpected redirect (HTTP ${res.status}); use the final URL`);
  if (res.status < 200 || res.status >= 300) throw new IntegrationHttpError(`HTTP ${res.status}`);
  return { status: res.status, text };
}

/** Joins a base URL and an absolute path, keeping any path prefix of the base (reverse proxy sub-path). */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}
