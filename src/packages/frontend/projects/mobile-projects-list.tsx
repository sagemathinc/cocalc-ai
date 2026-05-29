/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Checkbox, Space, Tag, Typography } from "antd";
import { useIntl } from "react-intl";

import { useActions } from "@cocalc/frontend/app-framework";
import { Icon, ProjectState, TimeAgo } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { COLORS } from "@cocalc/util/theme";

import { CollaboratorsAvatars } from "./collaborators-avatars";
import { ProjectActionsMenu } from "./projects-actions-menu";
import type { ProjectTableRecord } from "./projects-table-columns";
import { ProjectThemeAvatar } from "./theme";
import { useBookmarkedProjects } from "./use-bookmarked-projects";
import { useProjectTableRecords } from "./use-project-table-records";

interface Props {
  visible_projects: string[];
  selectedProjectIds: string[];
  onSelectedProjectIdsChange: (project_ids: string[]) => void;
}

const { Text } = Typography;

function roleTag(role: ProjectTableRecord["currentRole"]) {
  switch (role) {
    case "owner":
      return (
        <Tag color="blue" style={{ marginInlineEnd: 0 }}>
          Owner
        </Tag>
      );
    case "collaborator":
      return <Tag style={{ marginInlineEnd: 0 }}>Collaborator</Tag>;
    case "viewer":
      return (
        <Tag color="gold" style={{ marginInlineEnd: 0 }}>
          Viewer
        </Tag>
      );
    default:
      return null;
  }
}

function stateTags(record: ProjectTableRecord) {
  const archived = record.state?.get("state") === "archived";
  const deleteFailed =
    record.deleteFailed === true && record.deletionScheduled !== true;
  return (
    <>
      {record.deletionScheduled && (
        <Tag color="orange" style={{ marginInlineEnd: 0 }}>
          Scheduled for deletion
        </Tag>
      )}
      {archived && (
        <Tag color="purple" style={{ marginInlineEnd: 0 }}>
          Archived
        </Tag>
      )}
      {record.deleting && (
        <Tag color="orange" style={{ marginInlineEnd: 0 }}>
          Deleting
        </Tag>
      )}
      {deleteFailed && (
        <Tag color="red" style={{ marginInlineEnd: 0 }}>
          Deletion failed
        </Tag>
      )}
    </>
  );
}

export function MobileProjectsList({
  visible_projects,
  selectedProjectIds,
  onSelectedProjectIdsChange,
}: Props) {
  const intl = useIntl();
  const actions = useActions("projects");
  const projectLabel = intl.formatMessage(labels.project);
  const records = useProjectTableRecords({ visible_projects, projectLabel });
  const { isProjectBookmarked, setProjectBookmarked } = useBookmarkedProjects();
  const selectedProjectIdSet = new Set(selectedProjectIds);

  function openProject(record: ProjectTableRecord, e?: React.MouseEvent) {
    if (record.deletionBlocked) return;
    actions.open_project({
      project_id: record.project_id,
      target: "project-home",
      switch_to: !(e?.button === 1 || e?.ctrlKey || e?.metaKey),
    });
  }

  function toggleSelection(project_id: string, checked: boolean) {
    if (checked) {
      onSelectedProjectIdsChange([...selectedProjectIds, project_id]);
    } else {
      onSelectedProjectIdsChange(
        selectedProjectIds.filter((id) => id !== project_id),
      );
    }
  }

  function toggleStar(project_id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setProjectBookmarked(project_id, !isProjectBookmarked(project_id));
  }

  if (records.length === 0) {
    return (
      <div
        style={{
          padding: "24px 12px",
          textAlign: "center",
          color: COLORS.GRAY,
        }}
      >
        No projects
      </div>
    );
  }

  return (
    <div
      data-cocalc-mobile-projects-list
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        width: "100%",
      }}
    >
      {records.map((record) => {
        const selected = selectedProjectIdSet.has(record.project_id);
        const selectionDisabled =
          record.deleting === true || record.deletionScheduled === true;
        return (
          <div
            key={record.project_id}
            data-cocalc-mobile-project-card
            onClick={(e) => openProject(record, e)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                openProject(record, e);
              }
            }}
            style={{
              background: "white",
              border: `1px solid ${COLORS.GRAY_LL}`,
              borderLeft: `5px solid ${record.color ?? "transparent"}`,
              borderRadius: "6px",
              cursor: record.deletionBlocked ? "not-allowed" : "pointer",
              opacity: record.deletionBlocked ? 0.72 : undefined,
              padding: "10px",
              width: "100%",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "24px 44px minmax(0, 1fr) 36px",
                gap: "8px",
                alignItems: "start",
              }}
            >
              <Checkbox
                checked={selected}
                disabled={selectionDisabled}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) =>
                  toggleSelection(record.project_id, e.target.checked)
                }
                style={{ paddingTop: "10px" }}
                aria-label={`Select ${record.title}`}
              />
              <ProjectThemeAvatar theme={record.theme} size={40} border />
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    minWidth: 0,
                  }}
                >
                  <Text
                    strong={record.state?.get("state") === "running"}
                    disabled={record.deleting || record.deletionScheduled}
                    ellipsis
                    style={{ minWidth: 0 }}
                  >
                    {record.title || "Untitled"}
                  </Text>
                </div>
                {record.description && !record.deleteFailed && (
                  <Text
                    type="secondary"
                    ellipsis
                    style={{
                      display: "block",
                      fontSize: "12px",
                      marginTop: "2px",
                    }}
                  >
                    {record.description}
                  </Text>
                )}
                <Space
                  wrap
                  size={[6, 4]}
                  style={{ marginTop: "6px", rowGap: "4px" }}
                >
                  {roleTag(record.currentRole)}
                  {stateTags(record)}
                  <ProjectState state={record.state} />
                </Space>
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                <ProjectActionsMenu
                  record={record}
                  onToggleDetails={() =>
                    actions.toggle_expanded_project(record.project_id)
                  }
                />
              </div>
            </div>
            <div
              style={{
                borderTop: `1px solid ${COLORS.GRAY_LL}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                marginTop: "10px",
                paddingTop: "8px",
              }}
            >
              <Space size={8} style={{ minWidth: 0 }}>
                <Button
                  type="text"
                  size="small"
                  aria-label={
                    record.starred
                      ? `Unstar ${record.title}`
                      : `Star ${record.title}`
                  }
                  icon={
                    <Icon
                      name={record.starred ? "star-filled" : "star"}
                      style={{
                        color: record.starred ? COLORS.STAR : COLORS.GRAY,
                      }}
                    />
                  }
                  onClick={(e) => toggleStar(record.project_id, e)}
                />
                {record.last_edited && (
                  <Text type="secondary" style={{ fontSize: "12px" }}>
                    <TimeAgo date={record.last_edited} />
                  </Text>
                )}
              </Space>
              {record.collaborators.length > 0 && (
                <CollaboratorsAvatars
                  collaboratorIds={record.collaborators}
                  size={22}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
