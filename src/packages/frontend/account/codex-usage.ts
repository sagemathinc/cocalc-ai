/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CodexUsageStatusInfo } from "@cocalc/conat/hub/api/system";
import { lite } from "@cocalc/frontend/lite";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export const CODEX_USAGE_URL = "https://chatgpt.com/codex/settings/usage";

export const CODEX_USAGE_LABEL = "Open ChatGPT Codex Usage";

export const CODEX_USAGE_STATUS_TIMEOUT_MS = 60_000;

export async function getLiveCodexUsageStatus({
  projectId,
}: {
  projectId?: string;
}): Promise<CodexUsageStatusInfo> {
  if (projectId && !lite) {
    return await webapp_client.conat_client.hub.projects.getCodexUsageStatus({
      project_id: projectId,
      timeout: CODEX_USAGE_STATUS_TIMEOUT_MS,
    });
  }
  return await webapp_client.conat_client.hub.system.getCodexUsageStatus({
    project_id: projectId || undefined,
    timeout: CODEX_USAGE_STATUS_TIMEOUT_MS,
  });
}
