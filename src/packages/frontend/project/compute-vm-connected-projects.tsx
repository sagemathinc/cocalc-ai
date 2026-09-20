/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Button, Checkbox, Flex, Popover, Space, Tag, Typography } from "antd";

import { Icon, TimeAgo } from "@cocalc/frontend/components";
import type { ProjectMap } from "@cocalc/frontend/todo-types";

const { Text } = Typography;

export interface VmConnectedProject {
  project_id: string;
  title: string;
  course: boolean;
  last_active?: Date;
}

function dateValue(value: unknown): number {
  const date = value instanceof Date ? value : new Date(`${value ?? ""}`);
  const timestamp = date.valueOf();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function vmConnectedProjects(
  projectMap: ProjectMap | undefined,
  accountId: string | undefined,
): VmConnectedProject[] {
  if (!projectMap || !accountId) return [];
  const projects: VmConnectedProject[] = [];
  for (const [project_id, project] of projectMap) {
    const group = project.getIn(["users", accountId, "group"]);
    if (
      (group !== "owner" && group !== "collaborator") ||
      project.get("deleted")
    ) {
      continue;
    }
    const lastActive =
      project.getIn(["last_active", accountId]) ?? project.get("last_edited");
    projects.push({
      project_id,
      title: `${project.get("title") || "Untitled project"}`,
      course: project.get("course") != null,
      last_active: dateValue(lastActive) ? new Date(lastActive) : undefined,
    });
  }
  return projects.sort((a, b) => {
    const activity = dateValue(b.last_active) - dateValue(a.last_active);
    if (activity !== 0) return activity;
    return (
      a.title.localeCompare(b.title) || a.project_id.localeCompare(b.project_id)
    );
  });
}

export function defaultCourseConnectedProjectIds(
  projects: VmConnectedProject[],
): string[] {
  return projects
    .filter(({ course }) => course)
    .map(({ project_id }) => project_id);
}

export function ConnectedProjectsSelect({
  projects,
  value = [],
  onChange,
  disabled,
  id,
}: {
  projects: VmConnectedProject[];
  value?: string[];
  onChange?: (projectIds: string[]) => void;
  disabled?: boolean;
  id?: string;
}) {
  const selected = new Set(value);
  const setSelected = (projectId: string, checked: boolean) => {
    const next = new Set(value);
    if (checked) next.add(projectId);
    else next.delete(projectId);
    onChange?.(
      projects.map(({ project_id }) => project_id).filter((id) => next.has(id)),
    );
  };
  const count = projects.filter(({ project_id }) =>
    selected.has(project_id),
  ).length;

  return (
    <Popover
      trigger="click"
      placement="bottomLeft"
      title="Projects connected to this VM"
      content={
        <div style={{ width: "min(440px, calc(100vw - 56px))" }}>
          <Flex justify="space-between" align="center" gap={12}>
            <Text type="secondary">
              Selected projects can connect over managed SSH after the VM
              starts.
            </Text>
            <Button
              size="small"
              disabled={disabled || count === 0}
              onClick={() => onChange?.([])}
            >
              Unselect all
            </Button>
          </Flex>
          <Space
            direction="vertical"
            size={4}
            style={{
              marginTop: 12,
              maxHeight: "min(420px, calc(100vh - 220px))",
              overflowY: "auto",
              width: "100%",
            }}
          >
            {projects.map((project) => (
              <Checkbox
                key={project.project_id}
                checked={selected.has(project.project_id)}
                disabled={disabled}
                onChange={(event) =>
                  setSelected(project.project_id, event.target.checked)
                }
                style={{ width: "100%" }}
              >
                <Space size={6} wrap>
                  <Text>{project.title}</Text>
                  {project.course && <Tag color="blue">Course</Tag>}
                  {project.last_active && (
                    <Text type="secondary">
                      active <TimeAgo date={project.last_active} />
                    </Text>
                  )}
                </Space>
              </Checkbox>
            ))}
            {!projects.length && (
              <Text type="secondary">
                No projects with collaborator access are available.
              </Text>
            )}
          </Space>
        </div>
      }
    >
      <Button
        id={id}
        disabled={disabled}
        icon={<Icon name="project-outlined" />}
      >
        {count} Connected {count === 1 ? "Project" : "Projects"}...
      </Button>
    </Popover>
  );
}
