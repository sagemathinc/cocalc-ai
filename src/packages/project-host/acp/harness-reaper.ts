import { execFile } from "node:child_process";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { podmanEnv } from "@cocalc/backend/podman/env";
import getLogger from "@cocalc/backend/logger";
import { reapManagedSandboxCommands } from "@cocalc/project-runner/run/sandbox-command-containment";
import {
  CLAUDE_CONTROLLER_HOME_LABEL,
  isManagedClaudeControllerHome,
  CLAUDE_TRANSCRIPT_STAGING_LABEL,
  isManagedClaudeTranscriptStaging,
} from "./claude-subscription-paths";

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
    const credentialHome = row?.Labels?.[CLAUDE_CONTROLLER_HOME_LABEL];
    if (isManagedClaudeControllerHome(credentialHome)) {
      try {
        const stat = await lstat(credentialHome);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw Error("Refusing unsafe Claude controller home cleanup");
        await rm(credentialHome, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          failedRemovals++;
          logger.warn("Unable to clean abandoned Claude controller home", {
            id,
          });
        }
      }
    }
    // Its staged transcripts: what the last turn wrote was already copied
    // back to the project when that turn ended.
    const transcripts = row?.Labels?.[CLAUDE_TRANSCRIPT_STAGING_LABEL];
    if (isManagedClaudeTranscriptStaging(transcripts)) {
      try {
        const stat = await lstat(transcripts);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw Error("Refusing unsafe Claude transcript staging cleanup");
        await rm(transcripts, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          failedRemovals++;
          logger.warn("Unable to clean abandoned Claude transcript staging", {
            id,
          });
        }
      }
    }
    // Rootfs leases belong to the old process; don't decrement this process's
    // references or unmount a rootfs still used by the primary project.
    logger.info("Removed abandoned ACP sidecar", { id });
  }
  failedRemovals += await reapOrphanedTranscriptStagings(rows);
  if (failedRemovals)
    throw Error(`Unable to remove ${failedRemovals} abandoned ACP sidecar(s)`);
}

// A staging directory is kept only while it may still be needed: one that no
// container refers to (a copy kept after its controller's copy back failed,
// or one whose controller never started) is removed once older than this.
export function transcriptStagingRetentionMs(): number {
  const configured = Number(
    process.env.COCALC_CLAUDE_TRANSCRIPT_STAGING_RETENTION_MS,
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : 6 * 60 * 60 * 1000;
}

async function reapOrphanedTranscriptStagings(
  rows: unknown[],
): Promise<number> {
  const referenced = new Set<string>();
  for (const row of rows) {
    const staging = (row as any)?.Labels?.[CLAUDE_TRANSCRIPT_STAGING_LABEL];
    if (isManagedClaudeTranscriptStaging(staging))
      referenced.add(resolve(staging));
  }
  let names: string[];
  try {
    names = await readdir(tmpdir());
  } catch {
    return 0;
  }
  const retention = transcriptStagingRetentionMs();
  let failed = 0;
  for (const name of names) {
    const staging = join(tmpdir(), name);
    if (!isManagedClaudeTranscriptStaging(staging) || referenced.has(staging))
      continue;
    try {
      const stat = await lstat(staging);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (Date.now() - stat.mtimeMs < retention) continue;
      await rm(staging, { recursive: true, force: true });
      logger.info("Removed orphaned Claude transcript staging", { staging });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        failed++;
        logger.warn("Unable to clean orphaned Claude transcript staging", {
          staging,
        });
      }
    }
  }
  return failed;
}

export function startHarnessReaper(): () => void {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      // Independent of Podman metadata and sidecar removal: a dead worker's
      // project jobs retain their root-owned identity until the scope is empty.
      await reapManagedSandboxCommands();
    } catch {
      logger.warn("Managed project job reconciliation failed");
    }
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
