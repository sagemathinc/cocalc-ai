/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
The RunPod objects CoCalc returns to users and agents: the GPU catalog and
allowlisted views of pods. @cocalc/cloud/runpod builds them from RunPod's
REST v2 responses; the hub API (`gpu.*`) and the frontend read them. Only
non-secret fields are here: never env, the start command, registry
credentials or template ids.
*/

// How long one GPU read may take end to end on the key owner's home bay:
// the catalog (three parallel RunPod requests, each up to 30 s) or a pod
// inventory of a few slow pages. Callers waiting on a read (the inter-bay
// forward, the CLI) budget at least this much.
export const GPU_READ_TIMEOUT_MS = 120_000;

export type RunpodCloud = "SECURE" | "COMMUNITY";

export type RunpodAvailability = "NONE" | "LOW" | "MEDIUM" | "HIGH";

export type RunpodStockLevel = Exclude<RunpodAvailability, "NONE">;

// ---- catalog ----

export interface RunpodCloudOffer {
  // USD per GPU-hour list price
  price?: number;
  // largest GPU count on one pod (a ceiling, not stock)
  maxCount?: number;
  availability?: RunpodAvailability;
  // data center id -> availability, only where it is in stock
  dataCenters: Record<string, RunpodStockLevel>;
}

export interface RunpodGpuType {
  id: string;
  name: string;
  manufacturer?: string;
  memoryGb?: number;
  // absent when RunPod doesn't offer the type in that cloud
  secure?: RunpodCloudOffer;
  community?: RunpodCloudOffer;
}

export interface RunpodDataCenter {
  id: string;
  name?: string;
  region?: string;
  compliance: string[];
  // private cross-data-center pod network
  globalNetwork?: boolean;
  networkVolumeTypes?: string[];
}

export interface RunpodCatalog {
  as_of: string;
  gpuTypes: RunpodGpuType[];
  dataCenters: RunpodDataCenter[];
}

// ---- pods ----

export type RunpodPodStatus =
  | "PROVISIONING"
  | "STARTING"
  | "RUNNING"
  | "EXITED"
  | "ERROR"
  | "TERMINATED";

export type RunpodPodAction = "start" | "stop" | "restart" | "terminate";

export interface RunpodSshEndpoint {
  host: string;
  port: number;
  username: string;
}

export interface RunpodPortMapping {
  private: number;
  public?: number;
  type?: string;
  ip?: string;
}

// Live metrics; RunPod reports them only for a RUNNING pod read by id.
export interface RunpodPodRuntime {
  uptimeSeconds?: number;
  // percent, 0-100
  gpus?: { util?: number; memoryUtil?: number }[];
  cpuUtil?: number;
  memoryUtil?: number;
  ports?: RunpodPortMapping[];
}

export interface RunpodPodMounts {
  persistent?: { sizeGb: number; path: string };
  network?: { volumeId: string; path?: string }[];
  global?: { volumeId: string; path?: string }[];
}

export interface RunpodPodView {
  id: string;
  name?: string;
  status?: RunpodPodStatus;
  // transitions RunPod allows from the current status
  actions?: RunpodPodAction[];
  // USD per hour actually billed for this pod
  cost?: number;
  gpuTypeId?: string;
  gpuCount?: number;
  // CPU flavor, for CPU pods
  cpuFlavorId?: string;
  vcpuCount?: number;
  memoryGb?: number;
  containerDiskGb?: number;
  mounts?: RunpodPodMounts;
  cloud?: RunpodCloud;
  dataCenterId?: string;
  cudaVersion?: string;
  image?: string;
  // exposed ports, e.g. "22/tcp", "8888/http"
  ports?: string[];
  locked?: boolean;
  // direct (public IP) and proxied SSH endpoints, when RunPod reports them
  sshDirect?: RunpodSshEndpoint;
  sshProxy?: RunpodSshEndpoint;
  globalNetworking?: { enabled: boolean; ip?: string; internalDns?: string };
  runtime?: RunpodPodRuntime;
  createdAt?: string;
  startedAt?: string;
}
