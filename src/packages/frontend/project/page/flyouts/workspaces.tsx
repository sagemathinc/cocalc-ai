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
  Popover,
  Popconfirm,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { pathMatchesWorkspace } from "@cocalc/conat/workspaces";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  type AgentSessionRecord,
  watchAgentSessionsForProject,
} from "@cocalc/frontend/chat/agent-session-index";
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
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import useProjectInfo from "@cocalc/frontend/project/info/use-project-info";
import useProjectInfoHistory from "@cocalc/frontend/project/info/use-project-info-history";
import {
  summarizeWorkspaceProcesses,
  type WorkspaceProcessSummary,
} from "@cocalc/frontend/project/workspaces/process-summary";
import {
  ensureWorkspaceChatDirectory,
  ensureWorkspaceChatPath,
} from "@cocalc/frontend/project/workspaces/runtime";
import { pathMatchesRoot } from "@cocalc/frontend/project/workspaces/state";
import { path_split, tab_to_path } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
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
const WORKSPACE_ACTIVITY_VIEWED_KEY = "project-workspaces-activity-viewed-v1";

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
  chat_path: string | null;
};

type WorkspaceActivityState =
  | {
      kind: "running" | "done" | "failed";
      label: string;
      color: string;
      updatedAt: string;
    }
  | undefined;

type WorkspaceOpenFileActivity = {
  terminals: number;
  notebooks: number;
  other: number;
};

function workspaceOpenFileActivityLabel(
  activity: WorkspaceOpenFileActivity,
): string | null {
  const parts: string[] = [];
  if (activity.terminals > 0) {
    parts.push(
      activity.terminals === 1
        ? "1 terminal active"
        : `${activity.terminals} terminals active`,
    );
  }
  if (activity.notebooks > 0) {
    parts.push(
      activity.notebooks === 1
        ? "1 notebook busy"
        : `${activity.notebooks} notebooks busy`,
    );
  }
  if (activity.other > 0) {
    parts.push(
      activity.other === 1 ? "1 active file" : `${activity.other} active files`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function iconFor(record?: WorkspaceRecord | null): IconName {
  return (record?.theme.icon?.trim() as IconName | undefined) || DEFAULT_ICON;
}

const WORKSPACE_MEDIA_SIZE = 64;
const PROCESS_PANEL_BG = COLORS.GRAY_LLL;
const WORKSPACE_CARD_STATUS_MIN_HEIGHT_FLYOUT = 40;
const WORKSPACE_CARD_STATUS_MIN_HEIGHT_PAGE = 56;

function sparklinePoints(
  values: number[],
  width = 120,
  height = 28,
): string | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const dx = width / (values.length - 1);
  const y = (value: number) => {
    if (max === min) return height / 2;
    return height - ((value - min) / (max - min)) * (height - 4) - 2;
  };
  return values
    .map((value, i) => `${(i * dx).toFixed(2)},${y(value).toFixed(2)}`)
    .join(" ");
}

function formatMemoryMiB(memRss: number): string {
  if (!Number.isFinite(memRss) || memRss <= 0) return "0 MiB";
  if (memRss >= 1024) {
    return `${(memRss / 1024).toFixed(memRss >= 10 * 1024 ? 0 : 1)} GiB`;
  }
  return `${Math.round(memRss)} MiB`;
}

function WorkspaceProcessSparkline({
  cpuValues,
  memValues,
  cpuColor,
  memColor,
  cpuLabel,
  memLabel,
  showChart = true,
}: {
  cpuValues: number[];
  memValues: number[];
  cpuColor: string;
  memColor: string;
  cpuLabel: string;
  memLabel: string;
  showChart?: boolean;
}): React.JSX.Element | null {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const update = () => setContainerWidth(node.clientWidth);
    update();
    const observer = new ResizeObserver(() => update());
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const cpuPoints = sparklinePoints(cpuValues, 96, 20);
  const memPoints = sparklinePoints(memValues, 96, 20);
  const renderChart = showChart && containerWidth >= 260;
  return (
    <div
      ref={containerRef}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 10,
          fontSize: 11,
          color: COLORS.GRAY_D,
          flexWrap: "wrap",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              width: 8,
              height: 2,
              background: cpuColor,
              borderRadius: 999,
            }}
          />
          {cpuLabel}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              width: 8,
              height: 2,
              background: memColor,
              borderRadius: 999,
            }}
          />
          {memLabel}
        </span>
      </div>
      {renderChart && (cpuPoints || memPoints) ? (
        <svg
          width="96"
          height="20"
          viewBox="0 0 96 20"
          preserveAspectRatio="none"
          style={{ flex: "0 0 auto" }}
        >
          {memPoints ? (
            <polyline
              fill="none"
              stroke={memColor}
              strokeWidth="1.5"
              points={memPoints}
              strokeLinecap="round"
            />
          ) : null}
          {cpuPoints ? (
            <polyline
              fill="none"
              stroke={cpuColor}
              strokeWidth="1.5"
              points={cpuPoints}
              strokeLinecap="round"
            />
          ) : null}
        </svg>
      ) : null}
    </div>
  );
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
      chat_path: null,
    };
  }
  return {
    workspace_id: record.workspace_id,
    root_path: record.root_path,
    theme: themeDraftFromTheme(record.theme),
    pinned: record.pinned,
    chat_path: record.chat_path ?? null,
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

function loadViewedActivity(project_id: string): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(
      `${WORKSPACE_ACTIVITY_VIEWED_KEY}:${project_id}`,
    );
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed != null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistViewedActivity(
  project_id: string,
  viewed: Record<string, number>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      `${WORKSPACE_ACTIVITY_VIEWED_KEY}:${project_id}`,
      JSON.stringify(viewed),
    );
  } catch {
    // best effort only
  }
}

function dateMs(value?: string): number {
  if (!value) return 0;
  const ms = new Date(value).valueOf();
  return Number.isFinite(ms) ? ms : 0;
}

function getWorkspaceActivityState(
  record: WorkspaceRecord,
  sessions: AgentSessionRecord[],
  viewedAt: number,
): WorkspaceActivityState {
  const chatPath = `${record.chat_path ?? ""}`.trim();
  if (!chatPath) return undefined;
  const matching = sessions
    .filter((session) => session.chat_path === chatPath)
    .sort((a, b) => dateMs(b.updated_at) - dateMs(a.updated_at));
  if (matching.length === 0) return undefined;

  const latest = matching[0];
  if (matching.some((session) => session.status === "running")) {
    return {
      kind: "running",
      label: "Codex running",
      color: "processing",
      updatedAt: latest.updated_at,
    };
  }
  if (latest.status === "failed" && dateMs(latest.updated_at) > viewedAt) {
    return {
      kind: "failed",
      label: "Codex error",
      color: "error",
      updatedAt: latest.updated_at,
    };
  }
  if (dateMs(latest.updated_at) > viewedAt) {
    return {
      kind: "done",
      label: "Codex done",
      color: "success",
      updatedAt: latest.updated_at,
    };
  }
  return undefined;
}

function getWorkspaceOpenFileActivity(
  record: WorkspaceRecord,
  openFilesOrder: string[],
  openFiles: any,
): WorkspaceOpenFileActivity {
  let terminals = 0;
  let notebooks = 0;
  let other = 0;

  for (const path of openFilesOrder) {
    if (!pathMatchesWorkspace(record, path)) continue;
    const hasActivity = !!openFiles?.getIn?.([path, "has_activity"]);
    if (!hasActivity) continue;
    if (path.endsWith(".term")) {
      terminals += 1;
    } else if (path.endsWith(".ipynb")) {
      notebooks += 1;
    } else {
      other += 1;
    }
  }
  return { terminals, notebooks, other };
}

export function WorkspacesPanel({ project_id, layout = "page" }: Props) {
  const { actions, active_project_tab, workspaces } = useProjectContext();
  const account_id = `${useTypedRedux("account", "account_id") ?? ""}`.trim();
  const current_path_abs =
    useTypedRedux({ project_id }, "current_path_abs") ?? "/";
  const openFilesOrder =
    useTypedRedux({ project_id }, "open_files_order")?.toJS?.() ?? [];
  const openFiles = useTypedRedux({ project_id }, "open_files");
  const activePath = useMemo(
    () => tab_to_path(active_project_tab ?? ""),
    [active_project_tab],
  );
  const { info } = useProjectInfo({ project_id });
  const { history } = useProjectInfoHistory({ project_id, minutes: 30 });
  const homeDirectory = useMemo(
    () => getProjectHomeDirectory(project_id),
    [project_id],
  );
  const [editing, setEditing] = useState<EditorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [openingChatId, setOpeningChatId] = useState<string | null>(null);
  const [error, setError] = useState<string>("");
  const [agentSessions, setAgentSessions] = useState<AgentSessionRecord[]>([]);
  const [viewedActivity, setViewedActivity] = useState<Record<string, number>>(
    () => loadViewedActivity(project_id),
  );
  const isFlyout = layout === "flyout";
  const now = Date.now();

  const defaultRootPath = useMemo(() => {
    if (activePath) {
      const split = path_split(activePath);
      return split.head || "/";
    }
    return current_path_abs || "/";
  }, [activePath, current_path_abs]);
  const activeChatPath =
    activePath && activePath.endsWith(".chat") ? activePath : null;

  function select(next: WorkspaceSelection): void {
    workspaces.setSelection(next);
  }

  useEffect(() => {
    let closed = false;
    let unsubscribe: (() => void) | undefined;

    void watchAgentSessionsForProject(
      { project_id },
      (records: AgentSessionRecord[]) => {
        if (!closed) {
          setAgentSessions(records);
        }
      },
    )
      .then((cleanup) => {
        unsubscribe = cleanup;
      })
      .catch(() => {});

    return () => {
      closed = true;
      unsubscribe?.();
    };
  }, [project_id]);

  useEffect(() => {
    if (workspaces.selection.kind !== "workspace") return;
    const workspaceId = workspaces.selection.workspace_id;
    setViewedActivity((current) => {
      const next = { ...current, [workspaceId]: Date.now() };
      persistViewedActivity(project_id, next);
      return next;
    });
  }, [project_id, workspaces.selection]);

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
          chat_path: values.chat_path,
        });
      } else {
        workspaces.createWorkspace({
          root_path: values.root_path,
          ...themeFromDraft(values.theme),
          pinned: values.pinned,
          chat_path: values.chat_path,
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
      if (record.chat_path !== chat_path) {
        workspaces.updateWorkspace(record.workspace_id, { chat_path });
      }
      const nextSelection = {
        kind: "workspace",
        workspace_id: record.workspace_id,
      } satisfies WorkspaceSelection;
      select(nextSelection);
      await actions.open_file({ path: chat_path, foreground: true });
      select(nextSelection);
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
    const activity = getWorkspaceActivityState(
      record,
      agentSessions,
      viewedActivity[record.workspace_id] ?? 0,
    );
    const fileActivity = getWorkspaceOpenFileActivity(
      record,
      openFilesOrder,
      openFiles,
    );
    const fileActivityLabel = workspaceOpenFileActivityLabel(fileActivity);
    const processSummary: WorkspaceProcessSummary | null =
      processSummaryByWorkspaceId.get(record.workspace_id) ?? null;
    const hasProcessSummary =
      processSummary != null &&
      (processSummary.processCount > 0 || processSummary.cpuTrend.length >= 2);
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
                width: WORKSPACE_MEDIA_SIZE,
                height: WORKSPACE_MEDIA_SIZE,
                borderRadius: 8,
                objectFit: "cover",
                flex: "0 0 auto",
              }}
            />
          ) : (
            <div
              style={{
                width: WORKSPACE_MEDIA_SIZE,
                height: WORKSPACE_MEDIA_SIZE,
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: record.theme.accent_color ?? "#f5f5f5",
                color: record.theme.color ?? undefined,
                flex: "0 0 auto",
                fontSize: 28,
              }}
            >
              <Icon name={iconFor(record)} />
            </div>
          )}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
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
            <div
              style={{
                marginTop: 6,
                minHeight: isFlyout
                  ? WORKSPACE_CARD_STATUS_MIN_HEIGHT_FLYOUT
                  : WORKSPACE_CARD_STATUS_MIN_HEIGHT_PAGE,
              }}
            >
              {record.theme.description ? (
                <Typography.Paragraph
                  type="secondary"
                  style={{ margin: 0 }}
                  ellipsis={{ rows: isFlyout ? 2 : 3 }}
                >
                  {record.theme.description}
                </Typography.Paragraph>
              ) : null}
              {record.notice ? (
                <div
                  style={{ marginTop: record.theme.description ? 8 : 0 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Alert
                    type={record.notice.level}
                    showIcon
                    closable
                    message={record.notice.title || "Workspace notice"}
                    description={record.notice.text}
                    onClose={() =>
                      workspaces.updateWorkspace(record.workspace_id, {
                        notice: null,
                      })
                    }
                  />
                </div>
              ) : null}
              {activity ? (
                <Space size={8} wrap style={{ marginTop: 8 }}>
                  <Tag color={activity.color}>{activity.label}</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    <TimeAgo date={activity.updatedAt} />
                  </Typography.Text>
                </Space>
              ) : null}
              {fileActivityLabel ? (
                <Typography.Text
                  type="secondary"
                  style={{
                    display: "block",
                    marginTop: 8,
                    fontSize: 12,
                  }}
                >
                  {fileActivityLabel}
                </Typography.Text>
              ) : null}
              {hasProcessSummary ? (
                <div
                  style={{
                    marginTop: 6,
                    padding: "4px 6px",
                    borderRadius: 8,
                    background: PROCESS_PANEL_BG,
                  }}
                >
                  <WorkspaceProcessSparkline
                    cpuValues={processSummary.cpuTrend}
                    memValues={processSummary.memTrend}
                    cpuColor={record.theme.color ?? COLORS.BLUE_D}
                    memColor={record.theme.accent_color ?? COLORS.ANTD_GREEN_D}
                    cpuLabel={`CPU ${Math.round(processSummary.cpuPct)}%`}
                    memLabel={`RAM ${formatMemoryMiB(processSummary.memRss)}`}
                    showChart
                  />
                </div>
              ) : null}
            </div>
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
                Chat
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
            <div
              style={{
                marginTop: 8,
                minHeight: 18,
                fontSize: 12,
                color: "#888",
              }}
            >
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
  const processSummaryByWorkspaceId = useMemo(
    () =>
      new Map(
        workspaces.records.map((record) => [
          record.workspace_id,
          summarizeWorkspaceProcesses({
            record,
            info,
            history,
            homeDirectory,
          }),
        ]),
      ),
    [history, homeDirectory, info, workspaces.records],
  );
  const canUseActiveChat =
    editing != null &&
    activeChatPath != null &&
    pathMatchesRoot(activeChatPath, editing.root_path);

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
              <Typography.Text strong>Workspace chat</Typography.Text>
              <div style={{ marginTop: 8 }}>
                {editing?.chat_path ? (
                  <Typography.Paragraph
                    type="secondary"
                    style={{ marginBottom: 8 }}
                    ellipsis={{ rows: 2 }}
                  >
                    {editing.chat_path}
                  </Typography.Paragraph>
                ) : (
                  <Typography.Text type="secondary">
                    Uses the generated workspace chat until you set one.
                  </Typography.Text>
                )}
              </div>
              <Space wrap>
                <Button
                  size="small"
                  disabled={!canUseActiveChat}
                  onClick={() => patchEditing({ chat_path: activeChatPath })}
                >
                  Use current chat tab
                </Button>
                {editing?.chat_path ? (
                  <Button
                    size="small"
                    onClick={() => patchEditing({ chat_path: null })}
                  >
                    Reset to generated chat
                  </Button>
                ) : null}
              </Space>
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
