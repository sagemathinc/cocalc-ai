/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { ProjectViewerReadPolicy } from "@cocalc/util/project-access";
import {
  authFirstRequireHostWithAccountTarget,
  authFirstRequireAccountWithBoundSession,
} from "./util";
import type {
  ApiKeyActionDecision,
  ApiKeyActionReview,
} from "@cocalc/util/api-key-management";

export interface GetApiKeyViewerReadPolicyOptions {
  host_id?: string;
  account_id: string;
  key_id: string;
  scope_revision: number;
  project_id: string;
  viewer_policy_hash: string;
}

export interface ApiKeys {
  decideAction: (
    opts: Omit<ApiKeyActionDecision, "account_id" | "session_hash"> & {
      account_id?: string;
      session_hash?: string;
    },
  ) => Promise<ApiKeyActionReview>;
  getViewerReadPolicy: (
    opts: GetApiKeyViewerReadPolicyOptions,
  ) => Promise<ProjectViewerReadPolicy>;
}

export const apiKeys = {
  decideAction: authFirstRequireAccountWithBoundSession,
  getViewerReadPolicy: authFirstRequireHostWithAccountTarget,
} as const;
