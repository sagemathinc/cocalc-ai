/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Modal } from "antd";
import { redux } from "@cocalc/frontend/app-framework";
import type { AcpAutomationResponse } from "@cocalc/conat/ai/acp/types";

export function isActiveAutomationLimitResponse(
  response?: AcpAutomationResponse | null,
): response is AcpAutomationResponse & {
  code: "active_automation_limit";
  current: number;
  maximum: number;
} {
  return (
    response?.ok === false &&
    response.code === "active_automation_limit" &&
    typeof response.current === "number" &&
    typeof response.maximum === "number"
  );
}

export function openProjectAgentsFlyout(project_id: string): void {
  const projectId = `${project_id ?? ""}`.trim();
  if (!projectId) return;
  redux.getProjectActions(projectId)?.setFlyoutExpanded?.("agents", true);
}

export function showActiveAutomationLimitModal({
  project_id,
  response,
}: {
  project_id: string;
  response?: AcpAutomationResponse | null;
}): boolean {
  if (!isActiveAutomationLimitResponse(response)) return false;
  Modal.confirm({
    title: "Active automation limit reached",
    content: `This project already has ${response.current}/${response.maximum} active scheduled automations. Open the Agents panel to review or disable existing automations, then try again.`,
    okText: "Open Agents panel",
    cancelText: "Close",
    onOk: () => openProjectAgentsFlyout(project_id),
  });
  return true;
}
