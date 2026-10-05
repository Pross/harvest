import { compose, type Service } from "./compose.js";

/** SIGKILL every process whose name matches inside a service container (uses `kill -9` over /proc, no pkill needed). */
export async function killInContainer(service: Service, processName: string): Promise<number> {
  const script = `n=0; for d in /proc/[0-9]*; do if [ "$(cat $d/comm 2>/dev/null)" = '${processName}' ]; then kill -9 \${d#/proc/} && n=$((n+1)); fi; done; echo $n`;
  const { stdout } = await compose(["exec", "-T", "-u", "root", service, "sh", "-c", script], 30_000);
  return Number(stdout.trim());
}

/** SIGKILL a host process by pid (e.g. the Harvest app or an rclone child). Returns false if it is already gone. */
export function killPid(pid: number): boolean {
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/** Kill the container's main process tree by restarting it hard (compose kill = SIGKILL). */
export async function killService(service: Service): Promise<void> {
  await compose(["kill", "-s", "SIGKILL", service], 30_000);
}
