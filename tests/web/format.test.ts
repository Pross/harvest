import { describe, expect, it } from "vitest";
import {
  escapeHtml, formatAbsolute, formatBytes, formatDuration, formatEta, formatRelative, formatSpeed, formatTime, sparklineSvg,
} from "../../src/web/format.js";
import { csrfField, isPublicPath } from "../../src/web/helpers.js";

describe("format", () => {
  it("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.50 KiB");
    expect(formatBytes(50 * 1024 * 1024)).toBe("50.0 MiB");
    expect(formatBytes(200 * 1024 ** 3)).toBe("200 GiB");
    expect(formatBytes(null)).toBe("-");
    expect(formatBytes(-1)).toBe("-");
  });

  it("formatSpeed", () => {
    expect(formatSpeed(2 * 1024 * 1024)).toBe("2.00 MiB/s");
    expect(formatSpeed(0)).toBe("-");
  });

  it("formatDuration and formatEta", () => {
    expect(formatDuration(9)).toBe("9s");
    expect(formatDuration(252)).toBe("4m 12s");
    expect(formatDuration(3900)).toBe("1h 05m");
    expect(formatDuration(null)).toBe("-");
    expect(formatEta(50, 100, 5)).toBe("10s");
    expect(formatEta(100, 100, 5)).toBe("-");
    expect(formatEta(0, 100, 0)).toBe("-");
  });

  it("formatRelative / formatTime", () => {
    const now = 1_700_000_000_000;
    expect(formatRelative(now - 1000, now)).toBe("just now");
    expect(formatRelative(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatRelative(now + 3 * 3600_000, now)).toBe("in 3 h");
    expect(formatRelative(now - 2 * 86400_000, now)).toBe("2 d ago");
    expect(formatAbsolute(0)).toBe("1970-01-01 00:00:00 UTC");
    expect(formatTime(now - 60_000, now)).toContain('title="2023-11-14 22:12:20 UTC"');
    expect(formatTime(null)).toContain("never");
  });

  it("escapeHtml, csrfField and sparkline are injection-safe", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
    expect(csrfField('"><script>')).toBe('<input type="hidden" name="_csrf" value="&quot;&gt;&lt;script&gt;">');
    expect(sparklineSvg([0, 5, 10])).toContain("<rect");
    expect((sparklineSvg([1, 2, 3, 4, 5, 6, 7]).match(/<rect/g) ?? []).length).toBe(7);
  });

  it("isPublicPath", () => {
    for (const p of ["/healthz", "/login?x=1", "/setup", "/static/vendor/htmx.min.js"]) expect(isPublicPath(p)).toBe(true);
    for (const p of ["/", "/events", "/hosts", "/static", "/loginx"]) expect(isPublicPath(p)).toBe(false);
  });
});
