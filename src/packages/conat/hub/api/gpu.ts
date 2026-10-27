/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU bring-your-own-key: GPUs on the account's own provider account (RunPod
first), using the key it connected in Settings. These reads are rich on
purpose, so agents get the provider's full catalog and stock; nothing here
ever returns the key or provider error text. Writes (launch, terminate) come
with the allowlist request builder and budgets.
*/

import type { GpuProvider } from "@cocalc/util/gpu/provider-keys";
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
export const gpu = {
  catalog: authFirstRequireAccountOrBoundAgentProject,
  availability: authFirstRequireAccountOrBoundAgentProject,
  pods: authFirstRequireAccount,
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
  // "account": every pod in the provider account (until CoCalc records
  // which pods it started). "managed": only pods CoCalc started.
  scope: "account" | "managed";
  pods: RunpodPodView[];
}

export interface GpuApi {
  catalog: (opts?: GpuReadOpts) => Promise<GpuCatalogResult>;
  availability: (
    opts?: GpuReadOpts & GpuAvailabilityFilter,
  ) => Promise<GpuAvailabilityResult>;
  // With pod_id, that one pod read live (with SSH endpoints and runtime
  // metrics), or no pods if it doesn't exist.
  pods: (opts?: GpuReadOpts & { pod_id?: string }) => Promise<GpuPodsResult>;
}
