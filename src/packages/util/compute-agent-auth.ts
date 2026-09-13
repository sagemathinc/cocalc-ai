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
