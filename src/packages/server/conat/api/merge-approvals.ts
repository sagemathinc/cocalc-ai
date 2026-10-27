/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  decideMergeApproval,
  requestMergeApproval,
  type DecideMergeApprovalOptions,
  type RequestMergeApprovalOptions,
} from "@cocalc/server/merge-approvals/api";

export async function request(opts: RequestMergeApprovalOptions) {
  return await requestMergeApproval(opts);
}

export async function decide(opts: DecideMergeApprovalOptions) {
  return await decideMergeApproval(opts);
}
