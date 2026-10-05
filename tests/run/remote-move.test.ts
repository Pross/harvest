import { describe, expect, it } from "vitest";
import { checkMoveTo, withSuffix } from "../../src/run/remote-move.js";

describe("checkMoveTo", () => {
  it("normalizes and strips trailing slashes", () => {
    expect(checkMoveTo("/done//x/", "/downloads")).toEqual({ ok: true, path: "/done/x" });
  });
  it("rejects empty, relative, root, dotdot, equal and nested targets", () => {
    for (const t of ["", "  ", "done", "/", "//", "/a/../b", "/downloads", "/downloads/", "/downloads/done", "/a\\b"]) {
      expect(checkMoveTo(t, "/downloads").ok, t).toBe(false);
    }
  });
  it("rejects everything when the remote path is the root", () => {
    expect(checkMoveTo("/done", "/").ok).toBe(false);
  });
  it("allows siblings with a shared name prefix", () => {
    expect(checkMoveTo("/downloads-done", "/downloads").ok).toBe(true);
  });
});

describe("withSuffix", () => {
  it("inserts the number before the extension", () => {
    expect(withSuffix("/d/a.mkv", 1)).toBe("/d/a.1.mkv");
    expect(withSuffix("/d/noext", 2)).toBe("/d/noext.2");
  });
});
