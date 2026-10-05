import path from "node:path";

export type SanitizeResult = { ok: true; path: string } | { ok: false; detail: string };

const MAX_PATH_LENGTH = 1024;
const STAGING_DIR = ".harvest-staging";

function badSegment(seg: string): string | null {
  if (seg === "") return "empty segment";
  if (seg === "." || seg === "..") return `${seg} segment`;
  if (seg === STAGING_DIR) return `${STAGING_DIR} segment`;
  return null;
}

function badChars(rel: string): string | null {
  if (rel === "") return "empty path";
  if (rel.length > MAX_PATH_LENGTH) return "path longer than 1024 characters";
  if (rel.includes("\0")) return "NUL byte";
  if (rel.includes("\\")) return "backslash";
  if (rel.startsWith("/")) return "absolute path";
  return null;
}

function outsideRoot(localPath: string, rel: string): boolean {
  const root = path.posix.resolve(localPath);
  const target = path.posix.resolve(localPath, rel);
  return !target.startsWith(root === "/" ? "/" : `${root}/`);
}

/** Validates a remote-relative path and returns its NFC-normalized form, or the reason it is unsafe. */
export function sanitizeRemotePath(rel: string, localPath: string): SanitizeResult {
  const nfc = rel.normalize("NFC");
  const chars = badChars(nfc);
  if (chars) return { ok: false, detail: chars };
  for (const seg of nfc.split("/")) {
    const bad = badSegment(seg);
    if (bad) return { ok: false, detail: bad };
  }
  if (outsideRoot(localPath, nfc)) return { ok: false, detail: "resolves outside local path" };
  return { ok: true, path: nfc };
}
