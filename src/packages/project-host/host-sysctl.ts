import getLogger from "@cocalc/backend/logger";
import type { HostKernelSysctlSnapshot } from "@cocalc/conat/hub/api/hosts";
import { execFile as execFileCb } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const logger = getLogger("project-host:host-sysctl");
const execFile = promisify(execFileCb);

const CONFIG_PATH = "/etc/sysctl.d/90-cocalc-project-host.conf";
const ROOTCTL_PATH = "/usr/local/sbin/cocalc-project-host-rootctl";

export const PROJECT_HOST_SYSCTL_TARGETS: Record<string, number> = {
  "fs.inotify.max_user_instances": 8192,
  "fs.inotify.max_user_watches": 2_097_152,
  "fs.inotify.max_queued_events": 65_536,
  "kernel.keys.maxkeys": 20_000,
  "kernel.keys.maxbytes": 25_000_000,
};

function procPathForKey(key: string): string {
  return `/proc/sys/${key.replace(/\./g, "/")}`;
}

async function readSysctlValue(key: string): Promise<number | null> {
  try {
    const raw = await readFile(procPathForKey(key), "utf8");
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function buildProjectHostSysctlConfig(): string {
  return [
    "# Managed by CoCalc project-host.",
    "# Keep these limits high enough for many rootless project containers,",
    "# but low enough that drift is visible before one project can dominate.",
    ...Object.entries(PROJECT_HOST_SYSCTL_TARGETS).map(
      ([key, value]) => `${key} = ${value}`,
    ),
    "",
  ].join("\n");
}

export async function readProjectHostKernelSysctls(): Promise<HostKernelSysctlSnapshot> {
  const entries = await Promise.all(
    Object.keys(PROJECT_HOST_SYSCTL_TARGETS).map(async (key) => [
      key,
      await readSysctlValue(key),
    ]),
  );
  const values = Object.fromEntries(entries) as Record<string, number | null>;
  const mismatches = Object.entries(PROJECT_HOST_SYSCTL_TARGETS)
    .filter(([key, target]) => values[key] == null || values[key] < target)
    .map(([key, target]) => ({
      key,
      target,
      actual: values[key] ?? null,
    }));
  return {
    collected_at: new Date().toISOString(),
    config_path: CONFIG_PATH,
    targets: PROJECT_HOST_SYSCTL_TARGETS,
    values,
    ok: mismatches.length === 0,
    mismatches,
  };
}

async function applySysctlConfigAsRoot(): Promise<void> {
  await writeFile(CONFIG_PATH, buildProjectHostSysctlConfig(), {
    mode: 0o644,
  });
  await execFile("sysctl", ["--system"]);
}

async function applySysctlConfigWithSudo(): Promise<void> {
  await execFile("sudo", ["-n", ROOTCTL_PATH, "apply-sysctls"]);
}

export async function ensureProjectHostKernelSysctls(): Promise<HostKernelSysctlSnapshot> {
  const before = await readProjectHostKernelSysctls();
  if (before.ok) return before;

  logger.warn("project-host kernel sysctl limits are below target", {
    mismatches: before.mismatches,
  });

  const useRoot =
    typeof process.geteuid === "function" && process.geteuid() === 0;
  try {
    if (useRoot) {
      await applySysctlConfigAsRoot();
    } else {
      await applySysctlConfigWithSudo();
    }
    const after = await readProjectHostKernelSysctls();
    if (after.ok) {
      logger.info("project-host kernel sysctl limits applied", {
        config_path: CONFIG_PATH,
      });
    } else {
      logger.warn("project-host kernel sysctl limits still below target", {
        mismatches: after.mismatches,
      });
    }
    return {
      ...after,
      apply_attempted: true,
      apply_succeeded: after.ok,
    };
  } catch (err) {
    logger.warn("failed to apply project-host kernel sysctl limits", {
      err: `${err}`,
    });
    const after = await readProjectHostKernelSysctls();
    return {
      ...after,
      apply_attempted: true,
      apply_succeeded: false,
      error: `${err}`,
    };
  }
}

export const _test = {
  buildProjectHostSysctlConfig,
  procPathForKey,
};
