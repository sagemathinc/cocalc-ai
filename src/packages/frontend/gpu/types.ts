/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
The read side of the GPU hub API that the cost dashboard uses, as specified in
the GPU bring-your-own-key contract (INTERFACES.md). These are replaced by the
shared types in @cocalc/util/gpu and the `gpu` hub API group once those land;
do not extend them independently.

All USD values are decimal strings, all times ISO strings.
*/

export type GpuPodState =
  | "intent"
  | "creating"
  | "ambiguous"
  | "running"
  | "stopped"
  | "terminating"
  | "terminated"
  | "failed";

export type GpuCloud = "SECURE" | "COMMUNITY";

// "mine": pods I'm responsible for; "funded": every pod my key pays for.
export type GpuPodScope =
  "mine" | "funded" | { grant_id: string } | { course_id: string };

export type GpuKillSwitchScope =
  GpuPodScope | { beneficiary_account_id: string };

export interface GpuPodSummary {
  id: string;
  handle: string;
  provider: "runpod";
  provider_pod_id?: string | null;
  key_owner_account_id: string;
  beneficiary_account_id: string;
  beneficiary_name?: string;
  project_id?: string | null;
  grant_id?: string | null;
  agent_id?: string | null;
  turn_id?: string | null;
  gpu_type_id: string;
  gpu_count: number;
  cloud: GpuCloud;
  data_center_id?: string | null;
  cost_per_hr: string;
  estimated_cost: string;
  state: GpuPodState;
  desired_state: "running" | "stopped" | "terminated";
  created: string;
  terminated_at?: string | null;
}

export type GpuSpendGroupBy = "beneficiary" | "agent" | "project" | "pod";

export interface GpuSpendRow {
  key: string;
  label: string;
  estimated: string;
  // RunPod's per-pod billing arrives about an hour late; absent until then.
  billed?: string | null;
  pods_live: number;
}

export interface GpuSpendResult {
  as_of: string;
  // The end of the last hour RunPod has billed, if any.
  billed_through?: string | null;
  rows: GpuSpendRow[];
}

export interface GpuCostDashboardApi {
  pods(opts: { scope: GpuPodScope }): Promise<GpuPodSummary[]>;
  spend(opts: {
    scope: GpuPodScope;
    since?: string;
    until?: string;
    group_by: GpuSpendGroupBy;
  }): Promise<GpuSpendResult>;
  terminate(opts: { pod_id: string }): Promise<{ state: GpuPodState }>;
  killSwitch(opts: {
    scope: GpuKillSwitchScope;
  }): Promise<{ terminating: number }>;
}
