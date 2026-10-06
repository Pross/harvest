import type { HostConfig, Protocol } from "../domain.js";
import { checkConnections, checkMtime, checkResume, recommendConnections, type ResumeResult } from "./probe-checks.js";
import type { RemoteEntry, TransferEngine } from "./types.js";

export type ProbeStep = { label: string; ok: boolean; detail: string };
export type ProbeSettings = { protocol: Protocol; port: number; tlsAcceptSelfSigned: boolean; maxConnections: number };
export type ProbeResult = {
  /** Some connection method worked. */
  ok: boolean;
  /** The working method encrypts the connection. */
  secure: boolean;
  steps: ProbeStep[];
  recommend: ProbeSettings | null;
  /** The server reports modification times, so a job can use "Trust mtime". */
  trustMtime: boolean;
  mtime: boolean | null;
  resume: ResumeResult;
  connections: number | null;
  notes: string[];
};

type Candidate = { label: string; protocol: Protocol; port: number; selfSigned: boolean };

const TLS_LABEL: Record<string, string> = { ftps_explicit: "FTPS (explicit TLS)", ftps_implicit: "FTPS (implicit TLS)" };

/**
 * Connection methods to try, most secure first: a verified certificate before a self-signed one. The probe never
 * suggests less security than the protocol already chosen: plain FTP is only tried when the host is plain FTP.
 */
export function candidates(host: HostConfig): Candidate[] {
  const explicit = (selfSigned: boolean): Candidate => ({
    label: `${TLS_LABEL["ftps_explicit"]}, ${selfSigned ? "any certificate" : "verified certificate"}`,
    protocol: "ftps_explicit", port: host.protocol === "ftps_implicit" ? 21 : host.port, selfSigned,
  });
  const implicit = (selfSigned: boolean): Candidate => ({
    label: `${TLS_LABEL["ftps_implicit"]}, ${selfSigned ? "any certificate" : "verified certificate"}`,
    protocol: "ftps_implicit", port: host.protocol === "ftps_implicit" ? host.port : 990, selfSigned,
  });
  const plain: Candidate = { label: "Plain FTP (unencrypted)", protocol: "ftp", port: host.port, selfSigned: false };
  if (host.protocol === "ftps_implicit") return [implicit(false), implicit(true)];
  if (host.protocol === "ftps_explicit") return [explicit(false), explicit(true)];
  if (host.protocol === "ftp") return [explicit(false), explicit(true), plain];
  return [];
}

const empty = (notes: string[], steps: ProbeStep[] = []): ProbeResult =>
  ({ ok: false, secure: false, steps, recommend: null, trustMtime: false, mtime: null, resume: "untested", connections: null, notes });

type Found = { mtime: boolean | null; resume: ResumeResult; connections: number | null };

async function inspect(engine: TransferEngine, cfg: HostConfig, root: RemoteEntry[]): Promise<Found> {
  try {
    const session = await engine.open(cfg);
    try {
      return { mtime: checkMtime(root), resume: await checkResume(session, root), connections: await checkConnections(session, root) };
    } finally {
      await session.close();
    }
  } catch {
    return { mtime: checkMtime(root), resume: "untested", connections: null };
  }
}

function summarize(c: Candidate, steps: ProbeStep[], found: Found, current: number): ProbeResult {
  const secure = c.protocol !== "ftp";
  const notes: string[] = [];
  if (!secure) notes.push("Only unencrypted FTP works: your password and files travel in the clear. Ask your provider whether FTPS or SFTP is available.");
  if (c.selfSigned) notes.push("The certificate could not be verified, so Harvest has to accept any certificate. That is encrypted but not authenticated.");
  if (found.resume === "failed") notes.push("Resuming a partial download did not work on this server: an interrupted download will start over.");
  if (found.mtime === false) notes.push("The server reports no modification times, so keep Trust mtime off and rely on the settle check.");
  const { connections } = found;
  if (connections === null) notes.push("The connection limit was not measured: it needs a file of at least 2 MiB on the server to hold logins open. Keep your current limit.");
  else if (connections < 2) notes.push("The server allowed only one login at a time, so transfers will be slow.");
  return {
    ok: true, secure, steps, trustMtime: found.mtime === true, mtime: found.mtime, resume: found.resume, connections, notes,
    recommend: { protocol: c.protocol, port: c.port, tlsAcceptSelfSigned: c.selfSigned, maxConnections: connections === null ? current : recommendConnections(connections) },
  };
}

/**
 * Finds the most secure connection method that works for an FTP-family host, then checks mtimes, resume and the
 * connection limit on it. Read-only: it only lists, reads a few KiB of one file, and opens a handful of logins.
 * `explain` turns an engine error into text that is safe to show (no credentials).
 */
export async function probeHost(engine: TransferEngine, host: HostConfig, explain: (err: unknown) => string): Promise<ProbeResult> {
  const tries = candidates(host);
  if (tries.length === 0) return empty(["The probe is for FTP and FTPS servers. SFTP is always encrypted: use Test connection."]);
  const steps: ProbeStep[] = [];
  for (const c of tries) {
    const cfg: HostConfig = { ...host, protocol: c.protocol, port: c.port, tlsAcceptSelfSigned: c.selfSigned, hostKeys: null };
    let root: RemoteEntry[];
    try {
      root = (await engine.testConnection(cfg)).rootListing;
    } catch (err) {
      steps.push({ label: c.label, ok: false, detail: explain(err) });
      continue;
    }
    // The first method that connects wins. Nothing after this point can send the probe to a less secure one.
    steps.push({ label: c.label, ok: true, detail: `connected, ${root.length} ${root.length === 1 ? "entry" : "entries"} at the root` });
    return summarize(c, steps, await inspect(engine, cfg, root), host.maxConnections);
  }
  return empty(["No connection method worked. Check the address, port, user name and password, then try again."], steps);
}
