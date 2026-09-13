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
