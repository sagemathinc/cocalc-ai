/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { ProjectViewerReadPolicy } from "@cocalc/util/project-access";
import { authFirstRequireHostWithAccountTarget } from "./util";

export interface GetApiKeyViewerReadPolicyOptions {
  host_id?: string;
  account_id: string;
  key_id: string;
  scope_revision: number;
  project_id: string;
  viewer_policy_hash: string;
}

export interface ApiKeys {
  getViewerReadPolicy: (
    opts: GetApiKeyViewerReadPolicyOptions,
  ) => Promise<ProjectViewerReadPolicy>;
}

export const apiKeys = {
  getViewerReadPolicy: authFirstRequireHostWithAccountTarget,
} as const;
