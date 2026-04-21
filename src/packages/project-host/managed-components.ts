/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import path from "node:path";
import { readFileSync } from "node:fs";
import { data } from "@cocalc/backend/data";
import type {
  HostManagedComponentStatus,
  ManagedComponentKind,
  ManagedComponentUpgradePolicy,
  ManagedComponentVersionState,
} from "@cocalc/conat/project-host/api";
import { getSoftwareVersions } from "./software";
import { isProjectHostManagedLocalConatRouter } from "./conat-router";
import { isProjectHostExternalConatPersistEnabled } from "./conat-persist";
import {
  listProjectHostAcpWorkers,
  workerBundleVersionOf,
  resolveProjectHostAcpWorkerLaunch,
} from "./hub/acp/worker-manager";

type ManagedComponentSpec = {
  component: ManagedComponentKind;
  upgrade_policy: ManagedComponentUpgradePolicy;
  artifact: "project-host";
};

type ManagedComponentSnapshot = {
  enabled: boolean;
  managed: boolean;
  desired_version?: string;
  running_versions: string[];
  running_pids: number[];
};

const SPECS: ManagedComponentSpec[] = [
  {
    component: "project-host",
    artifact: "project-host",
    upgrade_policy: "restart_now",
  },
  {
    component: "conat-router",
    artifact: "project-host",
    upgrade_policy: "restart_now",
  },
  {
    component: "conat-persist",
    artifact: "project-host",
    upgrade_policy: "restart_now",
  },
  {
    component: "acp-worker",
    artifact: "project-host",
    upgrade_policy: "drain_then_replace",
  },
];

const ROUTER_PID_FILE = path.join(data, "conat-router.pid");
const PERSIST_PID_FILE = path.join(data, "conat-persist.pid");

function currentProjectHostVersion(): string | undefined {
  const versions = getSoftwareVersions();
  return (
    `${versions.project_host_build_id ?? ""}`.trim() ||
    `${versions.project_host ?? ""}`.trim() ||
    undefined
  );
}

function normalizeProjectHostRuntimeVersion(
  version: string | undefined,
): string | undefined {
  const normalized = `${version ?? ""}`.trim();
  if (!normalized) return;
  const versions = getSoftwareVersions();
  const currentVersion = `${versions.project_host ?? ""}`.trim();
  const currentBuildId = `${versions.project_host_build_id ?? ""}`.trim();
  if (currentBuildId && currentVersion && normalized === currentVersion) {
    return currentBuildId;
  }
  return normalized;
}

function readPidFile(pidFile: string): number | undefined {
  try {
    const raw = readFileSync(pidFile, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return;
  }
}

function isPidAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcCmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
}

function inferBundleVersionFromPid(pid: number): string | undefined {
  const cmdline = readProcCmdline(pid);
  for (const entry of cmdline) {
    const match = entry.match(/\/project-host\/bundles\/([^/]+)\//);
    if (match?.[1]) {
      return match[1];
    }
  }
  return;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return [
    ...new Set(values.filter((value): value is string => !!value?.trim())),
  ];
}

function versionStateOf({
  enabled,
  desired_version,
  running_versions,
}: Pick<
  ManagedComponentSnapshot,
  "enabled" | "desired_version" | "running_versions"
>): ManagedComponentVersionState {
  if (!enabled) {
    return "unknown";
  }
  if (running_versions.length === 0 || !desired_version) {
    return "unknown";
  }
  if (running_versions.length > 1) {
    return "mixed";
  }
  return running_versions[0] === desired_version ? "aligned" : "drifted";
}

export function summarizeManagedComponentStatus({
  component,
  artifact,
  upgrade_policy,
  enabled,
  managed,
  desired_version,
  running_versions,
  running_pids,
}: ManagedComponentSpec &
  ManagedComponentSnapshot): HostManagedComponentStatus {
  const runtime_state = !enabled
    ? "disabled"
    : managed && running_pids.length === 0
      ? "stopped"
      : running_pids.length > 0
        ? "running"
        : "unknown";
  return {
    component,
    artifact,
    upgrade_policy,
    enabled,
    managed,
    desired_version,
    runtime_state,
    version_state: versionStateOf({
      enabled,
      desired_version,
      running_versions,
    }),
    running_versions,
    running_pids,
  };
}

function routerSnapshot(): ManagedComponentSnapshot {
  const desired_version = currentProjectHostVersion();
  if (!isProjectHostManagedLocalConatRouter()) {
    return {
      enabled: true,
      managed: false,
      desired_version,
      running_versions: [],
      running_pids: [],
    };
  }
  const pid = readPidFile(ROUTER_PID_FILE);
  const running_pids = isPidAlive(pid) ? [pid!] : [];
  return {
    enabled: true,
    managed: true,
    desired_version,
    running_versions: uniqueNonEmpty(
      running_pids.map((value) =>
        normalizeProjectHostRuntimeVersion(inferBundleVersionFromPid(value)),
      ),
    ),
    running_pids,
  };
}

function persistSnapshot(): ManagedComponentSnapshot {
  const desired_version = currentProjectHostVersion();
  if (!isProjectHostExternalConatPersistEnabled()) {
    return {
      enabled: true,
      managed: false,
      desired_version,
      running_versions: uniqueNonEmpty([desired_version]),
      running_pids: [process.pid],
    };
  }
  const pid = readPidFile(PERSIST_PID_FILE);
  const running_pids = isPidAlive(pid) ? [pid!] : [];
  return {
    enabled: true,
    managed: true,
    desired_version,
    running_versions: uniqueNonEmpty(
      running_pids.map((value) =>
        normalizeProjectHostRuntimeVersion(inferBundleVersionFromPid(value)),
      ),
    ),
    running_pids,
  };
}

function acpWorkerSnapshot(): ManagedComponentSnapshot {
  const launch = resolveProjectHostAcpWorkerLaunch();
  const desired_version = currentProjectHostVersion();
  const workers = listProjectHostAcpWorkers();
  return {
    enabled: true,
    managed: true,
    desired_version,
    running_versions: uniqueNonEmpty(
      workers.map((worker) =>
        workerBundleVersionOf(worker, {
          command: launch.command,
          args: launch.args,
          nodeLike: path
            .basename(launch.command)
            .toLowerCase()
            .startsWith("node"),
          resolvedCommand: path.resolve(launch.command),
          resolvedEntryPoint:
            launch.args[0] != null ? path.resolve(launch.args[0]) : undefined,
        }),
      ),
    ),
    running_pids: workers.map((worker) => worker.pid),
  };
}

function projectHostSnapshot(): ManagedComponentSnapshot {
  const desired_version = currentProjectHostVersion();
  return {
    enabled: true,
    managed: true,
    desired_version,
    running_versions: uniqueNonEmpty([desired_version]),
    running_pids: [process.pid],
  };
}

export function getManagedComponentStatus(): HostManagedComponentStatus[] {
  const snapshots: Record<ManagedComponentKind, ManagedComponentSnapshot> = {
    "project-host": projectHostSnapshot(),
    "conat-router": routerSnapshot(),
    "conat-persist": persistSnapshot(),
    "acp-worker": acpWorkerSnapshot(),
  };
  return SPECS.map((spec) =>
    summarizeManagedComponentStatus({
      ...spec,
      ...snapshots[spec.component],
    }),
  );
}

export const __test__ = {
  summarizeManagedComponentStatus,
  normalizeProjectHostRuntimeVersion,
};
