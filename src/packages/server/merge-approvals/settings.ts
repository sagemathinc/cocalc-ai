/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  parseMergeApprovalInstallations,
  parseMergeApprovalRepos,
  parseMergeApprovers,
} from "@cocalc/util/merge-approval";

export interface MergeApprovalAppConfig {
  app_id: string;
  private_key: string;
  // owner (lowercase) -> installation id
  installations: Map<string, string>;
}

export interface MergeApprovalSettings {
  approvers: string[];
  repos: string[];
  // The raw setting, for mergeApprovalNeedsSecondFactor.
  second_factor_repos: string;
  // Undefined until the App is fully configured.
  app?: MergeApprovalAppConfig;
}

export async function getMergeApprovalSettings(): Promise<MergeApprovalSettings> {
  const settings = (await getServerSettings()) as Record<string, unknown>;
  const app_id = `${settings.merge_approval_github_app_id ?? ""}`.trim();
  const private_key =
    `${settings.merge_approval_github_app_private_key ?? ""}`.trim();
  const installations = parseMergeApprovalInstallations(
    settings.merge_approval_github_app_installations,
  );
  return {
    approvers: parseMergeApprovers(settings.merge_approvers),
    repos: parseMergeApprovalRepos(settings.merge_approval_repos),
    second_factor_repos: `${settings.merge_approval_second_factor_repos ?? ""}`,
    app:
      /^\d+$/.test(app_id) && private_key && installations.size > 0
        ? { app_id, private_key, installations }
        : undefined,
  };
}
