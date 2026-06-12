/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/**
 * Projects Table - Main table component for projects listing
 *
 * Uses Ant Design Table with virtual scrolling for performance.
 * Features:
 * - Sortable columns (star, title, last edited)
 * - Expandable rows for additional details
 * - Click-to-open functionality
 * - Project color indicators (left border)
 */

import { Table } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";

import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { labels } from "@cocalc/frontend/i18n";
import {
  get_local_storage,
  set_local_storage,
} from "@cocalc/frontend/misc/local-storage";

import { ProjectActionsMenu } from "./projects-actions-menu";
import {
  getProjectTableColumns,
  type ProjectTableRecord,
  type SortState,
} from "./projects-table-columns";
import { useBookmarkedProjects } from "./use-bookmarked-projects";
import { useProjectTableRecords } from "./use-project-table-records";

interface Props {
  visible_projects: string[];
  height?: number;
  narrow: boolean; // if narrow, then remove columns like "Collaborators" to safe space
  filteredCollaborators: string[] | null;
  onFilteredCollaboratorsChange: (collaborators: string[] | null) => void;
  selectedProjectIds: string[];
  onSelectedProjectIdsChange: (project_ids: string[]) => void;
  freezeOrder?: boolean;
}

const PROJECTS_TABLE_SORT_KEY = "projects-table-sort";

export function ProjectsTable({
  visible_projects,
  height = 600,
  narrow = false,
  filteredCollaborators,
  onFilteredCollaboratorsChange,
  selectedProjectIds,
  onSelectedProjectIdsChange,
  freezeOrder = false,
}: Props) {
  const intl = useIntl();
  const actions = useActions("projects");
  const projectLabel = intl.formatMessage(labels.project);
  const project_map = useTypedRedux("projects", "project_map");
  const user_map = useTypedRedux("users", "user_map");
  const { isProjectBookmarked, setProjectBookmarked } = useBookmarkedProjects();
  const [sortState, setSortState] = useState<SortState>({
    columnKey: "last_edited",
    order: "descend",
  }); // Default to last_edited descending

  // Load sort state from local storage on mount
  useEffect(() => {
    const savedSort = get_local_storage(PROJECTS_TABLE_SORT_KEY);
    if (savedSort && typeof savedSort === "object") {
      setSortState(savedSort as typeof sortState);
    }
  }, []);

  const tableData = useProjectTableRecords({ visible_projects, projectLabel });

  const handleToggleStar = (project_id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const isStarred = isProjectBookmarked(project_id);
    setProjectBookmarked(project_id, !isStarred);
  };

  const handleToggleExpand = (record: ProjectTableRecord) => {
    actions.toggle_expanded_project(record.project_id);
  };

  const renderActionsMenu = (record: ProjectTableRecord) => {
    return (
      <ProjectActionsMenu
        record={record}
        onToggleDetails={() => handleToggleExpand(record)}
      />
    );
  };

  // Compute all unique collaborators and their information for filtering
  const collaboratorFilters = useMemo(() => {
    if (!project_map || !user_map) return [];

    const current_account_id = actions.redux
      .getStore("account")
      .get_account_id();

    // Collect all unique collaborator account_ids
    const collaboratorIds = new Set<string>();
    visible_projects.forEach((project_id) => {
      const project = project_map.get(project_id);
      if (!project) return;

      const users = project.get("users");
      if (users) {
        users.forEach((_, account_id) => {
          if (account_id !== current_account_id) {
            collaboratorIds.add(account_id);
          }
        });
      }
    });

    // Create filter options with user information
    const filters = Array.from(collaboratorIds)
      .map((account_id) => {
        const user = user_map.get(account_id);
        if (!user) return null;

        const first_name = user.get("first_name") ?? "";
        const last_name = user.get("last_name") ?? "";
        const display_name = user.get("display_name") ?? "";
        const avatar = user.get("avatar_image_tiny");

        return {
          text:
            `${display_name}`.trim() ||
            `${first_name} ${last_name}`.trim() ||
            "Unknown User",
          value: account_id,
          first_name,
          last_name,
          display_name,
          avatar,
        };
      })
      .filter((f) => f != null);

    // Sort by last name, then first name
    filters.sort((a, b) => {
      const lastNameCmp = a!.last_name.localeCompare(b!.last_name);
      if (lastNameCmp !== 0) return lastNameCmp;
      return a!.first_name.localeCompare(b!.first_name);
    });

    return filters;
  }, [actions, visible_projects, project_map, user_map]);

  const columns = getProjectTableColumns(
    handleToggleStar,
    renderActionsMenu,
    handleOpenProject,
    sortState,
    collaboratorFilters,
    narrow,
    filteredCollaborators,
    intl,
  ).map((column) => {
    if (!freezeOrder) {
      return column;
    }
    const { sorter: _sorter, sortOrder: _sortOrder, ...rest } = column;
    return rest;
  });

  function handleOpenProject(record: ProjectTableRecord, e?: React.MouseEvent) {
    if (record.deletionBlocked) {
      return;
    }
    actions.open_project({
      project_id: record.project_id,
      target: "files/",
      switch_to: !(e?.button === 1 || e?.ctrlKey || e?.metaKey),
    });
  }

  function handleTableChange(_: any, filters: any, sorter: any) {
    // Update sort state when columnKey and order are present
    // With sortDirections on Table, it should cycle continuously without clearing
    const { columnKey, order } = sorter;
    if (columnKey && order) {
      const newSortState = { columnKey, order };
      setSortState(newSortState);
      set_local_storage(PROJECTS_TABLE_SORT_KEY, newSortState);
    }

    // Update collaborator filter state
    if (onFilteredCollaboratorsChange && filters) {
      const collaboratorsFilter = filters.collaborators;
      onFilteredCollaboratorsChange(
        collaboratorsFilter && collaboratorsFilter.length > 0
          ? collaboratorsFilter
          : null,
      );
    }
  }

  return (
    <Table<ProjectTableRecord>
      key={freezeOrder ? "frozen-order" : "sortable-order"}
      virtual
      size="small"
      columns={columns}
      dataSource={tableData}
      rowKey="project_id"
      rowSelection={{
        selectedRowKeys: selectedProjectIds,
        columnWidth: 36,
        preserveSelectedRowKeys: false,
        onChange: (keys) =>
          onSelectedProjectIdsChange(keys.map((key) => `${key}`)),
        getCheckboxProps: (record) => ({
          disabled: record.deleting || record.deletionScheduled,
        }),
      }}
      pagination={false}
      scroll={{ y: height }}
      onChange={handleTableChange}
      // this makes the table toggle between ascend/descend only, skipping the "not sorted" state
      sortDirections={["ascend", "descend", "ascend"]}
      onRow={(record) => ({
        style: {
          opacity: record.deletionBlocked ? 0.72 : undefined,
          outlineLeft: `4px solid ${record.color ?? "transparent"}`,
        },
      })}
    />
  );
}
