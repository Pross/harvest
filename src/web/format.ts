/** Pure formatting helpers shared by views and fragments. en-US only. */

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return "-";
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${UNITS[i]}`;
}

export function formatSpeed(bps: number | null | undefined): string {
  if (!bps || !Number.isFinite(bps) || bps <= 0) return "-";
  return `${formatBytes(bps)}/s`;
}

/** Seconds as "1h 05m", "4m 12s", "9s". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "-";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Remaining time from bytes left and current speed; "-" when unknown. */
export function formatEta(bytesDone: number, bytesTotal: number, speedBps: number): string {
  if (!(speedBps > 0) || bytesTotal <= bytesDone) return "-";
  return formatDuration((bytesTotal - bytesDone) / speedBps);
}

const REL: [number, number, string][] = [
  [60, 1, "s"], [3600, 60, "min"], [86400, 3600, "h"], [86400 * 30, 86400, "d"],
];

/** "5 min ago", "in 3 h", "just now"; falls back to a date for far-away times. */
export function formatRelative(ts: number, now: number = Date.now()): string {
  const diff = Math.round((ts - now) / 1000);
  const abs = Math.abs(diff);
  if (abs < 5) return "just now";
  for (const [limit, div, unit] of REL) {
    if (abs < limit) {
      const n = Math.max(1, Math.floor(abs / div));
      return diff < 0 ? `${n} ${unit} ago` : `in ${n} ${unit}`;
    }
  }
  return new Date(ts).toISOString().slice(0, 10);
}

export function formatAbsolute(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

const HTML_ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Use only where output bypasses Eta's autoescape (helpers that return HTML strings). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESC[c] ?? c);
}

/** `<time>` element: relative text, absolute in the title. Emit with `<%~ %>`. Null renders "never". */
export function formatTime(ts: number | null | undefined, now: number = Date.now()): string {
  if (ts === null || ts === undefined) return '<span class="muted">never</span>';
  const iso = new Date(ts).toISOString();
  return `<time datetime="${iso}" title="${escapeHtml(formatAbsolute(ts))}">${escapeHtml(formatRelative(ts, now))}</time>`;
}

/** Inline SVG bar sparkline. Values are numbers only, so the result is safe to emit unescaped. */
export function sparklineSvg(values: number[], width = 280, height = 48): string {
  const max = Math.max(1, ...values);
  const gap = 4;
  const bw = (width - gap * (values.length - 1)) / Math.max(1, values.length);
  const bars = values.map((v, i) => {
    const h = v <= 0 ? 1 : Math.max(2, Math.round((v / max) * (height - 2)));
    return `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${height - h}" width="${bw.toFixed(1)}" height="${h}" rx="1"/>`;
  });
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" role="img" aria-label="Last 7 days of transferred volume">${bars.join("")}</svg>`;
}
