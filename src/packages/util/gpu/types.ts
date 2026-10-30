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

import type {
  GPU_ALERT_KINDS,
  GPU_ALERT_SEVERITIES,
} from "@cocalc/util/db-schema/gpu-budgets";
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

// A pod's provider billing (5d-2a): its settled spend is CoCalc's estimate
// until RunPod's billing records prove the whole lifetime (billed), or fail
// to within 48 hours (missing: the estimate stays). n/a: never created at
// RunPod, nothing to bill.
export const GPU_POD_BILLING_STATES = [
  "estimated",
  "billed",
  "missing",
  "n/a",
] as const;
export type GpuPodBillingState = (typeof GPU_POD_BILLING_STATES)[number];

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
  // the inventory reconciler (5d): it reads RunPod and records, never terminates
  "reconciler",
  "kill_switch",
  "cleanup",
  // the pod itself, reporting its SSH host key
  "pod",
  // provider billing reconciliation (5d-2a)
  "billing",
  // the project itself (its terminal or code, under a project funding
  // approval): which collaborator acted is unknown
  "project",
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
  // the pod reported its SSH host key (or a report was refused with an alert)
  "host_key",
  // the owner's kill switch stopped it
  "kill_switch",
  // a forced key removal left it outside CoCalc's management (5c)
  "unmanaged",
  // the owner released a quarantined pod's held reservations (5d)
  "quarantine_released",
  // RunPod's billing replaced the estimate as the pod's spend (5d-2a):
  // {billed_usd, estimate_usd}
  "billed",
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

// What reporting a key compromised has done so far (5c).
// The provider-account checks (5d-2b). on: checked every reconcile pass;
// off: not confirmed with the connected key; shared: confirmed, but a second
// key on the owner's home bay uses the same RunPod account; no_access:
// confirmed, but RunPod refuses this key the account's balance (a key with
// pod access only); no_key: no RunPod key is connected.
export interface GpuAccountChecks {
  state: "on" | "off" | "shared" | "no_access" | "no_key";
  confirmed_at: string | null;
  last_checked_at: string | null;
}

export interface GpuCompromiseStatus {
  // the cleanup finished: RunPod rejects the key, nothing is left, and
  // CoCalc's copy is revoked and its fence closed
  closed: boolean;
  // the account is clean but RunPod still accepts the key: delete it on
  // RunPod's Credentials page; CoCalc keeps watching until then
  awaiting_provider_revocation?: boolean;
  // pods still in the RunPod account at the last complete listing
  provider_pods?: number;
  // CoCalc's pods of this key not yet confirmed terminated
  managed_pods?: number;
  // the last pass couldn't list the account (it retries)
  listing_failed?: boolean;
  // RunPod rejects the key, but CoCalc still has unfinished pods on it: it
  // can't terminate them anymore (see warning)
  provider_rejected?: boolean;
  // what the owner must do now
  warning?: string;
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
  // the project funding approval that pays for it, if one does
  approval_id?: string;
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
  // a forced key removal left it outside CoCalc's management: it may still
  // run and bill at RunPod (its state is the last CoCalc knew)
  unmanaged_at?: string;
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
  // the agent's run that did it ("chat-session" for a chat session)
  run_id?: string;
  action: GpuPodAction;
  details?: Record<string, unknown>;
}

// What a project needs to reach a pod over SSH (gpu.sshInfo).
export interface GpuPodSshInfo {
  handle: string;
  // true once the pod is running and has registered its host key
  ready: boolean;
  state: string;
  host?: string;
  port?: number;
  user?: string;
  // "ssh-ed25519 <base64>", the key the pod registered
  host_public_key?: string;
  host_key_fingerprint?: string;
  ssh_key_fingerprint?: string;
}

// The answer to a pod's host-key report: a status and a fixed word, never
// request data.
export interface GpuHostKeyResult {
  status: 200 | 400 | 401 | 403 | 409 | 410;
  result:
    | "registered"
    | "invalid"
    | "unauthorized"
    | "pod_mismatch"
    | "key_mismatch"
    | "not_bound"
    | "gone";
}

export interface GpuAttribution {
  pod: GpuPodSummary;
  events: GpuPodEvent[];
}

// A key's budget (its key layer), as gpu.budget shows it. Money is decimal
// strings in USD. Available = authorized - spent - reserved - released
// (released: capacity deliberately retired); spent can pass authorized when
// RunPod bills more than estimated (over_budget_usd), which pauses launches.
export interface GpuBudget {
  layer_id: string;
  version: number;
  state: string;
  authorized_usd: string;
  spent_usd: string;
  reserved_usd: string;
  released_usd: string;
  available_usd: string;
  over_budget_usd?: string;
  // null: no limit of that kind
  max_hourly_usd: string | null;
  max_concurrent_pods: number | null;
  max_gpu_count: number | null;
  max_runtime_minutes: number | null;
  starts_at: string;
  ends_at: string;
  live_pods: number;
  live_gpus: number;
  // New launches with the key are paused: by the owner's kill switch,
  // and/or by CoCalc for an alert (paused_reason, e.g. "unknown_pod"; see
  // gpu.alerts). gpu.resume lifts both.
  paused: boolean;
  kill_switch: boolean;
  paused_reason: string | null;
  // "checking" until CoCalc has a recent complete check of the pods on the
  // RunPod account (launches wait for it)
  inventory: "complete" | "checking";
}

// What gpu.setBudget may change. Lowering needs only the owner; raising
// (or removing a limit, or a later end) needs fresh authentication.
export interface GpuBudgetChange {
  authorized_usd?: string | number;
  max_hourly_usd?: string | number | null;
  max_concurrent_pods?: number | null;
  max_gpu_count?: number | null;
  max_runtime_minutes?: number | null;
  ends_at?: string;
}

// What CoCalc found on a key's RunPod account that needs its owner (5d).
// Each kind ends its own way: never because a listing didn't show something.
export type GpuAlertKind = (typeof GPU_ALERT_KINDS)[number];
export type GpuAlertSeverity = (typeof GPU_ALERT_SEVERITIES)[number];

export interface GpuAlert {
  id: string;
  credential_id: string;
  kind: GpuAlertKind;
  severity: GpuAlertSeverity;
  // what it means and what to do
  message: string;
  // e.g. the RunPod pod id, a handle, the held amount
  details: Record<string, unknown> | null;
  opened: string;
  last_seen: string;
  resolved_at: string | null;
  resolved_by: string | null;
  acknowledged_at: string | null;
  // the owner ends it by acknowledging (gpu.acknowledgeAlert)
  acknowledgeable: boolean;
}

// gpu.spend: what the pods on the owner's keys cost, from the key layer's
// reservations (each pod counted once).
export const GPU_SPEND_GROUP_BY = [
  "beneficiary",
  "agent",
  "project",
  "pod",
] as const;
export type GpuSpendGroupBy = (typeof GPU_SPEND_GROUP_BY)[number];

export interface GpuSpendRow {
  // the beneficiary's account id, the agent id, the project id or the pod id;
  // "" for pods without an agent or a project
  key: string;
  // the pod's handle, when grouped by pod
  label?: string;
  // settled in the period: what the budget's spent_usd totals
  spent_usd: string;
  // live pods: CoCalc's estimate so far (computed as settlement will), not
  // yet spent
  live_estimate_usd: string;
  // quarantined reservations: held, neither spent nor live (see gpu.alerts)
  held_usd: string;
  // pods with spend, a live estimate or a hold in this row
  pods: number;
  pods_live: number;
}

export interface GpuSpendResult {
  as_of: string;
  since: string;
  until: string;
  group_by: GpuSpendGroupBy;
  // largest first (spent + live estimate + held)
  rows: GpuSpendRow[];
  totals: {
    spent_usd: string;
    live_estimate_usd: string;
    held_usd: string;
  };
  // more groups than fit: rows has the largest, totals cover all
  truncated?: boolean;
  // set once RunPod billing is reconciled into spent_usd (5d-2); absent
  // until then
  billed_through?: string;
}
