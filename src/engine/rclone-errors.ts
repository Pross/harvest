import { AuthError, HarvestError, HostKeyChanged, PermanentError, TransientNetwork } from "../errors.js";

type Ctor = new (message: string) => HarvestError;

/** FTP reply code as a whole token: preceded by start, space, colon or quote; followed by space, dash or end. */
const ftpCode = (codes: string): string => `(?:^|[\\s:"])(?:${codes})(?:[\\s-]|$)`;

/**
 * First match wins, so order matters: host key problems, then transient overload replies that share a
 * code with auth failures (530 maximum number of clients), then auth, then the generic network patterns.
 * Patterns run over the STRUCTURAL message only (see structuralMessage), and codes/host key phrases are
 * anchored so a file name cannot trigger a fatal class.
 */
const RULES: ReadonlyArray<readonly [RegExp, Ctor]> = [
  [/knownhosts:|ssh: handshake failed:.*host key|host key mismatch|REMOTE HOST IDENTIFICATION HAS CHANGED/i, HostKeyChanged],
  [new RegExp(`${ftpCode("530")}.*maximum number of clients|too many connections|users \\(the maximum\\)`, "i"), TransientNetwork],
  [
    new RegExp(`${ftpCode("530")}|Permission denied \\(publickey|permission denied for login|unable to authenticate|unexpected message type 51|no supported methods remain|auth(entication)? failed|login (incorrect|failed|authentication failed)|invalid (user|password|credentials)|incorrect password|passphrase protected|decryption password incorrect|pem key not formatted|revealing password`, "i"),
    AuthError,
  ],
  [
    new RegExp(
      `time(d)? ?out|context deadline exceeded|connection (refused|reset|lost|closed)|use of closed network connection|broken pipe|\\bEOF\\b|${ftpCode("421|425|426|450|451|452")}|no route|network is unreachable|temporarily unavailable|no such host|host not found|temporary failure in name resolution`,
      "i",
    ),
    TransientNetwork,
  ],
];

const MAX_DETAIL = 300;
const LOG_PREFIX = /^(?:\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d )?(ERROR|CRITICAL|NOTICE)\s*:\s?/;

/** One stderr line without rclone's log prefix, the leading object name and any `Failed to <op>:` lead-in. */
function structuralLine(line: string): string {
  const m = LOG_PREFIX.exec(line);
  if (!m) return line;
  let rest = line.slice(m[0].length);
  if (m[1] === "ERROR") {
    const at = rest.indexOf(": ");
    if (at >= 0) rest = rest.slice(at + 2); // `ERROR : <object>: <message>`: drop the object name
  }
  const failed = [...rest.matchAll(/Failed to [a-z ]+?: /gi)].pop();
  return failed ? rest.slice(failed.index + failed[0].length) : rest;
}

/** The part of stderr that describes the failure, without object names a server (or user) controls. */
export function structuralMessage(stderr: string): string {
  return stderr.split("\n").map((l) => structuralLine(l.trim())).filter((l) => l !== "").join("\n");
}

function lastLine(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const line = lines.length > 0 ? lines[lines.length - 1]! : "no stderr output";
  return line.length > MAX_DETAIL ? line.slice(line.length - MAX_DETAIL) : line;
}

/** Maps a non-zero rclone exit (code plus stderr text) to the typed error callers retry or surface. */
export function mapRcloneError(exitCode: number | null, stderr: string): HarvestError {
  const message = `rclone exit ${exitCode ?? "signal"}: ${lastLine(stderr)}`;
  const text = structuralMessage(stderr);
  for (const [pattern, Type] of RULES) {
    if (pattern.test(text)) return new Type(message);
  }
  return new PermanentError(message);
}

/** rclone exit codes 3 (directory not found) and 4 (file not found) ONLY; message text is never trusted. */
export function isNotFound(exitCode: number | null): boolean {
  return exitCode === 3 || exitCode === 4;
}
