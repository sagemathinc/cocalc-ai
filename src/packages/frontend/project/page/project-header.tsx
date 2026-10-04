/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The project's own header, like an agent's: which project this is (its
// avatar, title and color), whether it is running, and its update. Without
// project tabs at the top, this is how you know where you are.

import type { ReactNode } from "react";
import { Button, Dropdown, type MenuProps } from "antd";
import {
  redux,
  useProjectFromMap,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components/icon";
import {
  PAGE_HEADER_TITLE_STYLE,
  PageHeader,
} from "@cocalc/frontend/components/page-header";
import {
  projectStatusColor,
  projectStatusLabel,
  useRestarting,
} from "@cocalc/frontend/projects/project-status-display";
import { StartButton } from "@cocalc/frontend/project/start-button";
import {
  ProjectThemeAvatar,
  projectThemeFromProject,
} from "@cocalc/frontend/projects/theme";
import { headerColors } from "@cocalc/frontend/components/header-colors";
import { themeIdentityColor } from "@cocalc/frontend/components/identity-color";
import { ProjectUpdateIndicator } from "./project-version-update";
import { useProjectState } from "./project-state-hook";

export function ProjectPageHeader({
  project_id,
  leading,
  badges,
  runtimeControls,
  showUpdate,
}: {
  project_id: string;
  // E.g., the show-sidebar control when the sidebar is hidden.
  leading?: ReactNode;
  // Status tags after the project's state (read only, internet blocked).
  badges?: ReactNode;
  // Start, restart and stop (not for viewers).
  runtimeControls?: boolean;
  showUpdate?: boolean;
}) {
  const project = useProjectFromMap<any>(project_id);
  const egressError = useTypedRedux("account", "managed_egress_blocked_error");
  const state = `${useProjectState(project_id)?.get?.("state") ?? ""}`;
  const restarting = useRestarting(
    project_id,
    state,
    project?.getIn(["state", "started_at"]),
  );
  const title = `${project?.get("title") ?? ""}`.trim() || "Untitled project";
  // The project's theme colors the header exactly as an agent's does.
  const theme = projectThemeFromProject(project);
  const primaryColor = theme?.color?.trim() || undefined;
  const accentColor = theme?.accent_color?.trim() || undefined;
  const { backgroundColor, textColor } = headerColors({
    primaryColor,
    accentColor,
  });
  const identityColor = themeIdentityColor(
    { primaryColor, accentColor },
    project_id,
  );
  const status = egressError
    ? "Account internet usage blocked"
    : restarting
      ? "Restarting…"
      : projectStatusLabel(state);
  const dot = projectStatusColor(
    restarting ? "starting" : state,
    undefined,
    !!egressError,
  );
  const openSettings = () =>
    redux.getProjectActions(project_id)?.set_active_tab("settings");
  const projects = redux.getActions("projects");
  const running = state === "running";
  const menu: MenuProps["items"] = [
    ...(runtimeControls && running
      ? [
          {
            key: "restart",
            label: "Restart project",
            icon: <Icon name="refresh" />,
            onClick: () => void projects.restart_project(project_id),
          },
          {
            key: "stop",
            label: "Stop project",
            icon: <Icon name="stop" />,
            onClick: () => void projects.stop_project(project_id),
          },
          { type: "divider" as const },
        ]
      : []),
    {
      key: "settings",
      label: "Project settings",
      icon: <Icon name="wrench" />,
      onClick: openSettings,
    },
  ];
  return (
    <PageHeader
      identityColor={identityColor}
      background={backgroundColor}
      color={textColor}
      aria-label={`Project ${title}`}
    >
      {leading}
      <Button
        type="text"
        aria-label="Project settings"
        title="Project settings"
        onClick={openSettings}
        style={{ color: textColor, height: 32, padding: 4 }}
      >
        <ProjectThemeAvatar project={project} size={24} />
      </Button>
      {/* One line: the title, then the state, which gives way first. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          minWidth: 0,
          flex: 1,
        }}
      >
        <h1 style={PAGE_HEADER_TITLE_STYLE} title={title}>
          {title}
        </h1>
        <span
          role="status"
          title={status}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
            fontSize: 12,
            opacity: 0.75,
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: dot,
              flex: "0 0 auto",
            }}
          />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {status}
          </span>
        </span>
        {badges}
        {showUpdate && <ProjectUpdateIndicator project_id={project_id} />}
      </div>
      {runtimeControls && <StartButton minimal size="small" />}
      <Dropdown menu={{ items: menu }} trigger={["click"]}>
        <Button
          type="text"
          aria-label="Project actions"
          style={{ color: textColor }}
          icon={<Icon name="ellipsis" rotate="90" />}
        />
      </Dropdown>
    </PageHeader>
  );
}
