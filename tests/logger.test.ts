import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildLogger, redactUrl } from "../src/logger.js";

function capture() {
  let out = "";
  const stream = new Writable({
    write(chunk, _enc, cb) { out += chunk.toString(); cb(); },
  });
  return { stream, text: () => out };
}

const KEYS = [
  "secret", "password", "pass", "passphrase", "privateKey", "keyPassphrase", "secret_enc",
  "APP_SECRET", "ADMIN_PASS", "token", "authorization", "cookie",
];

describe("logger redaction", () => {
  it.each(KEYS)("redacts %s at top level, nested and doubly nested", (key) => {
    const { stream, text } = capture();
    const log = buildLogger("info", false, stream);
    const s = `S3CRET-${key}-VALUE`;
    log.info({ [key]: s, host: { [key]: s }, a: { b: { [key]: s } } }, "msg");
    expect(text()).not.toContain(s);
    expect(text()).toContain("[redacted]");
  });

  it("redacts headers", () => {
    const { stream, text } = capture();
    const log = buildLogger("info", false, stream);
    log.info({ headers: { authorization: "Bearer TOK123", cookie: "sid=COOKIE456" },
      req: { headers: { authorization: "Bearer TOK789" } } });
    for (const s of ["TOK123", "COOKIE456", "TOK789"]) expect(text()).not.toContain(s);
  });

  it("keeps non-secret fields", () => {
    const { stream, text } = capture();
    buildLogger("info", false, stream).info({ job: "movies" }, "hello");
    expect(text()).toContain("movies");
  });
});

describe("redactUrl", () => {
  it("removes query and fragment", () => {
    expect(redactUrl("https://h.test/hooks/jobs/1?token=abc#x")).toBe("https://h.test/hooks/jobs/1");
    expect(redactUrl("/hooks/jobs/1?token=abc")).toBe("/hooks/jobs/1");
    expect(redactUrl("/a#frag")).toBe("/a");
  });
  it("leaves clean URLs alone", () => {
    expect(redactUrl("/hooks/jobs/1")).toBe("/hooks/jobs/1");
  });
});
