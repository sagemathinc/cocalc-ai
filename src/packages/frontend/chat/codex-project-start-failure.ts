/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { message, Modal } from "antd";
import { showRuntimeSponsorDenialModal } from "@cocalc/frontend/project/start-button";
import { getProjectStartPolicyBlockFromError } from "@cocalc/frontend/projects/runtime-start-policy";
import { showProjectStartRequiredModal } from "@cocalc/frontend/projects/start-required-modal";
import { extractRuntimeSponsorDenial } from "@cocalc/util/runtime-sponsor-denial";

export function showCodexProjectStartFailure({
  error,
  projectId,
  onOpenMembershipDetails,
}: {
  error: unknown;
  projectId: string;
  onOpenMembershipDetails: () => void;
}): void {
  const denial = extractRuntimeSponsorDenial(error);
  if (denial) {
    showRuntimeSponsorDenialModal({
      denial,
      project_id: projectId,
      onOpenMembershipDetails,
      onStarted: () =>
        message.success(
          "Project started. Your draft is still in the composer; send it when ready.",
        ),
    });
    return;
  }

  const block = getProjectStartPolicyBlockFromError(error);
  if (block) {
    showProjectStartRequiredModal({
      project_id: projectId,
      title: "Start project to use Codex",
      block,
    });
    return;
  }

  Modal.error({
    title: "Unable to start project for Codex",
    content: `${error}`,
  });
}
