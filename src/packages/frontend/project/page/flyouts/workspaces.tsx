/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useMemo, useState } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { ColorPicker } from "@cocalc/frontend/colorpicker";
import { Icon, TimeAgo, type IconName } from "@cocalc/frontend/components";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { path_split, tab_to_path } from "@cocalc/util/misc";
import type {
  WorkspaceCreateInput,
  WorkspaceRecord,
  WorkspaceSelection,
} from "@cocalc/frontend/project/workspaces/types";
import { defaultWorkspaceTitle } from "@cocalc/frontend/project/workspaces/state";

const DEFAULT_ICON = "folder-open";

type Props = {
  project_id: string;
  layout?: "flyout" | "page";
};

type WorkspacesFlyoutProps = {
  project_id: string;
  wrap: (content: React.JSX.Element, style?: React.CSSProperties) => React.JSX.Element;
};

type EditorDraft = {
  workspace_id?: string;
  root_path: string;
  title: string;
  description: string;
  color: string | null;
  accent_color: string | null;
  icon: string;
  image_blob: string;
  pinned: boolean;
  chat_path: string;
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

function valueToSelection(value: string): WorkspaceSelection {
  if (value === "all") return { kind: "all" };
  if (value === "unscoped") return { kind: "unscoped" };
  if (value.startsWith("workspace:")) {
    return { kind: "workspace", workspace_id: value.slice("workspace:".length) };
  }
  return { kind: "all" };
}

function makeDraft(record?: WorkspaceRecord | null, fallbackPath = ""): EditorDraft {
  if (!record) {
    return {
      root_path: fallbackPath,
      title: fallbackPath ? defaultWorkspaceTitle(fallbackPath) : "",
      description: "",
      color: null,
      accent_color: null,
      icon: "",
      image_blob: "",
      pinned: false,
      chat_path: "",
    };
  }
  return {
    workspace_id: record.workspace_id,
    root_path: record.root_path,
    title: record.theme.title,
    description: record.theme.description,
    color: record.theme.color,
    accent_color: record.theme.accent_color,
    icon: record.theme.icon ?? "",
    image_blob: record.theme.image_blob ?? "",
    pinned: record.pinned,
    chat_path: record.chat_path ?? "",
  };
}

async function validateRootPath(rootPath: string): Promise<string | null> {
  const trimmed = `${rootPath ?? ""}`.trim();
  if (!trimmed.startsWith("/")) {
    return "Workspace path must be absolute.";
  }
  return null;
}

export function WorkspacesPanel({ project_id, layout = "page" }: Props) {
  const { active_project_tab, workspaces } = useProjectContext();
  const current_path_abs = useTypedRedux({ project_id }, "current_path_abs") ?? "/";
  const [editing, setEditing] = useState<EditorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>("");
  const isFlyout = layout === "flyout";

  const defaultRootPath = useMemo(() => {
    const activePath = tab_to_path(active_project_tab ?? "");
    if (activePath) {
      const split = path_split(activePath);
      return split.head || "/";
    }
    return current_path_abs || "/";
  }, [active_project_tab, current_path_abs]);

  const selectionItems = useMemo(() => {
    const items = [
      { label: "All tabs", value: "all" },
      { label: "Unscoped", value: "unscoped" },
      ...workspaces.records.map((record) => ({
        label: record.theme.title,
        value: `workspace:${record.workspace_id}`,
      })),
    ];
    return items;
  }, [workspaces.records]);

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

  async function onSave(): Promise<void> {
    if (!editing) return;
    setSaving(true);
    setError("");
    try {
      const values = editing;
      if (!values.title.trim()) {
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
          theme: {
            title: values.title,
            description: values.description,
            color: values.color,
            accent_color: values.accent_color,
            icon: values.icon.trim() || null,
            image_blob: values.image_blob.trim() || null,
          },
          pinned: values.pinned,
          chat_path: values.chat_path.trim() || null,
        });
      } else {
        workspaces.createWorkspace({
          root_path: values.root_path,
          title: values.title,
          description: values.description,
          color: values.color,
          accent_color: values.accent_color,
          icon: values.icon.trim() || null,
          image_blob: values.image_blob.trim() || null,
          pinned: values.pinned,
          chat_path: values.chat_path.trim() || null,
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

  function renderRecord(record: WorkspaceRecord): React.JSX.Element {
    const selected =
      workspaces.selection.kind === "workspace" &&
      workspaces.selection.workspace_id === record.workspace_id;
    return (
      <Card
        key={record.workspace_id}
        size="small"
        style={{
          borderLeft: `4px solid ${record.theme.color ?? "#d9d9d9"}`,
          background: selected ? "#f6ffed" : undefined,
        }}
        bodyStyle={{ padding: isFlyout ? 10 : 12 }}
      >
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
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
          <div style={{ flex: 1, minWidth: 0 }}>
            <Space size={6} wrap>
              <Typography.Text strong>{record.theme.title}</Typography.Text>
              {record.pinned ? <Tag color="gold">Pinned</Tag> : null}
              {selected ? <Tag color="green">Selected</Tag> : null}
            </Space>
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
                type={selected ? "primary" : "default"}
                onClick={() => {
                  workspaces.setSelection({
                    kind: "workspace",
                    workspace_id: record.workspace_id,
                  });
                  workspaces.touchWorkspace(record.workspace_id);
                }}
              >
                Show tabs
              </Button>
              <Button size="small" onClick={() => openEdit(record)}>
                Edit
              </Button>
              <Button
                size="small"
                onClick={() =>
                  workspaces.updateWorkspace(record.workspace_id, {
                    pinned: !record.pinned,
                  })
                }
              >
                {record.pinned ? "Unpin" : "Pin"}
              </Button>
              <Popconfirm
                title="Delete this workspace?"
                description="Open tabs will stay open; this only removes the saved workspace record."
                onConfirm={() => workspaces.deleteWorkspace(record.workspace_id)}
              >
                <Button size="small" danger>
                  Delete
                </Button>
              </Popconfirm>
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

  const body = (
    <div style={{ paddingRight: isFlyout ? 4 : 0 }}>
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          message="Workspace tabs"
          description="A workspace filters visible tabs by an absolute directory path inside this project. It does not close files or change permissions."
        />
        <Space wrap>
          <Segmented
            options={selectionItems}
            value={selectionValue(workspaces.selection)}
            onChange={(value) =>
              workspaces.setSelection(valueToSelection(`${value}`))
            }
          />
          <Tooltip title={`Suggested path: ${defaultRootPath}`}>
            <Button type="primary" onClick={openCreate}>
              New workspace
            </Button>
          </Tooltip>
        </Space>
        {workspaces.records.length === 0 ? (
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
            {workspaces.records.map(renderRecord)}
          </Space>
        )}
      </Space>
      <Modal
        open={editing != null}
        title={editing?.workspace_id ? "Edit Workspace" : "New Workspace"}
        onCancel={() => {
          setEditing(null);
          setError("");
        }}
        onOk={() => void onSave()}
        confirmLoading={saving}
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          {error ? <Alert type="error" showIcon message={error} /> : null}
          <div>
            <Typography.Text strong>Directory path</Typography.Text>
            <Input
              autoFocus
              value={editing?.root_path ?? ""}
              onChange={(e) => patchEditing({ root_path: e.target.value })}
            />
          </div>
          <div>
            <Typography.Text strong>Title</Typography.Text>
            <Input
              value={editing?.title ?? ""}
              onChange={(e) => patchEditing({ title: e.target.value })}
            />
          </div>
          <div>
            <Typography.Text strong>Description</Typography.Text>
            <Input.TextArea
              rows={3}
              value={editing?.description ?? ""}
              onChange={(e) => patchEditing({ description: e.target.value })}
            />
          </div>
          <div>
            <Typography.Text strong>Icon</Typography.Text>
            <Input
              placeholder="e.g. folder-open, code, book"
              value={editing?.icon ?? ""}
              onChange={(e) => patchEditing({ icon: e.target.value })}
            />
          </div>
          <div style={{ display: "flex", gap: 16 }}>
            <div style={{ flex: 1 }}>
              <Typography.Text strong>Color</Typography.Text>
              <ColorPicker
                color={editing?.color ?? undefined}
                onChange={(color) => patchEditing({ color })}
              />
            </div>
            <div style={{ flex: 1 }}>
              <Typography.Text strong>Accent color</Typography.Text>
              <ColorPicker
                color={editing?.accent_color ?? undefined}
                onChange={(color) => patchEditing({ accent_color: color })}
              />
            </div>
          </div>
          <div>
            <Typography.Text strong>Image blob hash</Typography.Text>
            <Input
              placeholder="optional blob hash"
              value={editing?.image_blob ?? ""}
              onChange={(e) => patchEditing({ image_blob: e.target.value })}
            />
          </div>
          <div>
            <Typography.Text strong>Canonical chat path</Typography.Text>
            <Input
              placeholder="optional for later agent routing"
              value={editing?.chat_path ?? ""}
              onChange={(e) => patchEditing({ chat_path: e.target.value })}
            />
          </div>
          <div>
            <Typography.Text strong>Pinned</Typography.Text>
            <div style={{ marginTop: 8 }}>
              <Switch
                checked={editing?.pinned ?? false}
                onChange={(pinned) => patchEditing({ pinned })}
              />
            </div>
          </div>
        </Space>
      </Modal>
    </div>
  );

  return body;
}

export function WorkspacesFlyout({ project_id, wrap }: WorkspacesFlyoutProps) {
  return wrap(<WorkspacesPanel project_id={project_id} layout="flyout" />);
}
