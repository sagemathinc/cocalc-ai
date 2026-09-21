import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { podmanEnv } from "@cocalc/backend/podman/env";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("project-host:acp:harness-reaper");
export const HARNESS_OWNER_LABEL = "cocalc.acp.owner";

// Include boot and process start time: neither a reused PID nor a host reboot
// should keep an abandoned sidecar alive.
export async function harnessOwner(pid = process.pid): Promise<string> {
  const boot = (
    await readFile("/proc/sys/kernel/random/boot_id", "utf8")
  ).trim();
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw Object.assign(Error("ACP worker process is gone"), {
        code: "ACP_WORKER_NOT_FOUND",
      });
    throw error;
  }
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
  if (!/^[0-9a-f-]{36}$/.test(boot) || !/^\d+$/.test(start ?? ""))
    throw Error("Unable to identify ACP worker process");
  return `${pid}:${boot}:${start}`;
}

function podman(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "podman",
      args,
      { env: podmanEnv(), timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(`${stdout}`)),
    );
  });
}

export async function reapAbandonedHarnesses(): Promise<void> {
  const rows: unknown = JSON.parse(
    await podman([
      "ps",
      "--all",
      "--filter",
      "label=cocalc.runtime=acp",
      "--format",
      "json",
    ]),
  );
  if (!Array.isArray(rows)) throw Error("Invalid ACP container inventory");
  let failedRemovals = 0;
  for (const row of rows) {
    const id = row?.Id;
    const owner = row?.Labels?.[HARNESS_OWNER_LABEL];
    // Leave unlabeled/unknown versions alone. Never remove by name or project.
    if (
      typeof id !== "string" ||
      !/^[0-9a-f]{64}$/.test(id) ||
      typeof owner !== "string" ||
      !/^\d+:[0-9a-f-]{36}:\d+$/.test(owner)
    )
      continue;
    let alive: boolean;
    try {
      alive = (await harnessOwner(Number(owner.split(":")[0]))) === owner;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ACP_WORKER_NOT_FOUND")
        continue;
      alive = false;
    }
    if (alive) continue;
    try {
      await podman(["rm", "--ignore", "--force", "--time", "0", id]);
    } catch {
      // A stuck sidecar must not prevent cleanup of unrelated abandoned workers.
      // Keep the failure visible so subsequent sweeps retry the remaining work.
      failedRemovals++;
      continue;
    }
    // Rootfs leases belong to the old process; don't decrement this process's
    // references or unmount a rootfs still used by the primary project.
    logger.info("Removed abandoned ACP sidecar", { id });
  }
  if (failedRemovals)
    throw Error(`Unable to remove ${failedRemovals} abandoned ACP sidecar(s)`);
}

export function startHarnessReaper(): () => void {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      await reapAbandonedHarnesses();
    } catch {
      logger.warn("ACP sidecar reconciliation failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void sweep();
  }, 30_000);
  timer.unref();
  void sweep();
  return () => clearInterval(timer);
}
