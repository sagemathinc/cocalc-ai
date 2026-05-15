/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Modal, Space, Typography } from "antd";

import { redux } from "@cocalc/frontend/app-framework";
import type { ProjectStartPolicyBlock } from "./runtime-start-policy";
import { getProjectStartPolicyBlock } from "./runtime-start-policy";

function getProject(projectsStore: any, project_id: string): any {
  return (
    projectsStore?.getIn?.(["project_map", project_id]) ??
    projectsStore?.get?.("project_map")?.get?.(project_id)
  );
}

export function getAutostartProjectStartPolicyBlock(
  project_id: string,
): ProjectStartPolicyBlock | undefined {
  const projectsStore = redux.getStore("projects");
  const accountStore = redux.getStore("account");
  return getProjectStartPolicyBlock({
    project: getProject(projectsStore, project_id),
    account_id: accountStore?.get?.("account_id"),
    is_admin: !!accountStore?.get?.("is_admin"),
    autostart: true,
  });
}

export function showProjectStartRequiredModal({
  project_id,
  title,
  block,
}: {
  project_id: string;
  title: string;
  block?: ProjectStartPolicyBlock;
}): void {
  const message =
    block?.message ?? "This action requires the project to be running.";
  const action = block?.action ?? "Start the project, then try again.";
  const okText =
    block?.code === "collaborator_sponsor_disabled"
      ? "Open Start Options"
      : "Start Project";

  Modal.confirm({
    title,
    okText,
    cancelText: "Cancel",
    content: (
      <Space direction="vertical" size={8}>
        <Typography.Text>{message}</Typography.Text>
        <Typography.Text type="secondary">{action}</Typography.Text>
      </Space>
    ),
    onOk: async () => {
      await redux
        .getActions("projects")
        .start_project(project_id, { autostart: false });
    },
  });
}
