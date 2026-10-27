/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Allowlisted views of RunPod REST v2 objects. Pods can carry secrets: env
// (ours, e.g. a one-time bootstrap token, or anything the account owner
// set), the start command, registry credentials, template and volume ids.
// Only the fields below ever leave this package; fields RunPod adds later
// are dropped until we allowlist them.

export type RunpodPodStatus =
  | "PROVISIONING"
  | "STARTING"
  | "RUNNING"
  | "EXITED"
  | "ERROR"
  | "TERMINATED";

const POD_STATUSES = new Set<string>([
  "PROVISIONING",
  "STARTING",
  "RUNNING",
  "EXITED",
  "ERROR",
  "TERMINATED",
]);

export interface RunpodSshEndpoint {
  host: string;
  port: number;
  username: string;
}

export interface RunpodPodView {
  id: string;
  name?: string;
  status?: RunpodPodStatus;
  // USD per hour actually billed for this pod
  cost?: number;
  gpuTypeId?: string;
  gpuCount?: number;
  cloud?: "SECURE" | "COMMUNITY";
  dataCenterId?: string;
  image?: string;
  // direct (public IP) and proxied SSH endpoints, when RunPod reports them
  sshDirect?: RunpodSshEndpoint;
  sshProxy?: RunpodSshEndpoint;
  createdAt?: string;
  startedAt?: string;
}

export function podView(raw: any): RunpodPodView | undefined {
  if (raw == null || typeof raw !== "object" || !isString(raw.id)) {
    return undefined;
  }
  const view: RunpodPodView = {
    id: raw.id,
    name: str(raw.name),
    status: POD_STATUSES.has(raw.status) ? raw.status : undefined,
    cost: finite(raw.cost),
    gpuTypeId: str(raw.gpu?.id),
    gpuCount: positiveInt(raw.gpu?.count),
    cloud:
      raw.cloud === "SECURE" || raw.cloud === "COMMUNITY"
        ? raw.cloud
        : undefined,
    dataCenterId: str(raw.dataCenterId),
    image: imageName(raw.image),
    sshDirect: sshEndpoint(raw.ssh?.direct),
    sshProxy: sshEndpoint(raw.ssh?.proxy),
    createdAt: str(raw.createdAt),
    startedAt: str(raw.startedAt),
  };
  return compact(view);
}

export interface RunpodBillingRecord {
  podId: string;
  startTime?: string;
  endTime?: string;
  totalAmount?: number;
  gpuAmount?: number;
  cpuAmount?: number;
  diskAmount?: number;
}

export function billingRecordView(raw: any): RunpodBillingRecord | undefined {
  if (raw == null || typeof raw !== "object" || !isString(raw.podId)) {
    return undefined;
  }
  return compact({
    podId: raw.podId,
    startTime: str(raw.startTime),
    endTime: str(raw.endTime),
    totalAmount: finite(raw.totalAmount),
    gpuAmount: finite(raw.gpuAmount),
    cpuAmount: finite(raw.cpuAmount),
    diskAmount: finite(raw.diskAmount),
  });
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

function compact<T extends object>(obj: T): T {
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj;
}
