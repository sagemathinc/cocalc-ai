/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Allowlisted views of RunPod REST v2 objects. Pods can carry secrets: env
// (ours, e.g. a one-time bootstrap token, or anything the account owner
// set), the start command, registry credentials, template and volume ids.
// Only the fields below ever leave this package; fields RunPod adds later
// are dropped until we allowlist them. The view types are shared with the
// hub API and frontend: see @cocalc/util/gpu/runpod.

import type {
  RunpodPodMounts,
  RunpodPodRuntime,
  RunpodPodView,
  RunpodPortMapping,
  RunpodSshEndpoint,
} from "@cocalc/util/gpu/runpod";

export type {
  RunpodPodAction,
  RunpodPodMounts,
  RunpodPodRuntime,
  RunpodPodStatus,
  RunpodPodView,
  RunpodPortMapping,
  RunpodSshEndpoint,
} from "@cocalc/util/gpu/runpod";

const POD_STATUSES = new Set<string>([
  "PROVISIONING",
  "STARTING",
  "RUNNING",
  "EXITED",
  "ERROR",
  "TERMINATED",
]);

const POD_ACTIONS = new Set<string>(["start", "stop", "restart", "terminate"]);

export function podView(raw: any): RunpodPodView | undefined {
  if (raw == null || typeof raw !== "object" || !isString(raw.id)) {
    return undefined;
  }
  // GPU pods report vCPUs and RAM under `gpu`, CPU pods under `cpu`.
  const machine = raw.gpu ?? raw.cpu;
  const view: RunpodPodView = {
    id: raw.id,
    name: str(raw.name),
    status: POD_STATUSES.has(raw.status) ? raw.status : undefined,
    actions: Array.isArray(raw.actions)
      ? raw.actions.filter((a: unknown) => POD_ACTIONS.has(a as string))
      : undefined,
    cost: finite(raw.cost),
    gpuTypeId: str(raw.gpu?.id),
    gpuCount: positiveInt(raw.gpu?.count),
    cpuFlavorId: raw.gpu ? undefined : str(raw.cpu?.id),
    vcpuCount: positive(machine?.vcpuCount),
    memoryGb: positive(machine?.memory),
    containerDiskGb: positiveInt(raw.disk),
    mounts: mounts(raw.mounts),
    cloud:
      raw.cloud === "SECURE" || raw.cloud === "COMMUNITY"
        ? raw.cloud
        : undefined,
    dataCenterId: str(raw.dataCenterId),
    cudaVersion: str(raw.cudaVersion),
    image: imageName(raw.image),
    ports: Array.isArray(raw.ports)
      ? raw.ports.filter(
          (p: unknown) => typeof p === "string" && /^\d{1,5}\/[a-z]+$/.test(p),
        )
      : undefined,
    locked: typeof raw.locked === "boolean" ? raw.locked : undefined,
    sshDirect: sshEndpoint(raw.ssh?.direct),
    sshProxy: sshEndpoint(raw.ssh?.proxy),
    globalNetworking:
      typeof raw.globalNetworking?.enabled === "boolean"
        ? compact({
            enabled: raw.globalNetworking.enabled,
            ip: str(raw.globalNetworking.ip),
            internalDns: str(raw.globalNetworking.internalDns),
          })
        : undefined,
    runtime: runtime(raw.runtime),
    createdAt: str(raw.createdAt),
    startedAt: str(raw.startedAt),
  };
  return compact(view);
}

function mounts(raw: any): RunpodPodMounts | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const volumes = (list: unknown) =>
    Array.isArray(list)
      ? list
          .filter((m) => isString(m?.volumeId))
          .map((m) => compact({ volumeId: m.volumeId, path: str(m.path) }))
      : undefined;
  const p = raw.persistent;
  const view: RunpodPodMounts = {
    persistent:
      positiveInt(p?.size) != null && isString(p?.path)
        ? { sizeGb: p.size, path: p.path }
        : undefined,
    network: volumes(raw.network),
    global: volumes(raw.global),
  };
  compact(view);
  return Object.keys(view).length > 0 ? view : undefined;
}

function runtime(raw: any): RunpodPodRuntime | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const view: RunpodPodRuntime = {
    uptimeSeconds: nonNegativeInt(raw.uptime),
    gpus: Array.isArray(raw.gpus)
      ? raw.gpus.map((g: any) =>
          compact({
            util: percent(g?.util),
            memoryUtil: percent(g?.memoryUtil),
          }),
        )
      : undefined,
    cpuUtil: percent(raw.cpu?.util),
    memoryUtil: percent(raw.memory?.util),
    ports: Array.isArray(raw.ports)
      ? raw.ports
          .map(portMapping)
          .filter((p: RunpodPortMapping | undefined) => p != null)
      : undefined,
  };
  return compact(view);
}

function portMapping(raw: any): RunpodPortMapping | undefined {
  const port = (v: unknown) => {
    const n = positiveInt(v);
    return n != null && n <= 65535 ? n : undefined;
  };
  const priv = port(raw?.private);
  if (priv == null) return undefined;
  return compact({
    private: priv,
    public: port(raw.public),
    type: str(raw.type),
    ip: str(raw.ip),
  });
}

export interface RunpodBillingRecord {
  podId: string;
  startTime: string;
  endTime: string;
  totalAmount: number;
  gpuAmount?: number;
  cpuAmount?: number;
  diskAmount?: number;
}

// Strict: a record missing its pod, time range or total, or with a negative
// or non-numeric amount, is rejected (undefined) rather than read as zero.
export function billingRecordView(raw: any): RunpodBillingRecord | undefined {
  if (raw == null || typeof raw !== "object" || !isString(raw.podId)) {
    return undefined;
  }
  if (!isTime(raw.startTime) || !isTime(raw.endTime)) return undefined;
  if (Date.parse(raw.endTime) < Date.parse(raw.startTime)) return undefined;
  const total = amount(raw.totalAmount);
  if (total == null) return undefined;
  const record: RunpodBillingRecord = {
    podId: raw.podId,
    startTime: raw.startTime,
    endTime: raw.endTime,
    totalAmount: total,
  };
  for (const k of ["gpuAmount", "cpuAmount", "diskAmount"] as const) {
    if (raw[k] === undefined) continue;
    const a = amount(raw[k]);
    if (a == null) return undefined;
    record[k] = a;
  }
  return record;
}

function isTime(v: unknown): v is string {
  return isString(v) && Number.isFinite(Date.parse(v));
}

function amount(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function sshEndpoint(raw: any): RunpodSshEndpoint | undefined {
  // `command` is dropped: it's a ready-made shell line we never need.
  if (
    raw == null ||
    !isString(raw.host) ||
    !isString(raw.username) ||
    positiveInt(raw.port) == null ||
    raw.port > 65535
  ) {
    return undefined;
  }
  return { host: raw.host, port: raw.port, username: raw.username };
}

// An image reference can't legitimately hold credentials, but a pasted
// "user:pass@registry/..." or URL would; drop those. A digest
// ("name@sha256:...") comes after the registry part and is kept.
function imageName(v: unknown): string | undefined {
  if (!isString(v) || v.length > 512 || /\s|:\/\//.test(v)) return undefined;
  const slash = v.indexOf("/");
  const at = v.indexOf("@");
  return slash > 0 && at >= 0 && at < slash ? undefined : v;
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function str(v: unknown): string | undefined {
  return isString(v) ? v : undefined;
}

function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

function nonNegativeInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

function positive(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function percent(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100
    ? v
    : undefined;
}

function compact<T extends object>(obj: T): T {
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj;
}
