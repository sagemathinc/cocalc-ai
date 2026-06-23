/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useMemo } from "react";

import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";

import { normalizeProjectStateForDisplay } from "./host-operational";
import { useProjectDeleteQueue } from "./project-delete-queue";
import { projectThemeColor, projectThemeFromProject } from "./theme";
import type { ProjectTableRecord } from "./projects-table-columns";
import { useBookmarkedProjects } from "./use-bookmarked-projects";

export function useProjectTableRecords({
  visible_projects,
  projectLabel = "Project",
}: {
  visible_projects: string[];
  projectLabel?: string;
}): ProjectTableRecord[] {
  const actions = useActions("projects");
  const project_map = useTypedRedux("projects", "project_map");
  const host_info = useTypedRedux("projects", "host_info");
  const { isProjectBookmarked } = useBookmarkedProjects();
  const { scheduledDeleteProjectIds } = useProjectDeleteQueue();
  const scheduledDeleteProjectIdSet = useMemo(
    () => new Set(scheduledDeleteProjectIds),
    [scheduledDeleteProjectIds],
  );

  return useMemo(() => {
    if (!project_map) return [];

    const current_account_id = actions.redux
      .getStore("account")
      .get_account_id();

    return visible_projects.map((project_id) => {
      const project = project_map.get(project_id);
      if (!project) {
        return {
          project_id,
          starred: false,
          title: `Unknown ${projectLabel}`,
          description: "",
          last_edited: undefined,
          hidden: false,
          collaborators: [],
        };
      }

      const users = project.get("users");
      const collaborators: string[] = [];
      if (users) {
        users.forEach((_, account_id) => {
          if (account_id !== current_account_id) {
            collaborators.push(account_id);
          }
        });
      }

      const hostId = project.get("host_id") as string | undefined;
      const hostInfo = hostId ? host_info?.get(hostId) : undefined;
      const rawState = project.get("state");
      const displayState = normalizeProjectStateForDisplay({
        projectState: rawState?.get?.("state"),
        hostId,
        hostInfo,
      });
      const state =
        displayState && rawState?.get?.("state") !== displayState
          ? rawState.set("state", displayState)
          : rawState;
      const stateName = `${state?.get?.("state") ?? ""}`;
      const currentRole = `${
        project.getIn(["users", current_account_id, "group"]) ?? ""
      }`;
      const deletionScheduled =
        scheduledDeleteProjectIdSet.has(project_id) && stateName !== "deleting";

      return {
        project_id,
        starred: isProjectBookmarked(project_id),
        theme: projectThemeFromProject(project),
        title: project.get("title") ?? "Untitled",
        description: project.get("description") ?? "",
        labels: project.get("labels")?.toJS?.() ?? project.get("labels") ?? {},
        rootfs_image_id: project.get("rootfs_image_id") ?? "",
        host: (() => {
          const hostName = hostInfo?.get?.("name");
          return typeof hostName === "string" ? hostName : undefined;
        })(),
        last_edited: project.get("last_edited"),
        currentRole:
          currentRole === "owner" ||
          currentRole === "collaborator" ||
          currentRole === "viewer"
            ? currentRole
            : undefined,
        color: projectThemeColor(project),
        state,
        deleting: stateName === "deleting",
        deletionScheduled,
        deleteFailed: stateName === "delete_failed",
        deleteError: state?.get?.("hard_delete_error"),
        deletionBlocked:
          deletionScheduled ||
          stateName === "deleting" ||
          stateName === "delete_failed",
        hidden: !!project.getIn(["users", current_account_id, "hide"]),
        collaborators,
      };
    });
  }, [
    actions,
    host_info,
    isProjectBookmarked,
    projectLabel,
    project_map,
    scheduledDeleteProjectIdSet,
    visible_projects,
  ]);
}
