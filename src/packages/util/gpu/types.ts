/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU bring-your-own-key: the pods CoCalc starts with an account's own provider
key, and who did what with them. The records live on the key owner's home bay
(tables gpu_pods and gpu_pod_events).

Words:
- key owner: the account whose provider key is used and billed;
- beneficiary: the account responsible for a pod (set at launch, never
  changed);
- handle: the opaque pod name sent to the provider, cc- and 16 base32
  characters (80 random bits), such as cc-7f3k9q2xa4mbn6wd; it never
  contains ids.
*/

import type { RunpodCloud } from "./runpod";

export const GPU_POD_STATES = [
  // recorded before anything is sent to the provider
  "intent",
  // the create request is in flight
  "creating",
  // the create request failed in a way that may still have made a pod; the
  // pod is found by its handle (or shown not to exist) before anything else
  "ambiguous",
  "running",
  "stopped",
  "terminating",
  "terminated",
  // the provider refused the create, so no pod exists
  "failed",
] as const;
export type GpuPodState = (typeof GPU_POD_STATES)[number];

// States that may still bill: everything until terminated or failed.
export const GPU_POD_LIVE_STATES: readonly GpuPodState[] = [
  "intent",
  "creating",
  "ambiguous",
  "running",
  "stopped",
  "terminating",
];

export const GPU_POD_DESIRED_STATES = [
  "running",
  "stopped",
  "terminated",
] as const;
export type GpuPodDesiredState = (typeof GPU_POD_DESIRED_STATES)[number];

export const GPU_ACTOR_KINDS = [
  "user",
  "agent",
  "key_owner",
  "reaper",
  "kill_switch",
  "cleanup",
] as const;
export type GpuActorKind = (typeof GPU_ACTOR_KINDS)[number];

export const GPU_POD_ACTIONS = [
  "create",
  "bind",
  "start",
  "stop",
  "terminate",
  "state",
  "budget_stop",
  "who_lookup",
  // a new public IP seen for the pod: {public_ip, ports}, so attribution by
  // IP can match the time
  "ip_seen",
] as const;
export type GpuPodAction = (typeof GPU_POD_ACTIONS)[number];

// What a caller may ask for. Everything else (the pod name, the SSH
// variables, the deadline) is set by the server.
export interface GpuLaunchSpec {
  gpu_type_id: string;
  gpu_count: number;
  // default SECURE: Community pods don't always get a public SSH port
  cloud?: RunpodCloud;
  data_center_id?: string;
  // one of GPU_LAUNCH_IMAGES
  image: string;
  container_disk_gb?: number;
  volume_gb?: number;
  // e.g. "22/tcp", "8888/http"
  ports?: string[];
  // non-secret settings for the container; never a credential
  env?: Record<string, string>;
  max_runtime_minutes: number;
  // the pod's own SSH public key; the private key stays in the project
  ssh_public_key?: string;
}

export interface GpuPodSummary {
  id: string;
  handle: string;
  provider: "runpod";
  provider_pod_id?: string;
  state: GpuPodState;
  desired_state: GpuPodDesiredState;
  key_owner_account_id: string;
  beneficiary_account_id: string;
  project_id?: string;
  agent_id?: string;
  gpu_type_id: string;
  gpu_count: number;
  cloud: RunpodCloud;
  data_center_id?: string;
  image: string;
  // USD per hour, as a decimal string
  cost_per_hr?: string;
  max_runtime_minutes: number;
  // when the pod must be gone (created + max runtime)
  deadline: string;
  created: string;
  updated: string;
  terminated_at?: string;
  // why it failed or was terminated, in words for the user
  reason?: string;
  // SHA256 fingerprint of ssh_public_key, as `ssh-keygen -lf` prints it
  ssh_key_fingerprint?: string;
}

export interface GpuPodEvent {
  id: string;
  pod_id: string;
  at: string;
  actor_kind: GpuActorKind;
  actor_account_id?: string;
  agent_id?: string;
  action: GpuPodAction;
  details?: Record<string, unknown>;
}

export interface GpuAttribution {
  pod: GpuPodSummary;
  events: GpuPodEvent[];
}
