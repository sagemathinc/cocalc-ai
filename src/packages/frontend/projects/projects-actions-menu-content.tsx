/*
 *  This file is part of CoCalc: Copyright © 2025-2026 Sagemath, Inc.
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

import { Dropdown, type MenuProps, Modal } from "antd";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";

import {
  CSS,
  redux,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { Icon } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
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
import { useProjectRegion } from "@cocalc/frontend/project/use-project-region";
import { ArchiveProjectModal } from "./archive-project-modal";
import { HardDeleteProjectModal } from "./hard-delete-project-modal";
import { publicShareCountFromProjectLabels } from "./public-share-labels";
import { confirmRemoveMyselfFromProject } from "./remove-myself";
import { ProjectActionsTrigger } from "./project-actions-trigger";

const FILES_SUBMENU_LIST_STYLE: CSS = {
  maxWidth: "80vw",
  minWidth: "150px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  display: "inline-block",
} as const;

export interface ProjectActionsMenuProps {
  record: ProjectTableRecord;
  onToggleDetails: () => void;
}

export interface ProjectActionsMenuContentProps extends ProjectActionsMenuProps {
  defaultOpen?: boolean;
  restoreFocus?: boolean;
}

export function ProjectActionsMenuContent({
  record,
  onToggleDetails,
  defaultOpen = false,
  restoreFocus = false,
}: ProjectActionsMenuContentProps) {
  const [open, setOpen] = useState(defaultOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const intl = useIntl();
  const actions = useActions("projects");
  const account_id = useTypedRedux("account", "account_id");
  const isAdmin = !!useTypedRedux("account", "is_admin");
  const projectLabel = intl.formatMessage(labels.project);
  const projectLabelLower = projectLabel.toLowerCase();
  const isDeleting = record.deleting === true;
  const deleteFailed = record.deleteFailed === true;
  const deletionBlocked = record.deletionBlocked === true;
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

  useLayoutEffect(() => {
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }, [restoreFocus]);

  // Initialize project_log when the menu opens if it is not already loaded.
  useEffect(() => {
    if (open && project_log == null) {
      redux.getProjectActions(record.project_id)?.refresh_project_log();
    }
  }, [open]);

  function handleOpenChange(newOpen: boolean) {
    setOpen(newOpen);
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
  const archiveAllowedByAdminOnly =
    canArchive &&
    isAdmin &&
    !isOwner &&
    project_map?.getIn([
      record.project_id,
      "allow_collaborator_destructive_storage_actions",
    ]) !== true;
  const archiveDisabled =
    deletionBlocked ||
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
    if (deletionBlocked) {
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
      case "details":
        onToggleDetails();
        break;
      case "open":
        actions.open_project({
          project_id: record.project_id,
          switch_to: true,
        });
        break;
      case "explorer":
        if (deletionBlocked) break;
        openProjectTab("files");
        break;
      case "new":
        if (deletionBlocked) break;
        openProjectTab("new");
        break;
      case "log":
        if (deletionBlocked) break;
        openProjectTab("log");
        break;
      case "move":
        if (deletionBlocked) break;
        await refreshProjectRegion();
        setMoveOpen(true);
        break;
      case "archive":
        if (archiveDisabled) break;
        setArchiveOpen(true);
        break;
      case "settings":
        if (deletionBlocked) break;
        actions.open_project({
          project_id: record.project_id,
          switch_to: true,
          target: "settings",
        });
        break;
      case "hide":
        try {
          await actions.toggle_hide_project(record.project_id);
        } catch {
          // The action restores optimistic state and presents the error.
        }
        break;
      case "delete":
        if (isDeleting) break;
        setDeleteOpen(true);
        break;
      case "remove-self":
        if (deletionBlocked) break;
        confirmRemoveMyselfFromProject({
          project_id: record.project_id,
          account_id,
          projectLabel,
          projectLabelLower,
        });
        break;
      default:
        if (deletionBlocked) {
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
    {
      key: "details",
      label: "Details",
      icon: <Icon name="info-circle" />,
    },
    {
      type: "divider",
    },
    ...(deletionBlocked
      ? [
          {
            key: "deleting",
            label: deleteFailed
              ? "Permanent deletion failed"
              : "Permanent deletion in progress",
            icon: deleteFailed ? (
              <Icon name="warning" />
            ) : (
              <Icon name="spinner" spin />
            ),
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
      icon: <Icon name="folder-open" />,
      disabled: deletionBlocked,
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
      disabled: deletionBlocked,
    },
    {
      key: "recent-files",
      label: intl.formatMessage(labels.recent_files),
      icon: <Icon name="history" />,
      children: recentFilesSubmenu,
      popupClassName: "cc-recent-files-submenu",
      disabled: deletionBlocked,
    },
    {
      key: "apps",
      label: "Apps",
      icon: <Icon name="server" />,
      children: serversSubmenu,
      popupClassName: "cc-apps-submenu",
      disabled: deletionBlocked,
    },
    {
      type: "divider",
    },
    {
      key: "new",
      label: intl.formatMessage(labels.new),
      icon: <Icon name="plus-circle" />,
      disabled: deletionBlocked,
    },
    {
      key: "log",
      label: "Log",
      icon: <Icon name="history" />,
      disabled: deletionBlocked,
    },
    {
      key: "settings",
      label: "Settings",
      icon: <Icon name="wrench" />,
      disabled: deletionBlocked,
    },
    {
      key: "move",
      label: "Move to host…",
      icon: <Icon name="server" />,
      disabled: deletionBlocked,
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
            disabled: deletionBlocked,
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
            label: deleteFailed
              ? `Retry Delete ${projectLabel}`
              : `Delete ${projectLabel}`,
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
              await runFreshAuthAction(async () => {
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
              });
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
        <ProjectActionsTrigger ref={triggerRef} aria-expanded={open} />
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
      <ArchiveProjectModal
        open={archiveOpen}
        projects={[
          {
            project_id: record.project_id,
            title: record.title,
            state: record.state?.get?.("state"),
            archiveAllowedByAdminOnly,
            publicShareCount: publicShareCountFromProjectLabels(record.labels),
          },
        ]}
        onCancel={() => setArchiveOpen(false)}
        onArchive={async ([project_id]) => {
          await actions.archive_project(project_id);
        }}
      />
      <FreshAuthModal {...freshAuthModalProps} />
    </div>
  );
}
