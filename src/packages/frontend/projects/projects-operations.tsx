/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/**
 * Bulk operations on filtered/visible projects
 * Shows status alert with action buttons when filters are active
 */

// cSpell:ignore undoable

import { Alert, Button, Modal, Progress, Space, Table, Typography } from "antd";
import { Map, Set as ImmutableSet } from "immutable";
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
import { setProjectRootfsImage } from "@cocalc/frontend/rootfs/manifest";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";
import { COLORS } from "@cocalc/util/theme";

import {
  buildBulkRootfsUpgradePlan,
  rootfsUpgradeEntryLabel,
  type BulkRootfsUpgradePlanItem,
} from "./bulk-rootfs-upgrade";
import {
  LeaveOrDeleteProjectsModal,
  type LeaveOrDeleteProjectsPlan,
} from "./leave-or-delete-projects-modal";
import { publicShareCountFromProject } from "./public-share-labels";
import {
  runLeaveOrDeleteProjectsSequentially,
  type BulkLeaveOrDeleteProgress,
} from "./projects-bulk-delete";
import {
  beginProjectDeleteQueue,
  clearProjectDeleteQueueStatus,
  failProjectDeleteQueue,
  finishProjectDeleteQueue,
  scheduleProjectDeletes,
  setProjectDeleteQueueProgress,
  unscheduleProjectDeletes,
  useProjectDeleteQueue,
} from "./project-delete-queue";
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
  rootfsImages: RootfsImageEntry[];
  rootfsImagesLoading?: boolean;
}

const { Text } = Typography;
const BULK_PROJECT_CONTROL_CONCURRENCY = 5;
const BULK_ROOTFS_UPGRADE_CONCURRENCY = 3;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      for (;;) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function readMaybeImmutable(value: any, key: string): any {
  if (value == null) return undefined;
  if (typeof value.get === "function") return value.get(key);
  return value[key];
}

function hostStatusAllowsProjectStop(hostInfo: any): boolean {
  const status = `${readMaybeImmutable(hostInfo, "status") ?? ""}`
    .trim()
    .toLowerCase();
  const deleted = readMaybeImmutable(hostInfo, "deleted");
  if (deleted != null) return false;
  if (!status) return true;
  return status === "running" || status === "active";
}

export function shouldSendProjectStop(project: any, hostInfo?: any): boolean {
  const state = `${project?.getIn?.(["state", "state"]) ?? ""}`;
  const hostId = `${project?.get?.("host_id") ?? ""}`.trim();
  return (
    !!hostId &&
    ["pending", "running", "starting"].includes(state) &&
    hostStatusAllowsProjectStop(hostInfo)
  );
}

function shouldSendProjectStart(project: any): boolean {
  const state = `${project?.getIn?.(["state", "state"]) ?? ""}`;
  const hostId = `${project?.get?.("host_id") ?? ""}`.trim();
  return (
    !!hostId && !["deleting", "running", "starting", "stopping"].includes(state)
  );
}

export function ProjectsOperations({
  visible_projects,
  selected_project_ids,
  onSelectionChange,
  filteredCollaborators,
  onClearCollaboratorFilter,
  rootfsImages,
  rootfsImagesLoading,
}: Props) {
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectsLabel = intl.formatMessage(labels.projects);
  const projectLabelLower = projectLabel.toLowerCase();
  const projectsLabelLower = projectsLabel.toLowerCase();
  const actions = useActions("projects");
  const host_info = useTypedRedux("projects", "host_info");
  const [leaveDeleteModalOpen, setLeaveDeleteModalOpen] = useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [bulkRootfsUpgradeRunning, setBulkRootfsUpgradeRunning] =
    useState(false);
  const project_map = useTypedRedux("projects", "project_map");
  const account_id = useTypedRedux("account", "account_id");
  const isAdmin = !!useTypedRedux("account", "is_admin");
  const [bulkLeaveDeleteProgress, setBulkLeaveDeleteProgress] =
    useState<BulkLeaveOrDeleteProgress | null>(null);
  const deleteQueue = useProjectDeleteQueue();
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  const hidden = useTypedRedux("projects", "hidden");
  const search: string = useTypedRedux("projects", "search");
  const selected_hashtags: Map<string, ImmutableSet<string>> = useTypedRedux(
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
        selected_hashtags: selected_hashtags.set(filter, ImmutableSet()),
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
          publicShareCount: publicShareCountFromProject(project),
        };
      }),
    [selectedArchiveIds, project_map, account_id, isAdmin],
  );

  const selectedRootfsUpgradePlan = useMemo(
    () =>
      buildBulkRootfsUpgradePlan({
        projectIds: selected_project_ids,
        projectMap: project_map,
        rootfsImages,
      }),
    [project_map, rootfsImages, selected_project_ids],
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
        await actions.set_projects_hide(account_id, selected_project_ids, hide);
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

  function confirmSelectedStart() {
    const projectIds = selected_project_ids.slice();
    Modal.confirm({
      title: `Start selected ${projectsLabelLower}`,
      content: `Start ${projectIds.length} selected ${projectsLabelLower}?`,
      okText: "Start",
      onOk: () => {
        void startSelectedProjects(projectIds);
      },
    });
  }

  function confirmSelectedRootfsUpgrade() {
    const plan = selectedRootfsUpgradePlan;
    if (plan.length === 0) {
      Modal.warning({
        title: "No selected projects can be upgraded",
        content:
          "Select projects that show the Upgrade tag on their image row.",
      });
      return;
    }
    const runningCount = plan.filter((item) => item.restart).length;
    Modal.confirm({
      title: "Upgrade selected project images",
      width: 760,
      okText: "Upgrade",
      content: (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Text>
            Upgrade {plan.length} selected project image
            {plan.length === 1 ? "" : "s"} to the latest available version in
            the same series.
          </Text>
          {runningCount > 0 ? (
            <Text type="secondary">
              {runningCount} running project{runningCount === 1 ? "" : "s"} will
              be restarted after the image changes.
            </Text>
          ) : null}
          <Table<BulkRootfsUpgradePlanItem>
            columns={[
              {
                title: "Project",
                dataIndex: "title",
                key: "title",
                render: (title: string) => (
                  <Text ellipsis style={{ maxWidth: 220 }}>
                    {title}
                  </Text>
                ),
              },
              {
                title: "Current",
                key: "current",
                render: (_, item) => rootfsUpgradeEntryLabel(item.current),
              },
              {
                title: "Upgrade to",
                key: "next",
                render: (_, item) => (
                  <Text strong>{rootfsUpgradeEntryLabel(item.next)}</Text>
                ),
              },
              {
                title: "After upgrade",
                key: "restart",
                render: (_, item) =>
                  item.restart ? "Restart project" : "No restart needed",
              },
            ]}
            dataSource={plan}
            pagination={false}
            rowKey="project_id"
            scroll={{ y: 280 }}
            size="small"
          />
        </Space>
      ),
      onOk: () => upgradeSelectedProjectRootfs(plan),
    });
  }

  async function upgradeSelectedProjectRootfs(
    plan: BulkRootfsUpgradePlanItem[],
  ) {
    setBulkRootfsUpgradeRunning(true);
    try {
      const results = await mapWithConcurrency(
        plan,
        BULK_ROOTFS_UPGRADE_CONCURRENCY,
        async (item) => {
          try {
            await setProjectRootfsImage({
              project_id: item.project_id,
              image: item.next.image,
              image_id: item.next.id,
            });
            if (item.restart) {
              await actions.restart_project(item.project_id);
            }
            return { project_id: item.project_id, ok: true as const };
          } catch (err) {
            return {
              project_id: item.project_id,
              ok: false as const,
              error: `${err}`,
            };
          }
        },
      );
      const succeeded = results
        .filter((result) => result.ok)
        .map((result) => result.project_id);
      const errors: Array<{ project_id: string; error: string }> =
        results.flatMap((result) =>
          result.ok
            ? []
            : [{ project_id: result.project_id, error: result.error }],
        );
      if (succeeded.length > 0) {
        onSelectionChange(
          selected_project_ids.filter((id) => !succeeded.includes(id)),
        );
      }
      alert_message({
        type: errors.length > 0 ? "warning" : "success",
        message:
          errors.length > 0
            ? `Upgraded ${succeeded.length} project(s); ${errors.length} failed.`
            : `Upgraded ${succeeded.length} selected project(s).`,
      });
      if (errors.length > 0) {
        Modal.error({
          title: "Some project images could not be upgraded",
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
    } finally {
      setBulkRootfsUpgradeRunning(false);
    }
  }

  async function startSelectedProjects(projectIds: string[]) {
    const results = await mapWithConcurrency(
      projectIds,
      BULK_PROJECT_CONTROL_CONCURRENCY,
      async (project_id) => {
        const project = project_map?.get(project_id);
        if (!shouldSendProjectStart(project)) {
          return { project_id, ok: true as const, skipped: true as const };
        }
        try {
          const started = await actions.start_project(project_id);
          return {
            project_id,
            ok: true as const,
            skipped: !started,
          };
        } catch (err) {
          return { project_id, ok: false as const, error: `${err}` };
        }
      },
    );
    const succeeded = results
      .filter((result) => result.ok && !result.skipped)
      .map((result) => result.project_id);
    const skipped = results.filter((result) => result.ok && result.skipped);
    const errors: Array<{ project_id: string; error: string }> =
      results.flatMap((result) =>
        result.ok
          ? []
          : [{ project_id: result.project_id, error: result.error }],
      );
    alert_message({
      type: errors.length > 0 ? "warning" : "success",
      message:
        errors.length > 0
          ? `Started ${succeeded.length} project(s); ${errors.length} failed; ${skipped.length} skipped.`
          : `Started ${succeeded.length} selected project(s); ${skipped.length} skipped.`,
    });
    if (errors.length > 0) {
      Modal.error({
        title: "Some projects could not be started",
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

  async function stopSelectedProjects(projectIds: string[]) {
    const results = await mapWithConcurrency(
      projectIds,
      BULK_PROJECT_CONTROL_CONCURRENCY,
      async (project_id) => {
        const project = project_map?.get(project_id);
        const hostId = project?.get?.("host_id");
        const hostInfo = hostId ? host_info?.get(hostId) : undefined;
        if (!shouldSendProjectStop(project, hostInfo)) {
          return { project_id, ok: true as const, skipped: true as const };
        }
        try {
          await actions.stop_project(project_id);
          return { project_id, ok: true as const };
        } catch (err) {
          return { project_id, ok: false as const, error: `${err}` };
        }
      },
    );
    const succeeded = results
      .filter((result) => result.ok)
      .map((result) => result.project_id);
    const errors: Array<{ project_id: string; error: string }> =
      results.flatMap((result) =>
        result.ok
          ? []
          : [{ project_id: result.project_id, error: result.error }],
      );
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
    setBulkLeaveDeleteProgress(null);
    setLeaveDeleteModalOpen(true);
  }

  async function leaveOrDeleteSelected() {
    const plan = selectedPlan;
    const started = await runFreshAuthAction(async () => {
      await webapp_client.conat_client.hub.projects.leaveOrDeleteProjects({
        project_ids: [],
        browser_id: webapp_client.browser_id,
      });
      setLeaveDeleteModalOpen(false);
      setBulkLeaveDeleteProgress(null);
      beginProjectDeleteQueue();
      scheduleProjectDeletes(plan.deleteIds);
      onSelectionChange(
        selected_project_ids.filter((id) => !plan.actionableIds.includes(id)),
      );
      void runLeaveOrDeleteProjectsInBackground(plan);
    });
    if (!started) {
      setBulkLeaveDeleteProgress(null);
    }
  }

  async function runLeaveOrDeleteProjectsInBackground(
    plan: LeaveOrDeleteProjectsPlan,
  ) {
    try {
      const { results, stopped } = await runLeaveOrDeleteProjectsSequentially({
        project_ids: plan.actionableIds,
        onProgress: (progress) => {
          setBulkLeaveDeleteProgress(progress);
          setProjectDeleteQueueProgress(progress);
        },
        submitProject: async (project_id) =>
          await webapp_client.conat_client.hub.projects.leaveOrDeleteProjects({
            project_ids: [project_id],
            browser_id: webapp_client.browser_id,
          }),
        waitForQueuedDelete: waitForHardDeleteToLeaveActiveSet,
      });
      finishProjectDeleteQueue({
        results,
        stopped,
        total: plan.actionableIds.length,
      });
      const errors = results.filter((result) => result.action === "error");
      unscheduleProjectDeletes(
        errors
          .map((result) => result.project_id)
          .filter((project_id) => plan.deleteIds.includes(project_id)),
      );
      const succeeded = results
        .filter((result) => result.action !== "error")
        .map((result) => result.project_id);
      for (const project_id of succeeded) {
        actions.redux.getActions("page").close_project_tab(project_id);
      }
      alert_message({
        type: errors.length > 0 ? "warning" : "success",
        message: stopped
          ? `Processed ${succeeded.length} project(s); stopped before queuing the remaining project delete(s).`
          : errors.length > 0
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
    } catch (err) {
      unscheduleProjectDeletes(plan.deleteIds);
      failProjectDeleteQueue({
        project_ids: plan.actionableIds,
        error: `${err}`,
      });
      Modal.error({
        title: "Unable to leave or delete projects",
        content: `${err}`,
      });
    } finally {
      setBulkLeaveDeleteProgress(null);
    }
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
      <BulkProjectDeleteStatus
        queue={deleteQueue}
        projectTitle={selectedTitle}
      />
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
              icon={<Icon name="play" />}
              onClick={confirmSelectedStart}
            >
              Start
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
              icon={<Icon name="arrow-circle-up" />}
              disabled={
                rootfsImagesLoading || selectedRootfsUpgradePlan.length === 0
              }
              loading={bulkRootfsUpgradeRunning}
              onClick={confirmSelectedRootfsUpgrade}
            >
              Upgrade
            </Button>
            <Button
              size="small"
              icon={<Icon name="file-archive" />}
              disabled={selectedArchiveIds.length === 0}
              onClick={openSelectedArchive}
            >
              Archive...
            </Button>
            {hidden ? (
              <Button
                size="small"
                icon={<Icon name="eye" />}
                onClick={() => confirmSelectedHide(false)}
              >
                Unhide
              </Button>
            ) : (
              <Button
                size="small"
                icon={<Icon name="eye-slash" />}
                onClick={() => confirmSelectedHide(true)}
              >
                Hide
              </Button>
            )}
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
        progress={bulkLeaveDeleteProgress}
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

function BulkProjectDeleteStatus({
  queue,
  projectTitle,
}: {
  queue: ReturnType<typeof useProjectDeleteQueue>;
  projectTitle: (project_id: string) => string;
}) {
  if (queue.status === "idle") {
    return null;
  }

  if (queue.status === "running") {
    const progress = queue.progress;
    const completed = progress ? progress.completed + progress.failed : 0;
    const total = progress?.total ?? queue.scheduledDeleteProjectIds.length;
    const percent =
      total > 0 ? Math.max(0, Math.min(100, (completed / total) * 100)) : 0;
    const currentProject =
      progress?.project_id != null ? projectTitle(progress.project_id) : null;

    return (
      <Alert
        type="info"
        showIcon
        style={{ marginTop: 8 }}
        message="Bulk project delete is running"
        description={
          <Space direction="vertical" size={4} style={{ width: "100%" }}>
            <Text>
              {progress
                ? `${completed} of ${progress.total} processed${
                    currentProject
                      ? `; ${
                          progress.phase === "waiting"
                            ? "waiting for"
                            : "submitting"
                        } ${currentProject}`
                      : ""
                  }.`
                : "Preparing delete queue."}
            </Text>
            <Progress percent={Math.round(percent)} size="small" />
            <Text type="secondary">
              This browser tab is driving the queue. Closing or refreshing the
              page stops further deletes; already submitted deletes continue on
              the server.
            </Text>
          </Space>
        }
      />
    );
  }

  const summary = queue.summary;
  const failed = summary?.failed ?? 0;
  const succeeded = summary?.succeeded ?? 0;
  const unprocessed = summary?.unprocessed ?? 0;
  const total = summary?.total ?? succeeded + failed;
  const alertType =
    queue.status === "error" || unprocessed > 0
      ? "error"
      : failed > 0
        ? "warning"
        : "success";

  return (
    <Alert
      type={alertType}
      showIcon
      closable
      style={{ marginTop: 8 }}
      onClose={() => clearProjectDeleteQueueStatus()}
      message={
        failed > 0 || unprocessed > 0
          ? `Bulk project delete finished with ${failed + unprocessed} issue(s)`
          : "Bulk project delete finished"
      }
      description={
        <Space direction="vertical" size={4}>
          <Text>
            {succeeded} of {total} project(s) succeeded
            {failed > 0 ? `; ${failed} failed` : ""}
            {unprocessed > 0 ? `; ${unprocessed} not processed` : ""}.
            {failed > 0 || unprocessed > 0
              ? " Failed or unprocessed rows remain selectable so you can retry delete."
              : ""}
          </Text>
          {summary?.stopped && failed > 0 && (
            <Text type="secondary">
              The queue stopped after a blocking failure; retry failed rows once
              the issue is resolved.
            </Text>
          )}
          {summary?.errors.slice(0, 3).map((error) => (
            <Text key={error.project_id} type="danger">
              {projectTitle(error.project_id)}: {error.error}
            </Text>
          ))}
          {(summary?.errors.length ?? 0) > 3 && (
            <Text type="secondary">
              {summary!.errors.length - 3} more failure(s) are shown on their
              project rows.
            </Text>
          )}
        </Space>
      }
    />
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

const HARD_DELETE_ACTIVE_STATUSES = new Set(["queued", "running"]);
const HARD_DELETE_POLL_MS = 1500;
const HARD_DELETE_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

async function waitForHardDeleteToLeaveActiveSet({
  project_id,
  op_id,
}: {
  project_id: string;
  op_id: string;
}): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < HARD_DELETE_WAIT_TIMEOUT_MS) {
    const summary = await webapp_client.conat_client.hub.lro.get({ op_id });
    if (summary && !HARD_DELETE_ACTIVE_STATUSES.has(summary.status)) {
      if (summary.status === "succeeded") {
        return;
      }
      throw new Error(
        summary.error ??
          `Project delete ${op_id} for ${project_id} finished with status ${summary.status}`,
      );
    }
    await delay(HARD_DELETE_POLL_MS);
  }
  throw new Error(
    `Timed out waiting for project delete ${op_id} for ${project_id} to leave queued/running state.`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
