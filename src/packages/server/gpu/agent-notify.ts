/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Tell the key owner's open browsers that a project's agent GPU requests
// changed, so the project's approval banner refetches (step 6b-2). Only the
// owner can see or approve them, so only the owner is told. It says nothing
// but "look again"; never waited for, and failures don't matter.

import { GPU_AGENT_REQUESTS_PROJECT_DETAIL_FIELD } from "@cocalc/conat/hub/api/gpu";
import { publishAccountFeedEventBestEffort } from "@cocalc/server/account/feed";

export function notifyAgentRequestsChanged(
  account_id: string,
  project_ids: Iterable<string | null | undefined>,
): void {
  const ts = Date.now();
  for (const project_id of new Set(project_ids)) {
    if (!project_id) continue;
    void publishAccountFeedEventBestEffort({
      account_id,
      event: {
        type: "project.detail.invalidate",
        ts,
        account_id,
        project_id,
        fields: [GPU_AGENT_REQUESTS_PROJECT_DETAIL_FIELD],
      },
    });
  }
}
