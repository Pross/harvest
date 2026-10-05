import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { ROOT, containerId, type Service } from "./compose.js";

const execFileP = promisify(execFile);
const IMAGE = "harvest-it-netem";
let built = false;

async function docker(args: string[], timeoutMs: number): Promise<string> {
  return (await execFileP("docker", args, { timeout: timeoutMs, encoding: "utf8" })).stdout;
}

async function tc(service: Service, tcArgs: string[]): Promise<string> {
  if (!built) {
    await docker(["build", "-q", "-t", IMAGE, "-f", path.join(ROOT, "tests/integration/docker/Dockerfile.netem"), path.join(ROOT, "tests/integration/docker")], 120_000);
    built = true;
  }
  const id = await containerId(service);
  return docker(["run", "--rm", "--cap-add", "NET_ADMIN", "--network", `container:${id}`, IMAGE, "tc", ...tcArgs], 30_000);
}

/** Add egress delay (ms) on the server container's eth0. Optional; tests must not depend on it. */
export async function addDelay(service: Service, delayMs: number): Promise<void> {
  await removeDelay(service);
  await tc(service, ["qdisc", "add", "dev", "eth0", "root", "netem", "delay", `${delayMs}ms`, "limit", "100000"]);
}

export async function removeDelay(service: Service): Promise<void> {
  await tc(service, ["qdisc", "del", "dev", "eth0", "root"]).catch(() => undefined);
}
