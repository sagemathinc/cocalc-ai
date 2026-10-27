/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type {
  MergeApprovalDecisionKind,
  MergeApprovalDecisionView,
  MergeApprovalRequest,
  MergeApprovalStatusView,
  MergeApprovalView,
} from "@cocalc/util/merge-approval";
import {
  authFirstRequireAccount,
  authFirstRequireAccountWithBoundSession,
  authFirstRequireBoundAgentProject,
} from "./util";

export interface MergeApprovals {
  // Agents only: ask an approver to approve one exact pull-request head.
  request: (opts: {
    repo: string;
    pr_number: number;
    head_sha: string;
    note?: string;
    agent_label?: string;
    chat?: { path: string; thread_id?: string; message_date?: string };
    // Set by the hub from the agent session:
    account_id?: string;
    project_id?: string;
    auth_actor?: "agent";
    auth_token_fingerprint?: string;
  }) => Promise<MergeApprovalRequest>;
  // Approvers only, from a fresh browser session.
  decide: (opts: {
    request_id: string;
    decision: MergeApprovalDecisionKind;
    comment?: string;
    // Set by the hub from the browser session:
    account_id?: string;
    session_hash?: string;
  }) => Promise<{
    request: MergeApprovalRequest;
    decision: MergeApprovalDecisionView;
  }>;
  // Approvers only: what the hub recorded, for the card.
  get: (opts: {
    request_ids: string[];
    account_id?: string;
  }) => Promise<MergeApprovalView[]>;
  // Agents only: the status of their own project's requests.
  status: (opts: {
    request_ids: string[];
    account_id?: string;
    project_id?: string;
    auth_actor?: "agent";
    auth_token_fingerprint?: string;
  }) => Promise<MergeApprovalStatusView[]>;
}

export const mergeApprovals = {
  request: authFirstRequireBoundAgentProject,
  // Account principals only: agent, project and host callers are refused
  // before this runs.
  decide: authFirstRequireAccountWithBoundSession,
  get: authFirstRequireAccount,
  status: authFirstRequireBoundAgentProject,
} as const;
