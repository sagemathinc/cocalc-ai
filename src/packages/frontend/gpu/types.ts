/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
What the GPU cost dashboard reads and does, on top of the shared GPU types in
@cocalc/util/gpu/types. A dashboard API is bound to one scope: what it shows is
exactly what its kill switch terminates. All USD values are decimal strings.
*/

import type {
  GpuAlert,
  GpuBudget,
  GpuPodState,
  GpuPodSummary,
  GpuSpendGroupBy,
  GpuSpendResult,
  GpuSpendRow,
} from "@cocalc/util/gpu/types";

export type {
  GpuAlert,
  GpuBudget,
  GpuPodState,
  GpuPodSummary,
  GpuSpendGroupBy,
  GpuSpendResult,
  GpuSpendRow,
};

// "funded": every pod the viewer's key pays for. (A course scope comes with
// the instructor's course view.)
export type GpuDashboardScope = "funded" | { course_id: string };

// A pod as the dashboard shows it: CoCalc's record, plus the beneficiary's
// name when known.
export interface DashboardPod extends GpuPodSummary {
  beneficiary_name?: string;
}

export interface GpuKillResult {
  // pods newly marked for termination
  marked: number;
  // pods still terminating when the call returned (the reaper finishes them)
  remaining: number;
  // whether new launches are paused now
  paused: boolean;
}

export interface GpuCostDashboardApi {
  scope: GpuDashboardScope;
  // the pods of this scope, including ones that ended recently
  pods(): Promise<DashboardPod[]>;
  // settled spend, live estimates and holds, from the server (gpu.spend)
  spend(opts: {
    since: string;
    group_by: GpuSpendGroupBy;
  }): Promise<GpuSpendResult>;
  // the key's budget, for scopes that have one
  budget?(): Promise<GpuBudget>;
  terminate(opts: { pod_id: string }): Promise<{ state: GpuPodState }>;
  killSwitch(): Promise<GpuKillResult>;
  // lift the kill switch's pause (needs fresh authentication); absent for
  // scopes that never pause
  resume?(): Promise<{ resumed: number }>;
  // what CoCalc found that needs the key owner (open alerts)
  alerts?(): Promise<GpuAlert[]>;
  // end an alert only the owner can end
  acknowledgeAlert?(opts: { id: string }): Promise<GpuAlert>;
  // release budget held for a pod CoCalc couldn't confirm (fresh auth)
  releaseQuarantined?(opts: {
    pod_id: string;
  }): Promise<{ pod_id: string; released_usd: string; warning: string }>;
  // display names of accounts, for spend rows grouped by person
  names?(account_ids: string[]): Promise<Record<string, string | undefined>>;
  projectTitle?(project_id: string): string | undefined;
}
