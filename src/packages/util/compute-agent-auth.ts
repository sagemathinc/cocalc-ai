/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
/** Verified managed-compute capability claims, injected by the hub auth layer. */
export interface ComputeAgentAuth {
  account_id: string;
  project_id: string;
  token_fingerprint: string;
  issued_at_s: number;
  expires_at_s: number;
}

export type ComputeAgentAction =
  | "read"
  | "data-plane"
  | "availability"
  | "billable"
  | "destructive";
export interface ComputeAgentGrantRequest {
  operation?: string;
  operation_id?: string;
  vm_id?: string;
  allow_create?: boolean;
  provider?: "gcp" | "nebius";
  machine_class?: string;
  funding_mode?: string;
  active_vms?: number;
  hourly_usd?: number;
  total_authorized_usd?: number;
  ttl_minutes?: number;
}
export interface ComputeAgentGrantAuthorization {
  grant_id: string;
  project_vm_availability_scope: boolean;
}
export interface ComputeAgentGrantCheck {
  auth?: ComputeAgentAuth;
  action: ComputeAgentAction;
  project_id: string;
  vm_id?: string;
  request?: ComputeAgentGrantRequest;
}
export type ComputeAgentGrantCheckResult =
  | { authorization: ComputeAgentGrantAuthorization }
  | {
      approval_required: {
        message: string;
        code: "agent_grant_required";
        grant_id: string;
        request_id: string;
        approval_url: string;
        expires_at: string;
        project_id: string;
      };
    };

/**
 * The account a managed-compute call acts for: the agent credential's account
 * for an agent call, else the calling account. A call carries one or the other,
 * never both (the hub strips agent_auth from every non-agent caller); both
 * means the identity was assembled wrongly, so it is refused.
 */
export function computeCallerAccountId(opts: {
  account_id?: string;
  agent_auth?: ComputeAgentAuth;
}): string | undefined {
  if (opts.agent_auth != null && opts.account_id != null) {
    throw Object.assign(new Error("ambiguous managed-compute actor"), {
      code: 403,
    });
  }
  return opts.agent_auth?.account_id ?? opts.account_id;
}
