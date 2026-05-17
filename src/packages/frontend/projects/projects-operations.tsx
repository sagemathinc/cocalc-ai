/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/**
 * Bulk operations on filtered/visible projects
 * Shows status alert with action buttons when filters are active
 */

// cSpell:ignore undoable

import { Alert, Button, Modal, Space, Typography } from "antd";
import { Map, Set } from "immutable";
import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import { alert_message } from "@cocalc/frontend/alerts";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { COLORS } from "@cocalc/util/theme";

import {
  LeaveOrDeleteProjectsModal,
  type LeaveOrDeleteProjectsPlan,
} from "./leave-or-delete-projects-modal";
import {
  ArchiveProjectModal,
  type ArchiveProjectModalItem,
} from "./archive-project-modal";

interface Props {
  visible_projects: string[];
  selected_project_ids: string[];
  onSelectionChange: (project_ids: string[]) => void;
  filteredCollaborators?: string[] | null;
  onClearCollaboratorFilter?: () => void;
}

const { Text } = Typography;

export function ProjectsOperations({
  visible_projects,
  selected_project_ids,
  onSelectionChange,
  filteredCollaborators,
  onClearCollaboratorFilter,
}: Props) {
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectsLabel = intl.formatMessage(labels.projects);
  const projectLabelLower = projectLabel.toLowerCase();
  const projectsLabelLower = projectsLabel.toLowerCase();
  const actions = useActions("projects");
  const [leaveDeleteModalOpen, setLeaveDeleteModalOpen] = useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const project_map = useTypedRedux("projects", "project_map");
  const account_id = useTypedRedux("account", "account_id");
  const isAdmin = !!useTypedRedux("account", "is_admin");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) =>
      Modal.error({
        title: "Unable to leave or delete projects",
        content: `${err}`,
      }),
  });

  const hidden = useTypedRedux("projects", "hidden");
  const search: string = useTypedRedux("projects", "search");
  const selected_hashtags: Map<string, Set<string>> = useTypedRedux(
    "projects",
    "selected_hashtags",
  );
  const filter = useMemo(() => {
    return `${!!hidden}`;
  }, [hidden]);

  const selected_hashtags_for_filter: string[] = useMemo(() => {
    return selected_hashtags?.get(filter)?.toJS() ?? [];
  }, [selected_hashtags, filter]);

  // Only show when filters/search/hashtags/collaborators are active
  const isFiltered = useMemo(() => {
    return (
      !!hidden ||
      !!search?.trim() ||
      selected_hashtags_for_filter.length > 0 ||
      (filteredCollaborators && filteredCollaborators.length > 0)
    );
  }, [hidden, search, selected_hashtags_for_filter, filteredCollaborators]);

  // Build status message parts
  const filterParts: string[] = [];
  if (hidden) filterParts.push("hidden");
  const filterText = filterParts.join(" and ");

  const searchHashtagParts: string[] = [];
  if (search?.trim()) {
    searchHashtagParts.push(`'${search.trim()}'`);
  }
  if (selected_hashtags_for_filter.length > 0) {
    // Add # prefix only if not present, then quote each tag
    const formattedTags = selected_hashtags_for_filter
      .map((tag) => `'${tag.startsWith("#") ? tag : "#" + tag}'`)
      .join(" ");
    searchHashtagParts.push(formattedTags);
  }
  const searchHashtagText = searchHashtagParts.join(" ");

  // Handle Clear All Filters
  function handleClearFilters() {
    // Clear search
    actions.setState({ search: "" });

    // Clear filter switches
    actions.display_hidden_projects(false);
    // Clear hashtags for current filter state
    if (selected_hashtags && selected_hashtags_for_filter.length > 0) {
      actions.setState({
        selected_hashtags: selected_hashtags.set(filter, Set()),
      });
    }

    // Clear collaborator filter
    onClearCollaboratorFilter?.();
  }

  const selectedPlan: LeaveOrDeleteProjectsPlan = useMemo(() => {
    const plan: LeaveOrDeleteProjectsPlan = {
      deleteIds: [],
      transferIds: [],
      leaveIds: [],
      skippedIds: [],
      actionableIds: [],
    };
    for (const project_id of selected_project_ids) {
      const project = project_map?.get(project_id);
      if (!project || project.getIn(["state", "state"]) === "deleting") {
        plan.skippedIds.push(project_id);
        continue;
      }
      const group = project.getIn(["users", account_id, "group"]);
      if (group === "owner") {
        let collaboratorCount = 0;
        project.get("users")?.forEach((info) => {
          if (info?.get?.("group") === "collaborator") {
            collaboratorCount += 1;
          }
        });
        if (collaboratorCount > 0) {
          plan.transferIds.push(project_id);
        } else {
          plan.deleteIds.push(project_id);
        }
        plan.actionableIds.push(project_id);
      } else if (group === "collaborator") {
        plan.leaveIds.push(project_id);
        plan.actionableIds.push(project_id);
      } else {
        plan.skippedIds.push(project_id);
      }
    }
    return plan;
  }, [selected_project_ids, project_map, account_id]);

  const selectedArchiveIds: string[] = useMemo(() => {
    const archiveIds: string[] = [];
    for (const project_id of selected_project_ids) {
      const project = project_map?.get(project_id);
      if (!project || !canArchiveProject(project, account_id, isAdmin)) {
        continue;
      }
      archiveIds.push(project_id);
    }
    return archiveIds;
  }, [selected_project_ids, project_map, account_id, isAdmin]);

  const selectedArchiveProjects: ArchiveProjectModalItem[] = useMemo(
    () =>
      selectedArchiveIds.map((project_id) => {
        const project = project_map?.get(project_id);
        return {
          project_id,
          title: project?.get("title"),
          state: `${project?.getIn(["state", "state"]) ?? ""}`,
          archiveAllowedByAdminOnly: archiveAllowedByAdminOnly(
            project,
            account_id,
            isAdmin,
          ),
        };
      }),
    [selectedArchiveIds, project_map, account_id, isAdmin],
  );

  function selectedTitle(project_id: string): string {
    return project_map?.get(project_id)?.get("title") ?? project_id;
  }

  function confirmSelectedHide(hide: boolean) {
    if (!account_id) return;

    Modal.confirm({
      title: `${hide ? "Hide" : "Unhide"} selected ${projectsLabelLower}`,
      content: (
        <div>
          <p>
            {hide ? "Hide" : "Unhide"} {selected_project_ids.length} selected{" "}
            {projectsLabelLower}?
          </p>
          <p style={{ fontSize: "0.9em", color: COLORS.GRAY_M }}>
            This only changes your own project list, not collaborator access.
          </p>
        </div>
      ),
      okText: hide ? "Hide" : "Unhide",
      onOk: async () => {
        for (const project_id of selected_project_ids) {
          await actions.set_project_hide(account_id, project_id, hide);
        }
      },
    });
  }

  function confirmSelectedStop() {
    const projectIds = selected_project_ids.slice();
    Modal.confirm({
      title: `Stop selected ${projectsLabelLower}`,
      content: `Stop ${projectIds.length} selected ${projectsLabelLower}?`,
      okText: "Stop",
      okButtonProps: { danger: true },
      onOk: () => {
        void stopSelectedProjects(projectIds);
      },
    });
  }

  async function stopSelectedProjects(projectIds: string[]) {
    const succeeded: string[] = [];
    const errors: Array<{ project_id: string; error: string }> = [];
    for (const project_id of projectIds) {
      try {
        await actions.stop_project(project_id);
        succeeded.push(project_id);
      } catch (err) {
        errors.push({ project_id, error: `${err}` });
      }
    }
    alert_message({
      type: errors.length > 0 ? "warning" : "success",
      message:
        errors.length > 0
          ? `Stopped ${succeeded.length} project(s); ${errors.length} failed.`
          : `Stopped ${succeeded.length} selected project(s).`,
    });
    if (errors.length > 0) {
      Modal.error({
        title: "Some projects could not be stopped",
        content: (
          <ul>
            {errors.map((result) => (
              <li key={result.project_id}>
                {selectedTitle(result.project_id)}: {result.error}
              </li>
            ))}
          </ul>
        ),
      });
    }
  }

  function openSelectedArchive() {
    const projectIds = selectedArchiveIds;
    if (projectIds.length === 0) {
      Modal.warning({
        title: `No selected ${projectsLabelLower} can be archived`,
        content:
          "Select projects where you can archive recovery data and that are not already archived or busy.",
      });
      return;
    }
    setArchiveModalOpen(true);
  }

  async function archiveSelectedProjects(projectIds: string[]) {
    const succeeded: string[] = [];
    const errors: Array<{ project_id: string; error: string }> = [];
    for (const project_id of projectIds) {
      try {
        await actions.archive_project(project_id);
        succeeded.push(project_id);
      } catch (err) {
        errors.push({ project_id, error: `${err}` });
      }
    }
    onSelectionChange(
      selected_project_ids.filter((id) => !succeeded.includes(id)),
    );
    alert_message({
      type: errors.length > 0 ? "warning" : "success",
      message:
        errors.length > 0
          ? `Archived ${succeeded.length} project(s); ${errors.length} failed.`
          : `Archived ${succeeded.length} selected project(s).`,
    });
    if (errors.length > 0) {
      Modal.error({
        title: "Some projects could not be archived",
        content: (
          <ul>
            {errors.map((result) => (
              <li key={result.project_id}>
                {selectedTitle(result.project_id)}: {result.error}
              </li>
            ))}
          </ul>
        ),
      });
    }
  }

  function confirmSelectedRemoveMyself() {
    if (!account_id) return;
    const projectIds = selectedPlan.leaveIds;
    if (projectIds.length === 0) return;
    Modal.confirm({
      title: `Remove myself from selected ${projectsLabelLower}`,
      content: (
        <div>
          <p>
            Remove yourself from {projectIds.length} selected{" "}
            {projectsLabelLower}?
          </p>
          <p>
            <strong>You will no longer have access.</strong>
          </p>
          {selectedPlan.deleteIds.length + selectedPlan.transferIds.length >
            0 && (
            <p style={{ color: COLORS.GRAY_M }}>
              {selectedPlan.deleteIds.length + selectedPlan.transferIds.length}{" "}
              selected {projectsLabelLower} are owned by you and will be skipped
              by this safe action.
            </p>
          )}
        </div>
      ),
      okText: "Remove Myself",
      okButtonProps: { danger: true },
      onOk: async () => {
        for (const project_id of projectIds) {
          await actions.remove_collaborator(project_id, account_id);
          actions.redux.getActions("page").close_project_tab(project_id);
        }
        onSelectionChange(
          selected_project_ids.filter((id) => !projectIds.includes(id)),
        );
      },
    });
  }

  function openLeaveOrDeleteSelected() {
    const plan = selectedPlan;
    if (plan.actionableIds.length === 0) {
      Modal.warning({
        title: "No selected projects can be changed",
        content: "Select projects where you are an owner or collaborator.",
      });
      return;
    }
    setLeaveDeleteModalOpen(true);
  }

  async function leaveOrDeleteSelected() {
    const plan = selectedPlan;
    await runFreshAuthAction(async () => {
      const results =
        await webapp_client.conat_client.hub.projects.leaveOrDeleteProjects({
          project_ids: plan.actionableIds,
          browser_id: webapp_client.browser_id,
        });
      const errors = results.filter((result) => result.action === "error");
      const succeeded = results
        .filter((result) => result.action !== "error")
        .map((result) => result.project_id);
      for (const project_id of succeeded) {
        actions.redux.getActions("page").close_project_tab(project_id);
      }
      onSelectionChange(
        selected_project_ids.filter((id) => !succeeded.includes(id)),
      );
      setLeaveDeleteModalOpen(false);
      alert_message({
        type: errors.length > 0 ? "warning" : "success",
        message:
          errors.length > 0
            ? `Processed ${succeeded.length} project(s); ${errors.length} failed.`
            : `Processed ${succeeded.length} selected project(s).`,
      });
      if (errors.length > 0) {
        Modal.error({
          title: "Some projects could not be processed",
          content: (
            <ul>
              {errors.map((result) => (
                <li key={result.project_id}>
                  {selectedTitle(result.project_id)}: {result.error}
                </li>
              ))}
            </ul>
          ),
        });
      }
    });
  }

  return (
    <>
      {isFiltered && (
        <Alert
          type={visible_projects.length === 0 ? "warning" : "info"}
          showIcon
          message={
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "16px",
              }}
            >
              <div>
                <FormattedMessage
                  id="projects.operations.status"
                  defaultMessage={`Showing {count, plural, one {# {projectLabel}} other {# {projectsLabel}}}{filterText, select, empty {} other { ({filterText})}}{searchHashtagText, select, empty {} other { matching {searchHashtagText}}}`}
                  values={{
                    count: visible_projects.length,
                    filterText: filterText || "empty",
                    searchHashtagText: searchHashtagText || "empty",
                    projectLabel: projectLabelLower,
                    projectsLabel: projectsLabelLower,
                  }}
                />
              </div>
              <Button
                size="small"
                type={visible_projects.length === 0 ? "primary" : undefined}
                icon={<Icon name="user-times" />}
                onClick={handleClearFilters}
              >
                <FormattedMessage
                  id="projects.operations.clear-filter"
                  defaultMessage="Clear Filter"
                />
              </Button>
            </div>
          }
        />
      )}
      {selected_project_ids.length > 0 && (
        <div
          style={{
            position: "fixed",
            left: "50%",
            bottom: 24,
            transform: "translateX(-50%)",
            zIndex: 1000,
            maxWidth: "calc(100vw - 32px)",
            background: "white",
            border: `1px solid ${COLORS.GRAY_LL}`,
            borderRadius: 999,
            boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
            padding: "8px 10px",
          }}
        >
          <Space wrap size="small">
            <Text strong style={{ padding: "0 8px", whiteSpace: "nowrap" }}>
              {selected_project_ids.length} selected
            </Text>
            <Button size="small" onClick={() => onSelectionChange([])}>
              Clear
            </Button>
            <Button
              size="small"
              icon={<Icon name="stop" />}
              onClick={confirmSelectedStop}
            >
              Stop
            </Button>
            <Button
              size="small"
              icon={<Icon name="file-archive" />}
              disabled={selectedArchiveIds.length === 0}
              onClick={openSelectedArchive}
            >
              Archive...
            </Button>
            <Button
              size="small"
              icon={<Icon name="eye-slash" />}
              onClick={() => confirmSelectedHide(true)}
            >
              Hide
            </Button>
            <Button
              size="small"
              icon={<Icon name="eye" />}
              onClick={() => confirmSelectedHide(false)}
            >
              Unhide
            </Button>
            <Button
              size="small"
              icon={<Icon name="user-times" />}
              disabled={selectedPlan.leaveIds.length === 0}
              onClick={confirmSelectedRemoveMyself}
            >
              Remove Myself
            </Button>
            <Button
              size="small"
              danger
              icon={<Icon name="trash" />}
              onClick={openLeaveOrDeleteSelected}
            >
              Leave or Delete...
            </Button>
          </Space>
        </div>
      )}
      <LeaveOrDeleteProjectsModal
        open={leaveDeleteModalOpen}
        plan={selectedPlan}
        projectsLabelLower={projectsLabelLower}
        projectTitle={selectedTitle}
        onCancel={() => setLeaveDeleteModalOpen(false)}
        onConfirm={leaveOrDeleteSelected}
      />
      <ArchiveProjectModal
        open={archiveModalOpen}
        projects={selectedArchiveProjects}
        skippedCount={selected_project_ids.length - selectedArchiveIds.length}
        onCancel={() => setArchiveModalOpen(false)}
        onArchive={archiveSelectedProjects}
      />
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}

function canArchiveProject(
  project: any,
  account_id: string | undefined,
  isAdmin: boolean,
): boolean {
  const state = `${project.getIn?.(["state", "state"]) ?? ""}`;
  if (
    !state ||
    [
      "starting",
      "stopping",
      "archiving",
      "unarchiving",
      "archived",
      "deleting",
    ].includes(state)
  ) {
    return false;
  }
  const group = account_id
    ? `${project.getIn?.(["users", account_id, "group"]) ?? ""}`
    : "";
  return (
    isAdmin ||
    group === "owner" ||
    project.get?.("allow_collaborator_destructive_storage_actions") === true
  );
}

function archiveAllowedByAdminOnly(
  project: any,
  account_id: string | undefined,
  isAdmin: boolean,
): boolean {
  if (!isAdmin) {
    return false;
  }
  const group = account_id
    ? `${project.getIn?.(["users", account_id, "group"]) ?? ""}`
    : "";
  return (
    group !== "owner" &&
    project.get?.("allow_collaborator_destructive_storage_actions") !== true
  );
}
