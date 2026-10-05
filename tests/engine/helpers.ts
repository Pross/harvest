import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HostConfig } from "../../src/domain.js";

export const FAKE_RCLONE = resolve("tests/fixtures/fake-rclone.sh");

export function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "harvest-engine-"));
}

export function scenario(tmp: string, cmd: string, opts: { out?: string | Buffer; err?: string; code?: number; sleep?: number }): void {
  const dir = join(tmp, "fake-rclone");
  mkdirSync(dir, { recursive: true });
  if (opts.out !== undefined) writeFileSync(join(dir, `${cmd}.out`), opts.out);
  if (opts.err !== undefined) writeFileSync(join(dir, `${cmd}.err`), opts.err);
  if (opts.code !== undefined) writeFileSync(join(dir, `${cmd}.code`), String(opts.code));
  if (opts.sleep !== undefined) writeFileSync(join(dir, `${cmd}.sleep`), String(opts.sleep));
}

export type Call = { id: string; argv: string[]; env: Record<string, string>; pid: number; stdin?: string; cfgExisted: boolean };

export function calls(tmp: string): Call[] {
  const dir = join(tmp, "fake-rclone", "calls");
  let files: string[] = [];
  try { files = readdirSync(dir); } catch { return []; }
  return files.filter((f) => f.endsWith(".argv")).map((f) => {
    const id = f.slice(0, -5);
    const read = (ext: string) => { try { return readFileSync(join(dir, `${id}.${ext}`), "utf8"); } catch { return undefined; } };
    const env: Record<string, string> = {};
    for (const line of (read("env") ?? "").split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    const argv = (read("argv") ?? "").replace(/\n$/, "").split("\n");
    return { id, argv, env, pid: Number(read("pid")), stdin: read("stdin"), cfgExisted: read("cfg") !== undefined };
  });
}

export const callsTo = (tmp: string, cmd: string): Call[] => calls(tmp).filter((c) => c.argv[0] === cmd);

export function host(over: Partial<HostConfig> = {}): HostConfig {
  return {
    id: 1, name: "box", protocol: "ftp", host: "ftp.example.com", port: 21, username: "alice",
    authKind: "password", secret: { password: "hunter2-secret" }, tlsAcceptSelfSigned: false,
    hostKeys: null, maxConnections: 4, ...over,
  };
}
