/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import { showCodexProjectStartFailure } from "@cocalc/frontend/chat/codex-project-start-failure";
import { ensureProjectRunningForCodex } from "@cocalc/frontend/chat/codex-submit-preflight";

export async function preflightNewAgentProjectStart({
  projectId,
  onOpenMembershipDetails,
}: {
  projectId: string;
  onOpenMembershipDetails: () => void;
}): Promise<boolean> {
  try {
    await ensureProjectRunningForCodex({ project_id: projectId, redux });
    return true;
  } catch (error) {
    showCodexProjectStartFailure({
      error,
      projectId,
      onOpenMembershipDetails,
    });
    return false;
  }
}
