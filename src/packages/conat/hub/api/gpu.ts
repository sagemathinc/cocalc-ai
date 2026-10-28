/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU bring-your-own-key: GPUs on the account's own provider account (RunPod
first), using the key it connected in Settings. These reads are rich on
purpose, so agents get the provider's full catalog and stock; nothing here
ever returns the key or provider error text. Launch and terminate take only
the allowlisted spec (util/gpu/launch-spec); budgets come in step 5.
*/

import type { GpuProvider } from "@cocalc/util/gpu/provider-keys";
import type {
  GpuAttribution,
  GpuLaunchSpec,
  GpuPodSummary,
} from "@cocalc/util/gpu/types";
import type {
  RunpodCatalog,
  RunpodCloud,
  RunpodPodView,
  RunpodStockLevel,
} from "@cocalc/util/gpu/runpod";
import {
  authFirstRequireAccount,
  authFirstRequireAccountOrBoundAgentProject,
} from "./util";

// Agents may read the catalog and stock for the account they act for, from
// the project sealed into their token. Pods are account-only until they can
// be filtered to the pods that agent's project started (launch, step 3): the
// account's whole pod list spans projects and includes SSH endpoints.
// Launch, terminate and who are account-only until agents get a token
// scoped to their turn and budget (step 6).
export const gpu = {
  catalog: authFirstRequireAccountOrBoundAgentProject,
  availability: authFirstRequireAccountOrBoundAgentProject,
  pods: authFirstRequireAccount,
  launch: authFirstRequireAccount,
  terminate: authFirstRequireAccount,
  who: authFirstRequireAccount,
};

interface GpuReadOpts {
  account_id?: string;
  // set for agent callers; not used to scope reads yet
  project_id?: string;
  // default "runpod"
  provider?: GpuProvider;
}

export interface GpuCatalogResult {
  provider: GpuProvider;
  catalog: RunpodCatalog;
}

// One GPU type in one cloud tier at one data center where it is in stock.
export interface GpuOffer {
  gpu_type_id: string;
  gpu_name: string;
  memory_gb?: number;
  cloud: RunpodCloud;
  data_center_id: string;
  data_center_name?: string;
  region?: string;
  stock: RunpodStockLevel;
  // USD per GPU-hour list price; the pod's billed cost is on the pod
  price_per_gpu_hour?: number;
  // largest GPU count on one pod of this type in this cloud
  max_count?: number;
}

export interface GpuAvailabilityFilter {
  // GPU type ids or names, matched case-insensitively
  gpu?: string[];
  cloud?: RunpodCloud;
  data_center?: string[];
  // e.g. NORTH_AMERICA, EUROPE
  region?: string[];
  min_stock?: RunpodStockLevel;
  max_price_per_gpu_hour?: number;
  // only offers whose type allows at least this many GPUs on one pod
  min_count?: number;
}

export interface GpuAvailabilityResult {
  provider: GpuProvider;
  as_of: string;
  // sorted by price, then stock (highest first)
  offers: GpuOffer[];
}

export interface GpuPodsResult {
  provider: GpuProvider;
  as_of: string;
  // "managed" (the default): the pods CoCalc started that the caller pays for
  // or is responsible for, with their records. "account": every pod in the
  // provider account, read live, including ones CoCalc didn't start.
  scope: "account" | "managed";
  // live views from RunPod (for "managed", only pods with a record here)
  pods: RunpodPodView[];
  // CoCalc's records, for "managed"
  records?: GpuPodSummary[];
  // why live views are missing (e.g. no usable key); records still come
  live_error?: string;
}

export interface GpuApi {
  catalog: (opts?: GpuReadOpts) => Promise<GpuCatalogResult>;
  availability: (
    opts?: GpuReadOpts & GpuAvailabilityFilter,
  ) => Promise<GpuAvailabilityResult>;
  // With pod_id, that one pod read live (with SSH endpoints and runtime
  // metrics), or no pods if it doesn't exist.
  pods: (
    opts?: GpuReadOpts & {
      pod_id?: string;
      scope?: "managed" | "account";
      // also terminated and failed pods from the last 30 days
      include_ended?: boolean;
    },
  ) => Promise<GpuPodsResult>;
  launch: (opts: {
    account_id?: string;
    project_id: string;
    spec: GpuLaunchSpec;
    timeout?: number;
  }) => Promise<GpuPodSummary>;
  // pod_id: CoCalc's pod id, the handle, or RunPod's pod id
  terminate: (opts: {
    account_id?: string;
    pod_id: string;
    timeout?: number;
  }) => Promise<{ state: GpuPodSummary["state"] }>;
  // query: a pod id, handle, RunPod pod id or IP address
  who: (opts: {
    account_id?: string;
    query: string;
  }) => Promise<GpuAttribution[]>;
}
