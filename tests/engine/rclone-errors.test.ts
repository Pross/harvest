import { describe, expect, it } from "vitest";
import { AuthError, HostKeyChanged, PermanentError, TransientNetwork } from "../../src/errors.js";
import { isNotFound, mapRcloneError } from "../../src/engine/rclone-errors.js";

const table: Array<[string, number, string, Function]> = [
  ["ftp 421 user cap (S2 spike)", 1, "ERROR : : error listing: 421 5 users (the maximum) are already logged in, sorry", TransientNetwork],
  ["ftp 530 login", 1, "CRITICAL: Failed to create file system: NewFs: failed to make FTP connection to \"h:21\": 530 Login incorrect.", AuthError],
  ["sftp bad key (S4 spike)", 1, "CRITICAL: Failed to create file system: NewFs: couldn't connect SSH: ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password], no supported methods remain", AuthError],
  ["sftp wrong password (real atmoz/sftp, integration run)", 1, "CRITICAL: Failed to create file system: NewFs: couldn't connect SSH: ssh: handshake failed: ssh: unexpected message type 51 (expected 60)", AuthError],
  ["sftp publickey", 1, "ssh: handshake failed: Permission denied (publickey,password).", AuthError],
  ["host key mismatch (S4 spike)", 1, "CRITICAL: Failed to create file system: NewFs: couldn't connect SSH: ssh: handshake failed: knownhosts: key mismatch", HostKeyChanged],
  ["host key unknown", 1, "NewFs: couldn't connect SSH: ssh: handshake failed: knownhosts: key is unknown", HostKeyChanged],
  ["host key pinned wrong", 1, "ssh: handshake failed: ssh: host key mismatch", HostKeyChanged],
  ["connection refused", 1, "dial tcp 10.0.0.1:22: connect: connection refused", TransientNetwork],
  ["connection reset", 1, "read tcp 1.2.3.4:5->6.7.8.9:21: read: connection reset by peer", TransientNetwork],
  ["i/o timeout", 1, "dial tcp 10.0.0.1:21: i/o timeout", TransientNetwork],
  ["EOF", 1, "ERROR : x: Failed to copy: failed to send packet payload: EOF", TransientNetwork],
  ["connection lost (S5 spike)", 1, "sftp: \"connection lost\" (ConnLost)", TransientNetwork],
  ["no route", 1, "dial tcp 10.9.9.9:22: connect: no route to host", TransientNetwork],
  ["too many connections", 1, "ftp: too many connections from this IP", TransientNetwork],
  ["ftp 425", 1, "ERROR : f: Failed to copy: 425 Can't open data connection", TransientNetwork],
  ["ftp 426", 1, "ERROR : f: Failed to copy: 426 Connection closed; transfer aborted", TransientNetwork],
  ["ftp 450", 1, "error listing: 450 Requested file action not taken", TransientNetwork],
  ["ftp 451", 1, "error listing: 451 Local error in processing", TransientNetwork],
  ["ftp 452", 1, "error listing: 452 Insufficient storage space", TransientNetwork],
  ["context deadline exceeded", 1, "Failed to create file system: context deadline exceeded", TransientNetwork],
  ["no such host", 1, "dial tcp: lookup nope.example: no such host", TransientNetwork],
  ["dns temporary failure", 1, "dial tcp: lookup h: Temporary failure in name resolution", TransientNetwork],
  ["host not found", 1, "NewFs: couldn't connect: host not found", TransientNetwork],
  ["closed network connection", 1, "read tcp 1.2.3.4:5->6.7.8.9:21: use of closed network connection", TransientNetwork],
  ["530 max clients is transient", 1, "NewFs: failed to make FTP connection to \"h:21\": 530 Sorry, the maximum number of clients (5) from your host are already connected.", TransientNetwork],
  ["directory not found", 3, "Failed to lsjson: directory not found", PermanentError],
  ["object not found (S4 spike)", 4, "error in stat \"x\": object not found", PermanentError],
  ["file permission denied", 1, "sftp: \"Permission denied\" (SSH_FX_PERMISSION_DENIED)", PermanentError],
  ["unknown error", 1, "something odd", PermanentError],
  ["empty stderr", 1, "", PermanentError],
];

describe("mapRcloneError", () => {
  it.each(table)("%s", (_n, code, stderr, Type) => {
    const err = mapRcloneError(code, stderr);
    expect(err).toBeInstanceOf(Type);
    if (Type !== PermanentError) expect(err).not.toBeInstanceOf(PermanentError);
  });

  it("keeps only the last stderr line in the message and bounds its length", () => {
    const err = mapRcloneError(1, `first\n${"x".repeat(1000)}`);
    expect(err.message.length).toBeLessThan(400);
    expect(err.message).not.toContain("first");
  });

  it("detects not found by exit code 3 or 4 only, never by message text", () => {
    expect(isNotFound(3)).toBe(true);
    expect(isNotFound(4)).toBe(true);
    expect(isNotFound(1)).toBe(false);
    expect(isNotFound(null)).toBe(false);
  });

  it("does not let file names trigger fatal or transient classes", () => {
    const hostile = [
      "ERROR : host key notes.txt: object not found",
      "ERROR : Show.S01E530.mkv: permission denied",
      "ERROR : timeout 421 EOF connection reset.txt: Failed to copy: permission denied",
      "ERROR : knownhosts: key mismatch.txt: object not found",
      "ERROR : 530 Login incorrect.txt: object not found",
    ];
    for (const line of hostile) expect(mapRcloneError(1, line)).toBeInstanceOf(PermanentError);
  });

  it("still classifies the structural message after a hostile object name", () => {
    expect(mapRcloneError(1, "ERROR : host key notes.txt: Failed to copy: read tcp: connection reset by peer")).toBeInstanceOf(TransientNetwork);
    expect(mapRcloneError(1, "ERROR : x.txt: Failed to copy: 530 Login incorrect.")).toBeInstanceOf(AuthError);
  });
});
