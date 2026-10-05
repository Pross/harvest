import { execFile, spawnSync } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const COMPOSE_FILE = path.join(ROOT, "docker-compose.test.yml");
export const PROJECT = "harvest-it";
export const SERVICES = ["ftp", "ftps-explicit", "ftps-implicit", "sftp"] as const;
export type Service = (typeof SERVICES)[number];

/** True when the docker CLI and daemon answer within 10 s. Safe to call at collection time. */
export function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["compose", "version"], { timeout: 10_000 });
  if (r.status !== 0) return false;
  return spawnSync("docker", ["info"], { timeout: 10_000 }).status === 0;
}

/** Run `docker compose -f docker-compose.test.yml <args>` with a hard timeout (default 120 s). */
export async function compose(args: string[], timeoutMs = 120_000, input?: Buffer): Promise<{ stdout: string; stderr: string }> {
  const child = execFileP("docker", ["compose", "-f", COMPOSE_FILE, "-p", PROJECT, ...args], {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    cwd: ROOT,
    encoding: "utf8",
  });
  if (input) child.child.stdin?.end(input);
  return child;
}

/** `docker compose exec -T` as root in a service; returns stdout. */
export async function exec(service: Service, cmd: string[], timeoutMs = 60_000): Promise<string> {
  return (await compose(["exec", "-T", "-u", "root", service, ...cmd], timeoutMs)).stdout;
}

export async function composeUp(timeoutMs = 280_000): Promise<void> {
  await compose(["up", "-d", "--build"], timeoutMs);
}

export async function composeDown(timeoutMs = 120_000): Promise<void> {
  await compose(["down", "-v", "--remove-orphans", "-t", "2"], timeoutMs);
}

export const PORTS: Record<Service, number> = { ftp: 2121, "ftps-explicit": 2122, "ftps-implicit": 2990, sftp: 2222 };

/** One TCP connect attempt that resolves true on connect, false on error or timeout. */
export function canConnect(port: number, host = "127.0.0.1", timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** Bounded retry: at most `attempts` connects, `delayMs` apart. Throws when the port never opens. */
export async function waitForPort(port: number, attempts = 40, delayMs = 500): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await canConnect(port)) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`port ${port} did not open after ${attempts} attempts`);
}

export async function waitForAll(): Promise<void> {
  await Promise.all(SERVICES.map((s) => waitForPort(PORTS[s])));
}

/** Container id of a service (for `docker run --network container:<id>` and kill). */
export async function containerId(service: Service): Promise<string> {
  const { stdout } = await compose(["ps", "-q", service], 20_000);
  const id = stdout.trim();
  if (!id) throw new Error(`service ${service} is not running`);
  return id;
}
