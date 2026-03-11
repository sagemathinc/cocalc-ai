/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Button,
  Card,
  Empty,
  Input,
  Popover,
  Popconfirm,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useMemo, useState } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  Icon,
  ThemeEditorModal,
  TimeAgo,
  type IconName,
} from "@cocalc/frontend/components";
import {
  DragHandle,
  SortableItem,
  SortableList,
} from "@cocalc/frontend/components/sortable-list";
import { useProjectContext } from "@cocalc/frontend/project/context";
import {
  ensureWorkspaceChatDirectory,
  ensureWorkspaceChatPath,
} from "@cocalc/frontend/project/workspaces/runtime";
import { path_split, tab_to_path } from "@cocalc/util/misc";
import type {
  WorkspaceCreateInput,
  WorkspaceRecord,
  WorkspaceSelection,
} from "@cocalc/frontend/project/workspaces/types";
import { defaultWorkspaceTitle } from "@cocalc/frontend/project/workspaces/state";
import {
  themeDraftFromTheme,
  themeFromDraft,
  type ThemeEditorDraft,
  type ThemeImageChoice,
} from "@cocalc/frontend/theme/types";

const DEFAULT_ICON = "cube";
const DAY_MS = 24 * 60 * 60 * 1000;

type WorkspaceSectionKey = "pinned" | "today" | "last7" | "older";

type Props = {
  project_id: string;
  layout?: "flyout" | "page";
};

type WorkspacesFlyoutProps = {
  project_id: string;
  wrap: (
    content: React.JSX.Element,
    style?: React.CSSProperties,
  ) => React.JSX.Element;
};

type EditorDraft = {
  workspace_id?: string;
  root_path: string;
  theme: ThemeEditorDraft;
  pinned: boolean;
};

function iconFor(record?: WorkspaceRecord | null): IconName {
  return (record?.theme.icon?.trim() as IconName | undefined) || DEFAULT_ICON;
}

function selectionValue(selection: WorkspaceSelection): string {
  switch (selection.kind) {
    case "all":
      return "all";
    case "unscoped":
      return "unscoped";
    case "workspace":
      return `workspace:${selection.workspace_id}`;
  }
}

function makeDraft(
  record?: WorkspaceRecord | null,
  fallbackPath = "",
): EditorDraft {
  if (!record) {
    return {
      root_path: fallbackPath,
      theme: themeDraftFromTheme(
        undefined,
        fallbackPath ? defaultWorkspaceTitle(fallbackPath) : "",
      ),
      pinned: false,
    };
  }
  return {
    workspace_id: record.workspace_id,
    root_path: record.root_path,
    theme: themeDraftFromTheme(record.theme),
    pinned: record.pinned,
  };
}

async function validateRootPath(rootPath: string): Promise<string | null> {
  const trimmed = `${rootPath ?? ""}`.trim();
  if (!trimmed.startsWith("/")) {
    return "Workspace path must be absolute.";
  }
  return null;
}

function startOfToday(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function workspaceSection(
  record: WorkspaceRecord,
  now: number,
): WorkspaceSectionKey {
  if (record.pinned) return "pinned";
  const used = record.last_used_at ?? 0;
  const today = startOfToday(now);
  if (used >= today) return "today";
  if (used >= today - 6 * DAY_MS) return "last7";
  return "older";
}

function sectionTitle(section: WorkspaceSectionKey): string {
  switch (section) {
    case "pinned":
      return "Pinned";
    case "today":
      return "Today";
    case "last7":
      return "Last 7 days";
    case "older":
      return "Older";
  }
}

function moveItem<T>(
  items: readonly T[],
  oldIndex: number,
  newIndex: number,
): T[] {
  if (
    oldIndex < 0 ||
    newIndex < 0 ||
    oldIndex >= items.length ||
    newIndex >= items.length ||
    oldIndex === newIndex
  ) {
    return [...items];
  }
  const next = [...items];
  const [item] = next.splice(oldIndex, 1);
  next.splice(newIndex, 0, item);
  return next;
}

export function WorkspacesPanel({ project_id, layout = "page" }: Props) {
  const { actions, active_project_tab, workspaces } = useProjectContext();
  const account_id = `${useTypedRedux("account", "account_id") ?? ""}`.trim();
  const current_path_abs =
    useTypedRedux({ project_id }, "current_path_abs") ?? "/";
  const [editing, setEditing] = useState<EditorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [openingChatId, setOpeningChatId] = useState<string | null>(null);
  const [error, setError] = useState<string>("");
  const isFlyout = layout === "flyout";
  const now = Date.now();

  const defaultRootPath = useMemo(() => {
    const activePath = tab_to_path(active_project_tab ?? "");
    if (activePath) {
      const split = path_split(activePath);
      return split.head || "/";
    }
    return current_path_abs || "/";
  }, [active_project_tab, current_path_abs]);

  function select(next: WorkspaceSelection): void {
    workspaces.setSelection(next);
  }

  function openCreate(): void {
    const draft = makeDraft(null, defaultRootPath);
    setEditing(draft);
    setError("");
  }

  function openEdit(record: WorkspaceRecord): void {
    setEditing(makeDraft(record));
    setError("");
  }

  function patchEditing(patch: Partial<EditorDraft>): void {
    setEditing((current) => (current ? { ...current, ...patch } : current));
  }

  function patchTheme(themePatch: Partial<ThemeEditorDraft>): void {
    setEditing((current) =>
      current
        ? { ...current, theme: { ...current.theme, ...themePatch } }
        : current,
    );
  }

  async function onSave(): Promise<void> {
    if (!editing) return;
    setSaving(true);
    setError("");
    try {
      const values = editing;
      if (!values.theme.title.trim()) {
        setError("A workspace title is required.");
        return;
      }
      const validationError = await validateRootPath(values.root_path);
      if (validationError) {
        setError(validationError);
        return;
      }
      if (editing.workspace_id) {
        workspaces.updateWorkspace(editing.workspace_id, {
          root_path: values.root_path,
          theme: themeFromDraft(values.theme),
          pinned: values.pinned,
        });
      } else {
        workspaces.createWorkspace({
          root_path: values.root_path,
          ...themeFromDraft(values.theme),
          pinned: values.pinned,
          source: "manual",
        } satisfies WorkspaceCreateInput);
      }
      setEditing(null);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  async function onDeleteFromEditor(): Promise<void> {
    if (!editing?.workspace_id) return;
    setSaving(true);
    setError("");
    try {
      workspaces.deleteWorkspace(editing.workspace_id);
      setEditing(null);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  async function openWorkspaceChat(record: WorkspaceRecord): Promise<void> {
    if (!actions) return;
    setOpeningChatId(record.workspace_id);
    setError("");
    try {
      const { chat_path } = await ensureWorkspaceChatPath({
        project_id,
        account_id,
        workspace_id: record.workspace_id,
      });
      await ensureWorkspaceChatDirectory({ project_id, chat_path });
      workspaces.setSelection({
        kind: "workspace",
        workspace_id: record.workspace_id,
      });
      await actions.open_file({ path: chat_path, foreground: true });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setOpeningChatId(null);
    }
  }

  function renderRecord(record: WorkspaceRecord): React.JSX.Element {
    const selected =
      workspaces.selection.kind === "workspace" &&
      workspaces.selection.workspace_id === record.workspace_id;
    const imageUrl = record.theme.image_blob?.trim()
      ? `/blobs/theme-image.png?uuid=${encodeURIComponent(record.theme.image_blob.trim())}`
      : undefined;
    return (
      <Card
        key={record.workspace_id}
        size="small"
        style={{
          borderLeft: `4px solid ${record.theme.color ?? "#d9d9d9"}`,
          background: selected ? "#f6ffed" : undefined,
          cursor: "pointer",
        }}
        bodyStyle={{ padding: isFlyout ? 10 : 12 }}
        onClick={() =>
          select({
            kind: "workspace",
            workspace_id: record.workspace_id,
          })
        }
      >
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={`${record.theme.title} workspace`}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                objectFit: "cover",
                flex: "0 0 auto",
              }}
            />
          ) : (
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: record.theme.accent_color ?? "#f5f5f5",
                color: record.theme.color ?? undefined,
                flex: "0 0 auto",
              }}
            >
              <Icon name={iconFor(record)} />
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 8,
              }}
            >
              <Space size={6} wrap>
                <Typography.Text strong>{record.theme.title}</Typography.Text>
                {record.pinned ? <Tag color="gold">Pinned</Tag> : null}
                {selected ? <Tag color="green">Selected</Tag> : null}
              </Space>
              <div
                onClick={(e) => e.stopPropagation()}
                style={{ color: "#888", flex: "0 0 auto" }}
              >
                <DragHandle id={record.workspace_id} />
              </div>
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {record.root_path}
              </Typography.Text>
            </div>
            {record.theme.description ? (
              <Typography.Paragraph
                type="secondary"
                style={{ margin: "6px 0 0 0" }}
                ellipsis={{ rows: isFlyout ? 2 : 3 }}
              >
                {record.theme.description}
              </Typography.Paragraph>
            ) : null}
            <Space size={10} wrap style={{ marginTop: 8 }}>
              <Button
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  openEdit(record);
                }}
              >
                Edit
              </Button>
              <Button
                size="small"
                loading={openingChatId === record.workspace_id}
                onClick={(e) => {
                  e.stopPropagation();
                  void openWorkspaceChat(record);
                }}
              >
                Open workspace chat
              </Button>
              <Button
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  workspaces.updateWorkspace(record.workspace_id, {
                    pinned: !record.pinned,
                  });
                }}
              >
                {record.pinned ? "Unpin" : "Pin"}
              </Button>
            </Space>
            <div style={{ marginTop: 8, fontSize: 12, color: "#888" }}>
              {record.last_used_at ? (
                <>
                  Used <TimeAgo date={record.last_used_at} />
                </>
              ) : (
                "Never used"
              )}
            </div>
          </div>
        </div>
      </Card>
    );
  }

  const recentImageChoices = useMemo<ThemeImageChoice[]>(
    () =>
      workspaces.records.flatMap((record) => {
        const blob = record.theme.image_blob?.trim();
        if (!blob) return [];
        return [{ blob, label: record.theme.title } satisfies ThemeImageChoice];
      }),
    [workspaces.records],
  );
  const recordById = useMemo(
    () =>
      new Map(
        workspaces.records.map(
          (record) => [record.workspace_id, record] as const,
        ),
      ),
    [workspaces.records],
  );

  const sections = useMemo(() => {
    const grouped: Record<WorkspaceSectionKey, WorkspaceRecord[]> = {
      pinned: [],
      today: [],
      last7: [],
      older: [],
    };
    for (const record of workspaces.records) {
      grouped[workspaceSection(record, now)].push(record);
    }
    return grouped;
  }, [now, workspaces.records]);

  function reorderSection(
    section: WorkspaceSectionKey,
    oldIndex: number,
    newIndex: number,
  ): void {
    const sectionRecords = sections[section];
    if (
      oldIndex < 0 ||
      newIndex < 0 ||
      oldIndex >= sectionRecords.length ||
      newIndex >= sectionRecords.length ||
      oldIndex === newIndex
    ) {
      return;
    }
    const originalIds = sectionRecords.map(({ workspace_id }) => workspace_id);
    const reorderedIds = moveItem(originalIds, oldIndex, newIndex);
    const inSection = new Set(originalIds);
    let i = 0;
    const nextOrder = workspaces.records.map(({ workspace_id }) =>
      inSection.has(workspace_id) ? reorderedIds[i++] : workspace_id,
    );
    workspaces.reorderWorkspaces(nextOrder);
  }

  const body = (
    <div style={{ paddingRight: isFlyout ? 4 : 0 }}>
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Space wrap size={[6, 6]}>
          <Popover
            trigger="click"
            content={
              <div style={{ maxWidth: 280 }}>
                A workspace filters visible tabs by an absolute directory path
                inside this project. It does not close files or change
                permissions.
              </div>
            }
          >
            <Button size="small">?</Button>
          </Popover>
          <Tag.CheckableTag
            checked={selectionValue(workspaces.selection) === "all"}
            onChange={() => select({ kind: "all" })}
          >
            All tabs
          </Tag.CheckableTag>
          <Tag.CheckableTag
            checked={selectionValue(workspaces.selection) === "unscoped"}
            onChange={() => select({ kind: "unscoped" })}
          >
            Unscoped
          </Tag.CheckableTag>
          {workspaces.records.map((record) => (
            <Tag.CheckableTag
              key={record.workspace_id}
              checked={
                selectionValue(workspaces.selection) ===
                `workspace:${record.workspace_id}`
              }
              onChange={() =>
                select({
                  kind: "workspace",
                  workspace_id: record.workspace_id,
                })
              }
            >
              {record.theme.title}
            </Tag.CheckableTag>
          ))}
          <Tooltip title={`Suggested path: ${defaultRootPath}`}>
            <Button type="primary" onClick={openCreate}>
              New workspace
            </Button>
          </Tooltip>
        </Space>
        {workspaces.loading ? (
          <div style={{ padding: "24px 0", textAlign: "center" }}>
            <Spin tip="Loading workspaces..." />
          </div>
        ) : workspaces.records.length === 0 ? (
          <Empty
            description="No workspaces yet"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          >
            <Button type="primary" onClick={openCreate}>
              Create workspace
            </Button>
          </Empty>
        ) : (
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            {(
              ["pinned", "today", "last7", "older"] as WorkspaceSectionKey[]
            ).map((section) => {
              const sectionRecords = sections[section];
              if (sectionRecords.length === 0) return null;
              return (
                <div key={section}>
                  <Typography.Text
                    type="secondary"
                    style={{ display: "block", marginBottom: 8 }}
                  >
                    {sectionTitle(section)}
                  </Typography.Text>
                  <SortableList
                    items={sectionRecords.map(
                      ({ workspace_id }) => workspace_id,
                    )}
                    Item={({ id }: { id: string }) => {
                      const record = recordById.get(id);
                      if (!record) return null;
                      return (
                        <div
                          style={{
                            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
                            borderRadius: 8,
                          }}
                        >
                          {renderRecord(record)}
                        </div>
                      );
                    }}
                    onDragStop={(oldIndex, newIndex) =>
                      reorderSection(section, oldIndex, newIndex)
                    }
                  >
                    <Space
                      direction="vertical"
                      size={10}
                      style={{ width: "100%" }}
                    >
                      {sectionRecords.map((record) => (
                        <SortableItem
                          key={record.workspace_id}
                          id={record.workspace_id}
                        >
                          {renderRecord(record)}
                        </SortableItem>
                      ))}
                    </Space>
                  </SortableList>
                </div>
              );
            })}
          </Space>
        )}
      </Space>
      <ThemeEditorModal
        open={editing != null}
        title={editing?.workspace_id ? "Edit Workspace" : "New Workspace"}
        onCancel={() => {
          setEditing(null);
          setError("");
        }}
        value={editing?.theme ?? null}
        onChange={patchTheme}
        onSave={onSave}
        confirmLoading={saving}
        error={error}
        projectId={project_id}
        defaultIcon={DEFAULT_ICON as IconName}
        recentImageChoices={recentImageChoices}
        extraBeforeTheme={
          <div>
            <Typography.Text strong>Directory path</Typography.Text>
            <Input
              autoFocus
              value={editing?.root_path ?? ""}
              onChange={(e) => patchEditing({ root_path: e.target.value })}
            />
          </div>
        }
        extraAfterTheme={
          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            <div>
              <Typography.Text strong>Pinned</Typography.Text>
              <div style={{ marginTop: 8 }}>
                <Switch
                  checked={editing?.pinned ?? false}
                  onChange={(pinned) => patchEditing({ pinned })}
                />
              </div>
            </div>
            {editing?.workspace_id ? (
              <Popconfirm
                title="Delete this workspace?"
                description="Open tabs will stay open; this only removes the saved workspace record."
                onConfirm={() => void onDeleteFromEditor()}
              >
                <Button danger loading={saving}>
                  Delete workspace
                </Button>
              </Popconfirm>
            ) : null}
          </Space>
        }
      />
    </div>
  );

  return body;
}

export function WorkspacesFlyout({ project_id, wrap }: WorkspacesFlyoutProps) {
  return wrap(<WorkspacesPanel project_id={project_id} layout="flyout" />);
}
