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
  GpuBudget,
  GpuSpendGroupBy,
  GpuSpendResult,
  GpuBudgetChange,
  GpuAlert,
  GpuAttribution,
  GpuAccountChecks,
  GpuCompromiseStatus,
  GpuLaunchSpec,
  GpuPodSshInfo,
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
  authFirstRequireAccountOrGpuAgent,
  authFirstRequireAccountWithBoundSession,
} from "./util";

// Agents may read the catalog and stock for the account they act for, from
// the project sealed into their token. Their pod calls (step 6b) are scoped
// to the managed pods that agent launched in that project, and a launch needs
// the human's approval of exactly that launch for the agent's run; the agent
// principal comes only from the verified token (account-or-gpu-agent).
export const gpu = {
  // (the verified agent token too: a catalog read decrypts the account's
  // key, and its audit record names the agent, 5d-2c)
  catalog: authFirstRequireAccountOrGpuAgent,
  availability: authFirstRequireAccountOrGpuAgent,
  pods: authFirstRequireAccountOrGpuAgent,
  launch: authFirstRequireAccountOrGpuAgent,
  terminate: authFirstRequireAccountOrGpuAgent,
  who: authFirstRequireAccountOrGpuAgent,
  // the human's side of agent launches (step 6b)
  agentRequests: authFirstRequireAccount,
  // fresh auth, with the caller's own session, never a nominated one
  approveAgentRequest: authFirstRequireAccountWithBoundSession,
  revokeAgentGrant: authFirstRequireAccount,
  budget: authFirstRequireAccount,
  spend: authFirstRequireAccount,
  // its fresh-auth check uses the caller's own session, never a nominated one
  setBudget: authFirstRequireAccountWithBoundSession,
  killSwitch: authFirstRequireAccount,
  // widens: fresh auth on the caller's own session
  resume: authFirstRequireAccountWithBoundSession,
  // destructive across the whole RunPod account: fresh auth, own session
  reportCompromised: authFirstRequireAccountWithBoundSession,
  // like setBudget: the fresh-auth check uses the caller's own session
  adminAllowStaleWorkers: authFirstRequireAccountWithBoundSession,
  // what `cocalc gpu connect` needs: the live SSH endpoint and the host key
  // the pod registered (for an agent, only its own pods)
  sshInfo: authFirstRequireAccountOrGpuAgent,
  // the owner's GPU alerts (5d); acknowledging only ends what CoCalc can't
  // check, so it needs no fresh auth
  alerts: authFirstRequireAccount,
  acknowledgeAlert: authFirstRequireAccount,
  // loosens the budget: fresh auth on the caller's own session
  releaseQuarantined: authFirstRequireAccountWithBoundSession,
  // CoCalc admins only (checked by the server): this bay's GPU admin alerts
  adminAlerts: authFirstRequireAccount,
  // the provider-account checks (5d-2b): reading them, and confirming or
  // withdrawing that the RunPod account is the owner's alone (fresh auth on
  // the caller's own session; a human decision, never an agent's)
  accountChecks: authFirstRequireAccount,
  confirmAccountChecks: authFirstRequireAccountWithBoundSession,
};

// Set only by the account-or-gpu-agent policy, from verified auth.
export interface GpuAgentAuth {
  account_id: string;
  project_id: string;
  auth_token_fingerprint: string;
  auth_iat_s: number;
  auth_exp_s: number;
}

// Exactly what an agent asked to launch; the human approves this payload and
// hash, never a reconstruction of it.
export interface GpuAgentRequestView {
  request_id: string;
  project_id: string;
  // "chat_session" for a project-scoped agent token; "registered_agent"
  // with agent and run ids only when genuinely resolved
  principal_kind: "chat_session" | "registered_agent";
  agent_id?: string;
  run_id?: string;
  operation_id: string;
  payload: {
    spec: Omit<GpuLaunchSpec, "ssh_public_key">;
    hourly_usd: string;
    max_cost_usd: string;
    max_pods: 1;
  };
  payload_hash: string;
  state: "pending" | "approved" | "superseded" | "expired" | "denied";
  created: string;
  expires_at: string;
  grant?: {
    grant_id: string;
    state: "active" | "expired" | "revoked";
    expires_at: string;
    launches_used: number;
  };
}

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

// One bay's GPU admin alert (5d-2).
export interface GpuAdminAlert {
  bay_id: string;
  id: string;
  kind: string;
  severity: string;
  dedupe_key: string;
  key_owner_account_id: string | null;
  credential_id: string | null;
  details: Record<string, unknown> | null;
  opened: string;
  last_seen: string;
  resolved_at: string | null;
  emailed_at: string | null;
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
  // An agent's launch also needs an operation_id (its idempotency key) and
  // its human's approval of exactly this launch: without one it fails, with
  // a message naming the request the human is asked to approve.
  launch: (opts: {
    account_id?: string;
    project_id: string;
    spec: GpuLaunchSpec;
    operation_id?: string;
    timeout?: number;
  }) => Promise<GpuPodSummary>;
  // The account's agent GPU requests and grants, newest first.
  agentRequests: (opts?: {
    account_id?: string;
    project_id?: string;
    include_decided?: boolean;
  }) => Promise<GpuAgentRequestView[]>;
  // Approve exactly the reviewed request (fresh authentication).
  approveAgentRequest: (opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    request_id: string;
    expected_hash: string;
  }) => Promise<{
    grant_id: string;
    request_id: string;
    payload_hash: string;
    state: string;
    expires_at: string;
  }>;
  // No new launch, and the grant's running pods are terminated.
  revokeAgentGrant: (opts: {
    account_id?: string;
    grant_id: string;
  }) => Promise<{
    grant_id: string;
    request_id: string;
    payload_hash: string;
    state: string;
    expires_at: string;
  }>;
  // pod_id: CoCalc's pod id, the handle, or RunPod's pod id
  terminate: (opts: {
    account_id?: string;
    pod_id: string;
    timeout?: number;
  }) => Promise<{ state: GpuPodSummary["state"] }>;
  // The connected key's budget (step 5).
  budget: (opts?: { account_id?: string }) => Promise<GpuBudget>;
  // What the pods on your RunPod keys cost in a period (default: the last
  // 30 days, at most 400), grouped by beneficiary (default), agent, project
  // or pod: settled spend, the live pods' estimate so far, and quarantined
  // holds. Times are ISO strings.
  spend: (opts?: {
    account_id?: string;
    since?: string;
    until?: string;
    group_by?: GpuSpendGroupBy;
    timeout?: number;
  }) => Promise<GpuSpendResult>;
  // Lowering limits needs only the owner; raising any (more money, a higher
  // or removed cap, a later end) needs fresh authentication (browser_id).
  setBudget: (opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    change: GpuBudgetChange;
    expected_version?: number;
  }) => Promise<GpuBudget>;
  // Stop every live pod CoCalc started with your key (or one project's). The
  // account kill switch also pauses new launches (pause: false to not); a
  // project's never pauses. Needs no fresh auth: it only narrows.
  killSwitch: (opts?: {
    account_id?: string;
    project_id?: string;
    pause?: boolean;
  }) => Promise<{ marked: number; remaining: number; paused: boolean }>;
  // Report the RunPod key compromised: fresh authentication, and the
  // owner's confirmation that the RunPod account is used only for CoCalc.
  // CoCalc stops launching with the key and terminates EVERY pod in that
  // RunPod account (including ones it didn't start), every sweep, until the
  // owner deletes the key at RunPod (CoCalc can't revoke a RunPod key); once
  // RunPod rejects it and nothing is left, CoCalc removes its copy.
  reportCompromised: (opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    confirm_cocalc_only: boolean;
  }) => Promise<GpuCompromiseStatus>;
  // The provider-account checks (5d-2b): compare the RunPod account's own
  // spend rate and balance with CoCalc's pods, only for an account the owner
  // confirms is used only by them, only for CoCalc. confirm: true confirms it
  // for the connected key (fresh authentication); false withdraws it.
  accountChecks: (opts?: { account_id?: string }) => Promise<GpuAccountChecks>;
  confirmAccountChecks: (opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    confirm: boolean;
  }) => Promise<GpuAccountChecks>;
  // Lift the kill switch's pause and a safety pause (alerts stay open):
  // fresh authentication.
  resume: (opts?: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
  }) => Promise<{ resumed: number }>;
  // Admins only, fresh auth: let one account launch for up to 24 hours
  // although the GPU reaper/reconciler is stale (never bypasses budgets).
  adminAllowStaleWorkers: (opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    target_account_id: string;
    hours: number;
    reason: string;
  }) => Promise<{ id: string; account_id: string; expires_at: string }>;
  // query: a pod id, handle, RunPod pod id or IP address
  who: (opts: {
    account_id?: string;
    query: string;
  }) => Promise<GpuAttribution[]>;
  // pod_id: a pod id, handle or RunPod pod id. ready is false until the pod
  // runs and has registered its host key; then host, port, user and the key.
  sshInfo: (opts: {
    account_id?: string;
    pod_id: string;
  }) => Promise<GpuPodSshInfo>;
  // What CoCalc found that needs the key owner (5d): open alerts, or with
  // include_resolved the recent ones too.
  alerts: (opts?: {
    account_id?: string;
    include_resolved?: boolean;
  }) => Promise<GpuAlert[]>;
  // End an alert only the owner can end (acknowledgeable: true).
  acknowledgeAlert: (opts: {
    account_id?: string;
    id: string;
  }) => Promise<GpuAlert>;
  // CoCalc admins: GPU admin alerts (5d-2), e.g. billing that couldn't be
  // applied; never key material. Every bay's, or only bay_id's; a bay that
  // couldn't be read is listed in errors.
  adminAlerts: (opts?: {
    account_id?: string;
    include_resolved?: boolean;
    bay_id?: string;
  }) => Promise<{
    alerts: GpuAdminAlert[];
    errors: { bay_id: string; error: string }[];
  }>;
  // Release the budget held for a pod whose create CoCalc couldn't confirm
  // (or that a forced removal left unmanaged): fresh authentication.
  releaseQuarantined: (opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    pod_id: string;
  }) => Promise<{ pod_id: string; released_usd: string; warning: string }>;
}
