/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { readFile } from "node:fs/promises";
import getLogger from "@cocalc/backend/logger";
import { podman } from "@cocalc/backend/podman";
import {
  getConmonContainerProcesses,
  type ConmonContainerProcess,
} from "@cocalc/backend/podman/conmon";
import type { ManagedProjectEgressOverride } from "@cocalc/conat/files/file-server";
import { hubApi } from "@cocalc/lite/hub/api";
import type { API as ProjectRunnerApi } from "@cocalc/conat/project/runner/run";
import type { ManagedProjectEgressCategory } from "@cocalc/conat/hub/api/system";
import { capitalize, humanSize } from "@cocalc/util/misc";
import {
  getProjectHostManagedEgressMode,
  isProjectHostManagedEgressEnforced,
} from "./managed-egress-runtime";
import {
  managedProjectEgressResidualTracker,
  type ManagedProjectEgressResidualTracker,
} from "./managed-egress-residual";

const logger = getLogger("project-host:raw-network-egress");

const DEFAULT_INTERVAL_MS = 5_000;
const CATEGORY: ManagedProjectEgressCategory = "raw-network";

type PodmanLike = (
  args: string[],
) => Promise<{ stdout?: string; stderr?: string; exit_code?: number }>;

type ReadFileLike = (path: string, encoding: BufferEncoding) => Promise<string>;

type InterfaceStats = {
  rx_bytes: number;
  tx_bytes: number;
};

type ProjectNetworkSample = {
  project_id: string;
  pid: number;
  interface_name: string;
  tx_bytes: number;
};

type ProjectNetworkDelta = ProjectNetworkSample & {
  bytes: number;
};

type ManagedEgressPolicy = {
  allowed: boolean;
  blocked_by?: string;
  managed_egress_5h_bytes?: number;
  managed_egress_7d_bytes?: number;
  egress_5h_bytes?: number;
  egress_7d_bytes?: number;
  managed_egress_categories_5h_bytes?: Record<string, number>;
};

function envPositiveInt(name: string, fallback: number): number {
  const raw = `${process.env[name] ?? ""}`.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function diffCounter(
  current: number | undefined,
  previous: number | undefined,
): number {
  const currentValue = Number.isFinite(current) ? Math.max(0, current ?? 0) : 0;
  const previousValue = Number.isFinite(previous)
    ? Math.max(0, previous ?? 0)
    : 0;
  return currentValue >= previousValue
    ? currentValue - previousValue
    : currentValue;
}

function formatByteCount(bytes: number): string {
  return humanSize(Math.max(0, bytes));
}

function formatManagedEgressCategory(category: string): string {
  if (category === "file-download") return "File downloads";
  if (category === "http-proxy") return "App server HTTP traffic";
  if (category === "ws-proxy") return "App server WebSocket traffic";
  if (category === "ssh") return "SSH traffic";
  if (category === "interactive-conat") return "Interactive session traffic";
  if (category === "backup-upload") return "Project backup uploads";
  if (category === CATEGORY) return "Project outbound network traffic";
  return capitalize(category.replace(/[-_]/g, " "));
}

function normalizeProjectContainerName(name: unknown): string | undefined {
  const value = `${name ?? ""}`.trim().replace(/^\/+/, "");
  if (!value) return;
  return value;
}

function projectIdFromContainerName(
  name: string | undefined,
): string | undefined {
  const match = name?.match(/^project-([0-9a-fA-F-]{36})$/);
  return match?.[1];
}

function parseProcNetRouteDefaultInterface(
  content: string,
): string | undefined {
  const lines = content.trim().split(/\r?\n/);
  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const iface = `${cols[0] ?? ""}`.trim();
    const destination = `${cols[1] ?? ""}`.trim();
    const flagsHex = `${cols[3] ?? ""}`.trim();
    if (!iface || iface === "lo" || destination !== "00000000") continue;
    const flags = Number.parseInt(flagsHex, 16);
    if (Number.isNaN(flags) || (flags & 0x2) === 0) continue;
    return iface;
  }
}

function parseProcNetDev(content: string): Record<string, InterfaceStats> {
  const out: Record<string, InterfaceStats> = {};
  for (const rawLine of content.split(/\r?\n/).slice(2)) {
    const line = rawLine.trim();
    if (!line) continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const iface = line.slice(0, sep).trim();
    const fields = line
      .slice(sep + 1)
      .trim()
      .split(/\s+/);
    if (!iface || fields.length < 16) continue;
    const rx_bytes = Number(fields[0]);
    const tx_bytes = Number(fields[8]);
    if (!Number.isFinite(rx_bytes) || !Number.isFinite(tx_bytes)) continue;
    out[iface] = {
      rx_bytes: Math.max(0, rx_bytes),
      tx_bytes: Math.max(0, tx_bytes),
    };
  }
  return out;
}

function chooseBoundaryInterface({
  routeContent,
  statsByInterface,
}: {
  routeContent: string;
  statsByInterface: Record<string, InterfaceStats>;
}): string | undefined {
  const defaultIface = parseProcNetRouteDefaultInterface(routeContent);
  if (defaultIface && statsByInterface[defaultIface]) {
    return defaultIface;
  }
  const nonLoopback = Object.keys(statsByInterface).filter(
    (iface) => iface !== "lo",
  );
  if (nonLoopback.length === 1) {
    return nonLoopback[0];
  }
  return defaultIface ?? nonLoopback.sort()[0];
}

async function listRunningProjectContainers(
  podmanCommand: PodmanLike,
): Promise<Array<{ id: string; name: string; project_id: string }>> {
  const ps = await podmanCommand(["ps", "--format", "json"]);
  const parsed = `${ps.stdout ?? ""}`.trim()
    ? JSON.parse(`${ps.stdout ?? ""}`)
    : [];
  const out: Array<{ id: string; name: string; project_id: string }> = [];
  for (const row of Array.isArray(parsed) ? parsed : []) {
    const id = `${row?.Id ?? row?.ID ?? ""}`.trim();
    const names = Array.isArray(row?.Names)
      ? row.Names
      : [row?.Names ?? row?.Name ?? row?.Names0];
    const name = normalizeProjectContainerName(names.find(Boolean));
    const project_id = projectIdFromContainerName(name);
    if (!id || !name || !project_id) continue;
    out.push({ id, name, project_id });
  }
  return out;
}

async function inspectProjectContainerPids(
  containers: Array<{ id: string; name: string; project_id: string }>,
  podmanCommand: PodmanLike,
): Promise<ProjectNetworkSample[]> {
  if (containers.length === 0) return [];
  const inspect = await podmanCommand([
    "inspect",
    ...containers.map((container) => container.id),
    "--format",
    "json",
  ]);
  const parsed = `${inspect.stdout ?? ""}`.trim()
    ? JSON.parse(`${inspect.stdout ?? ""}`)
    : [];
  const byName = new Map(
    containers.map((container) => [container.name, container.project_id]),
  );
  const out: ProjectNetworkSample[] = [];
  for (const row of Array.isArray(parsed) ? parsed : []) {
    const name = normalizeProjectContainerName(row?.Name);
    const project_id = name ? byName.get(name) : undefined;
    const pid = Number(row?.State?.Pid);
    if (!project_id || !Number.isInteger(pid) || pid <= 0) continue;
    out.push({
      project_id,
      pid,
      interface_name: "",
      tx_bytes: 0,
    });
  }
  return out;
}

function pickConmonNamespacePid(
  info: ConmonContainerProcess,
): number | undefined {
  return [...new Set(info.child_pids)].find(
    (pid) => Number.isInteger(pid) && pid > 0,
  );
}

async function inspectConmonOnlyProjectPids({
  knownProjectIds,
  getConmonProcesses,
}: {
  knownProjectIds: Set<string>;
  getConmonProcesses: () => Promise<Map<string, ConmonContainerProcess>>;
}): Promise<ProjectNetworkSample[]> {
  const out: ProjectNetworkSample[] = [];
  const states = await getConmonProcesses();
  for (const info of states.values()) {
    if (!info.project_id || knownProjectIds.has(info.project_id)) continue;
    const pid = pickConmonNamespacePid(info);
    if (!pid) continue;
    out.push({
      project_id: info.project_id,
      pid,
      interface_name: "",
      tx_bytes: 0,
    });
  }
  return out;
}

export async function collectRunningProjectNetworkSamples({
  podmanCommand = podman,
  readFileFn = readFile,
  getConmonProcesses = getConmonContainerProcesses,
}: {
  podmanCommand?: PodmanLike;
  readFileFn?: ReadFileLike;
  getConmonProcesses?: () => Promise<Map<string, ConmonContainerProcess>>;
} = {}): Promise<ProjectNetworkSample[]> {
  const containers = await listRunningProjectContainers(podmanCommand);
  const inspected = await inspectProjectContainerPids(
    containers,
    podmanCommand,
  );
  const conmonOnly = await inspectConmonOnlyProjectPids({
    knownProjectIds: new Set(inspected.map((sample) => sample.project_id)),
    getConmonProcesses,
  });
  const samples = await Promise.all(
    [...inspected, ...conmonOnly].map(async (sample) => {
      try {
        const [routeContent, devContent] = await Promise.all([
          readFileFn(`/proc/${sample.pid}/net/route`, "utf8"),
          readFileFn(`/proc/${sample.pid}/net/dev`, "utf8"),
        ]);
        const statsByInterface = parseProcNetDev(devContent);
        const interface_name = chooseBoundaryInterface({
          routeContent,
          statsByInterface,
        });
        if (!interface_name) return;
        const tx_bytes = statsByInterface[interface_name]?.tx_bytes;
        if (!Number.isFinite(tx_bytes)) return;
        return {
          ...sample,
          interface_name,
          tx_bytes: Math.max(0, tx_bytes ?? 0),
        };
      } catch (err) {
        logger.debug("unable to sample project network counters", {
          project_id: sample.project_id,
          pid: sample.pid,
          err: `${err}`,
        });
      }
    }),
  );
  return samples
    .filter((sample): sample is ProjectNetworkSample => !!sample)
    .sort((a, b) => a.project_id.localeCompare(b.project_id));
}

export function summarizeManagedRawNetworkEgressDeltas({
  previous,
  current,
}: {
  previous: Map<string, ProjectNetworkSample>;
  current: Map<string, ProjectNetworkSample>;
}): ProjectNetworkDelta[] {
  const out: ProjectNetworkDelta[] = [];
  for (const [project_id, sample] of current) {
    const prev = previous.get(project_id);
    if (!prev) continue;
    if (prev.interface_name !== sample.interface_name) continue;
    if (sample.tx_bytes < prev.tx_bytes) continue;
    const bytes = diffCounter(sample.tx_bytes, prev.tx_bytes);
    if (!(bytes > 0)) continue;
    out.push({
      ...sample,
      bytes,
    });
  }
  return out.sort((a, b) => a.project_id.localeCompare(b.project_id));
}

function buildBlockedMessage(policy: ManagedEgressPolicy): string {
  const breakdown = Object.entries(
    policy.managed_egress_categories_5h_bytes ?? {},
  )
    .filter(
      ([, bytes]) =>
        typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0,
    )
    .map(
      ([category, bytes]) =>
        `${formatManagedEgressCategory(category)}: ${formatByteCount(bytes)}`,
    );
  const lines = [
    "Project outbound network traffic limit reached.",
    "Raw outbound network access for this project is temporarily blocked until the egress usage window resets.",
  ];
  if (policy.egress_5h_bytes != null) {
    lines.push(
      `5-hour usage: ${formatByteCount(policy.managed_egress_5h_bytes ?? 0)} / ${formatByteCount(policy.egress_5h_bytes)}.`,
    );
  }
  if (policy.egress_7d_bytes != null) {
    lines.push(
      `7-day usage: ${formatByteCount(policy.managed_egress_7d_bytes ?? 0)} / ${formatByteCount(policy.egress_7d_bytes)}.`,
    );
  }
  if (breakdown.length > 0) {
    lines.push(
      `Current managed egress categories (5 hours): ${breakdown.join(", ")}.`,
    );
  }
  return lines.join("\n");
}

export async function assertManagedRawNetworkStartAllowedBestEffort({
  project_id,
  managed_egress_override,
}: {
  project_id: string;
  managed_egress_override?: ManagedProjectEgressOverride;
}): Promise<void> {
  if (managed_egress_override === "admin-host-drain") return;
  if (!isProjectHostManagedEgressEnforced()) return;
  if (!hubApi.system?.getManagedProjectEgressPolicy) return;
  try {
    const policy = (await hubApi.system.getManagedProjectEgressPolicy({
      project_id,
      category: CATEGORY,
    })) as ManagedEgressPolicy;
    if (policy.allowed) return;
    throw new Error(buildBlockedMessage(policy));
  } catch (err: any) {
    if (err instanceof Error && err.message.startsWith("Project outbound")) {
      throw err;
    }
    logger.warn("unable to evaluate raw network start policy; allowing start", {
      project_id,
      err: `${err}`,
    });
  }
}

export function startManagedRawNetworkEgressLoop({
  runnerApi,
  intervalMs = envPositiveInt(
    "COCALC_PROJECT_HOST_RAW_NETWORK_EGRESS_INTERVAL_MS",
    DEFAULT_INTERVAL_MS,
  ),
  sample = collectRunningProjectNetworkSamples,
  residualTracker = managedProjectEgressResidualTracker,
}: {
  runnerApi: Pick<ProjectRunnerApi, "stop">;
  intervalMs?: number;
  sample?: typeof collectRunningProjectNetworkSamples;
  residualTracker?: ManagedProjectEgressResidualTracker;
}): () => void {
  let previous = new Map<string, ProjectNetworkSample>();
  let previousSampleAt: number | undefined;
  let running = false;
  const stopping = new Set<string>();

  residualTracker.configure({
    bucketMs: intervalMs,
    graceMs: Math.max(intervalMs * 3, intervalMs),
  });

  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      const mode = getProjectHostManagedEgressMode();
      const sampledAt = Date.now();
      const currentSamples = await sample();
      const current = new Map(
        currentSamples.map((entry) => [entry.project_id, entry] as const),
      );
      const deltas = summarizeManagedRawNetworkEgressDeltas({
        previous,
        current,
      });
      previous = current;
      const boundaryAt =
        previousSampleAt == null
          ? sampledAt
          : Math.floor((previousSampleAt + sampledAt) / 2);
      previousSampleAt = sampledAt;

      for (const delta of deltas) {
        residualTracker.noteBoundaryBytes({
          project_id: delta.project_id,
          bytes: delta.bytes,
          at: boundaryAt,
          metadata: {
            interface_name: delta.interface_name,
            pid: delta.pid,
          },
        });
      }
      const residuals = residualTracker.flush({ now: sampledAt });

      if (mode === "off") {
        return;
      }

      if (residuals.length > 0) {
        logger.info("managed raw network egress sample", {
          mode,
          projects: residuals.map((residual) => ({
            project_id: residual.project_id,
            bytes: residual.bytes,
            boundary_bytes: residual.boundary_bytes,
            classified_boundary_bytes: residual.classified_boundary_bytes,
            classified_categories: residual.classified_categories,
            pid: residual.metadata?.pid,
            interface_name: residual.metadata?.interface_name,
          })),
        });
      }

      for (const residual of residuals) {
        try {
          await hubApi.system.recordManagedProjectEgress({
            project_id: residual.project_id,
            category: CATEGORY,
            bytes: residual.bytes,
            metadata: {
              interface_name: residual.metadata?.interface_name,
              pid: residual.metadata?.pid,
              boundary_bytes: residual.boundary_bytes,
              classified_boundary_bytes: residual.classified_boundary_bytes,
              classified_categories: residual.classified_categories,
              bucket_start: residual.bucket_start,
              bucket_ms: residual.bucket_ms,
              mode: "residual-v1",
            },
          });
        } catch (err) {
          logger.warn("unable to record raw network egress", {
            project_id: residual.project_id,
            bytes: residual.bytes,
            err: `${err}`,
          });
          continue;
        }

        if (mode !== "enforce") continue;
        try {
          const policy = (await hubApi.system.getManagedProjectEgressPolicy({
            project_id: residual.project_id,
            category: CATEGORY,
          })) as ManagedEgressPolicy;
          if (policy.allowed || stopping.has(residual.project_id)) {
            continue;
          }
          stopping.add(residual.project_id);
          logger.info("stopping project due to raw network egress policy", {
            project_id: residual.project_id,
            blocked_by: policy.blocked_by,
            bytes: residual.bytes,
          });
          void runnerApi
            .stop({
              project_id: residual.project_id,
              force: true,
            })
            .catch((err) => {
              logger.warn("unable to stop over-limit raw network project", {
                project_id: residual.project_id,
                err: `${err}`,
              });
            })
            .finally(() => {
              stopping.delete(residual.project_id);
            });
        } catch (err) {
          logger.warn("unable to evaluate raw network egress policy", {
            project_id: residual.project_id,
            err: `${err}`,
          });
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export const MANAGED_RAW_NETWORK_EGRESS_CATEGORY = CATEGORY;

export const __test__ = {
  buildBlockedMessage,
  chooseBoundaryInterface,
  diffCounter,
  parseProcNetDev,
  parseProcNetRouteDefaultInterface,
  summarizeManagedRawNetworkEgressDeltas,
};
