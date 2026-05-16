/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/**
 * Actions menu for project table rows
 *
 * Dropdown menu with context-sensitive actions for each project:
 * - Open project
 * - Open settings
 * - Hide/Unhide (conditional)
 * - Permanent delete (owner only)
 */

import type { ProjectTableRecord } from "./projects-table-columns";

import { Dropdown, MenuProps, Modal } from "antd";
import { useState } from "react";
import { useIntl } from "react-intl";

import {
  CSS,
  redux,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { FIXED_PROJECT_TABS } from "@cocalc/frontend/project/page/file-tab";
import { useStarredFilesManager } from "@cocalc/frontend/project/page/flyouts/store";
import {
  OpenedFile,
  useFilesMenuItems,
  useRecentFiles,
  useServersMenuItems,
} from "./util";
import { HostPickerModal } from "@cocalc/frontend/hosts/pick-host";
import {
  DEFAULT_R2_REGION,
  mapCloudRegionToR2Region,
} from "@cocalc/util/consts";
import { COLORS } from "@cocalc/util/theme";
import { useProjectRegion } from "@cocalc/frontend/project/use-project-region";
import { HardDeleteProjectModal } from "./hard-delete-project-modal";
import { confirmRemoveMyselfFromProject } from "./remove-myself";

const FILES_SUBMENU_LIST_STYLE: CSS = {
  maxWidth: "80vw",
  minWidth: "150px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  display: "inline-block",
} as const;

interface Props {
  record: ProjectTableRecord;
}

export function ProjectActionsMenu({ record }: Props) {
  const [open, setOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const intl = useIntl();
  const actions = useActions("projects");
  const account_id = useTypedRedux("account", "account_id");
  const isAdmin = !!useTypedRedux("account", "is_admin");
  const projectLabel = intl.formatMessage(labels.project);
  const projectLabelLower = projectLabel.toLowerCase();
  const isDeleting = record.deleting === true;
  const project_map = useTypedRedux("projects", "project_map");
  const currentHostId = project_map?.getIn([record.project_id, "host_id"]) as
    | string
    | undefined;
  const { region: projectRegionRaw, refresh: refreshProjectRegion } =
    useProjectRegion(record.project_id);
  const projectRegion = String(projectRegionRaw ?? DEFAULT_R2_REGION);
  const project_log = useTypedRedux(
    { project_id: record.project_id },
    "project_log",
  );

  // Initialize project_log when menu opens if not already loaded
  function handleOpenChange(newOpen: boolean) {
    setOpen(newOpen);
    if (newOpen && project_log == null) {
      redux.getProjectActions(record.project_id)?.refresh_project_log();
    }
  }

  // Check if user is owner of this project
  const isOwner =
    project_map?.getIn([record.project_id, "users", account_id, "group"]) ===
    "owner";
  const canArchive =
    isAdmin ||
    isOwner ||
    project_map?.getIn([
      record.project_id,
      "allow_collaborator_destructive_storage_actions",
    ]) === true;
  const archiveDisabled =
    isDeleting ||
    ["starting", "stopping", "archiving", "unarchiving", "archived"].includes(
      `${record.state?.get?.("state") ?? ""}`,
    ) ||
    !canArchive;

  // Get recent files - only when menu is open
  const recentFiles: OpenedFile[] = useRecentFiles(project_log, open ? 100 : 0);

  // Get starred files - only when menu is open
  const { starred } = useStarredFilesManager(record.project_id, open);

  const starredFilesSubmenu: MenuProps["items"] = useFilesMenuItems(starred, {
    emptyLabel: "No starred files",
    labelStyle: FILES_SUBMENU_LIST_STYLE,
    keyPrefix: "starred-file:",
  });

  const recentFilesSubmenu: MenuProps["items"] = useFilesMenuItems(
    recentFiles,
    {
      emptyLabel: "No recent files",
      labelStyle: FILES_SUBMENU_LIST_STYLE,
      keyPrefix: "recent-file:",
    },
  );

  // Get available servers/apps
  const serversSubmenu: MenuProps["items"] = useServersMenuItems(
    record.project_id,
  );

  function openProjectTab(tab: string) {
    if (isDeleting) {
      return;
    }
    actions.open_project({
      project_id: record.project_id,
      switch_to: true,
      target: tab,
    });
  }

  function openFile(path: string) {
    const project_actions = redux.getProjectActions(record.project_id);
    if (project_actions) {
      project_actions.open_file({ path });
    }
  }

  const handleMenuClick: MenuProps["onClick"] = async ({ key, domEvent }) => {
    domEvent.stopPropagation(); // Don't trigger row click

    switch (key) {
      case "open":
        if (isDeleting) break;
        actions.open_project({
          project_id: record.project_id,
          switch_to: true,
        });
        break;
      case "explorer":
        if (isDeleting) break;
        openProjectTab("files");
        break;
      case "new":
        if (isDeleting) break;
        openProjectTab("new");
        break;
      case "log":
        if (isDeleting) break;
        openProjectTab("log");
        break;
      case "move":
        if (isDeleting) break;
        await refreshProjectRegion();
        setMoveOpen(true);
        break;
      case "archive":
        if (archiveDisabled) break;
        Modal.confirm({
          title: `Archive ${projectLabelLower}`,
          icon: <Icon name="file-archive" style={{ color: COLORS.BRWN }} />,
          width: 520,
          content: (
            <div>
              <p>
                Archiving removes the active copy from the project host. CoCalc
                will stop the {projectLabelLower} if needed, create a final
                backup when needed, then archive it.
              </p>
              <p style={{ color: COLORS.GRAY_M }}>
                Starting it later restores it from backup, which is slower, but
                archived {projectLabelLower}s do not count toward active storage
                usage.
              </p>
            </div>
          ),
          okText: "Archive",
          onOk: async () => {
            try {
              await actions.archive_project(record.project_id);
            } catch (err) {
              Modal.error({
                title: "Archive failed",
                content: `${err}`,
              });
            }
          },
        });
        break;
      case "settings":
        if (isDeleting) break;
        actions.open_project({
          project_id: record.project_id,
          switch_to: true,
          target: "settings",
        });
        break;
      case "hide":
        await actions.toggle_hide_project(record.project_id);
        break;
      case "delete":
        if (isDeleting) break;
        setDeleteOpen(true);
        break;
      case "remove-self":
        confirmRemoveMyselfFromProject({
          project_id: record.project_id,
          account_id,
          projectLabel,
          projectLabelLower,
        });
        break;
      default:
        if (isDeleting) {
          break;
        }
        // Handle starred files - check if key starts with "starred-file:"
        if (key.startsWith("starred-file:")) {
          const filename = key.substring("starred-file:".length);
          openFile(filename);
        }
        // Handle recent files - check if key starts with "recent-file:"
        else if (key.startsWith("recent-file:")) {
          const filename = key.substring("recent-file:".length);
          openFile(filename);
        }
        break;
    }
    setOpen(false);
  };

  const menuItems: MenuProps["items"] = [
    ...(isDeleting
      ? [
          {
            key: "deleting",
            label: "Permanent deletion in progress",
            icon: <Icon name="spinner" spin />,
            disabled: true,
          },
          {
            type: "divider" as const,
          },
        ]
      : []),
    {
      key: "explorer",
      label: intl.formatMessage(labels.explorer),
      icon: <Icon name={FIXED_PROJECT_TABS.files.icon} />,
      disabled: isDeleting,
    },
    {
      type: "divider",
    },
    {
      key: "starred-files",
      label: "Starred Files",
      icon: <Icon name="star-filled" />,
      children: starredFilesSubmenu,
      popupClassName: "cc-starred-files-submenu",
      disabled: isDeleting,
    },
    {
      key: "recent-files",
      label: intl.formatMessage(labels.recent_files),
      icon: <Icon name="history" />,
      children: recentFilesSubmenu,
      popupClassName: "cc-recent-files-submenu",
      disabled: isDeleting,
    },
    {
      key: "apps",
      label: "Apps",
      icon: <Icon name="server" />,
      children: serversSubmenu,
      popupClassName: "cc-apps-submenu",
      disabled: isDeleting,
    },
    {
      type: "divider",
    },
    {
      key: "new",
      label: intl.formatMessage(labels.new),
      icon: <Icon name={FIXED_PROJECT_TABS.new.icon} />,
      disabled: isDeleting,
    },
    {
      key: "log",
      label: "Log",
      icon: <Icon name={FIXED_PROJECT_TABS.log.icon} />,
      disabled: isDeleting,
    },
    {
      key: "settings",
      label: "Settings",
      icon: <Icon name={FIXED_PROJECT_TABS.settings.icon} />,
      disabled: isDeleting,
    },
    {
      key: "move",
      label: "Move to host…",
      icon: <Icon name="server" />,
      disabled: isDeleting,
    },
    {
      key: "archive",
      label: "Archive…",
      icon: <Icon name="file-archive" />,
      disabled: archiveDisabled,
    },
    {
      type: "divider",
    },
    ...(!isOwner
      ? [
          {
            key: "remove-self",
            label: "Remove Myself as Collaborator",
            icon: <Icon name="user-times" />,
            danger: true,
          },
          {
            type: "divider" as const,
          },
        ]
      : []),
    {
      key: "hide",
      label: record.hidden ? `Unhide ${projectLabel}` : `Hide ${projectLabel}`,
      icon: <Icon name={record.hidden ? "eye" : "eye-slash"} />,
    },
    ...(isOwner
      ? [
          {
            key: "delete",
            label: `Delete ${projectLabel}`,
            icon: <Icon name="trash" />,
            danger: true,
            disabled: isDeleting,
          },
        ]
      : []),
  ];

  return (
    <div
      onClick={(e) => e.stopPropagation()} // Prevent row click when clicking menu
      style={{ cursor: "pointer" }}
    >
      {moveOpen && (
        <HostPickerModal
          open={moveOpen}
          currentHostId={currentHostId}
          regionFilter={projectRegion}
          sourceProjectRegion={projectRegion}
          showOfflineMoveWarning
          onCancel={() => setMoveOpen(false)}
          onSelect={async (dest_host_id, host) => {
            setMoveOpen(false);
            try {
              const destProjectRegion = host
                ? mapCloudRegionToR2Region(host.region)
                : undefined;
              await actions.move_project_to_host(
                record.project_id,
                dest_host_id,
                {
                  backup_region_cutover:
                    destProjectRegion != null &&
                    destProjectRegion !== projectRegion,
                  dest_project_region: destProjectRegion,
                },
              );
            } catch (err) {
              console.error("move project failed", err);
              Modal.error({
                title: "Move failed",
                content: `${err}`,
              });
            }
          }}
        />
      )}
      <style>
        {`
          .cc-starred-files-submenu .ant-dropdown-menu,
          .cc-recent-files-submenu .ant-dropdown-menu,
          .cc-apps-submenu .ant-dropdown-menu {
            max-height: 50vh;
            overflow-y: auto;
          }
        `}
      </style>
      <Dropdown
        menu={{ items: menuItems, onClick: handleMenuClick }}
        trigger={["click"]}
        open={open}
        onOpenChange={handleOpenChange}
      >
        <span style={{ fontSize: "18px", padding: "4px 8px" }}>
          <Icon name="ellipsis" rotate="90" />
        </span>
      </Dropdown>
      <HardDeleteProjectModal
        open={deleteOpen}
        project_id={record.project_id}
        title={record.title}
        onCancel={() => setDeleteOpen(false)}
        onDeleted={() => {
          redux.getActions("page").close_project_tab(record.project_id);
        }}
      />
    </div>
  );
}
