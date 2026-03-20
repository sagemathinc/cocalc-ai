/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  Modal,
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
  SelectorInput,
  ThemeEditorModal,
  TimeAgo,
  type IconName,
} from "@cocalc/frontend/components";
import {
  DragHandle,
  SortableItem,
  SortableList,
} from "@cocalc/frontend/components/sortable-list";
import { openFloatingAgentSession } from "@cocalc/frontend/project/page/agent-dock-state";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import useProjectInfo from "@cocalc/frontend/project/info/use-project-info";
import useProjectInfoHistory from "@cocalc/frontend/project/info/use-project-info-history";
import {
  summarizeWorkspaceProcesses,
  type WorkspaceProcessSummary,
} from "@cocalc/frontend/project/workspaces/process-summary";
import { getWorkspaceActivationTarget } from "@cocalc/frontend/project/workspaces/activation-target";
import { EDITOR_COLOR_SCHEMES } from "@cocalc/util/db-schema/accounts";
import { theme_desc as terminalThemeDesc } from "@cocalc/frontend/frame-editors/terminal-editor/theme-data";
import {
  ensureWorkspaceChatDirectory,
  ensureWorkspaceChatPath,
} from "@cocalc/frontend/project/workspaces/runtime";
import { pathMatchesRoot } from "@cocalc/frontend/project/workspaces/state";
import { path_split, path_to_tab, tab_to_path } from "@cocalc/util/misc";
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
  strong_theme: boolean;
  editor_theme: string | null;
  terminal_theme: string | null;
  chat_path: string | null;
};

const WORKSPACE_EDITOR_THEME_OPTIONS = [
  { value: "", display: "Use account default" },
  ...Object.entries(EDITOR_COLOR_SCHEMES).map(([value, display]) => ({
    value,
    display: `${display}`,
  })),
];

const WORKSPACE_TERMINAL_THEME_OPTIONS = [
  { value: "", display: "Use account default" },
  ...Object.entries(terminalThemeDesc).map(([value, display]) => ({
    value,
    display: `${display}`,
  })),
];

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

type WorkspaceBulkSelectionInput = {
  workspaceIds: string[];
  selectedIds: string[];
  anchorId: string | null;
  clickedId: string;
  nextChecked: boolean;
  shiftKey: boolean;
};

type WorkspaceBulkSelectionResult = {
  selectedIds: string[];
  anchorId: string;
};

export function applyWorkspaceBulkSelection({
  workspaceIds,
  selectedIds,
  anchorId,
  clickedId,
  nextChecked,
  shiftKey,
}: WorkspaceBulkSelectionInput): WorkspaceBulkSelectionResult {
  const orderedIds = workspaceIds.filter((id) => id.trim() !== "");
  const current = new Set(selectedIds);
  const clickedIndex = orderedIds.indexOf(clickedId);
  const anchorIndex = anchorId == null ? -1 : orderedIds.indexOf(anchorId);

  if (clickedIndex === -1) {
    return {
      selectedIds: orderedIds.filter((id) => current.has(id)),
      anchorId: anchorId ?? clickedId,
    };
  }

  if (shiftKey && anchorIndex !== -1) {
    const [start, end] =
      anchorIndex < clickedIndex
        ? [anchorIndex, clickedIndex]
        : [clickedIndex, anchorIndex];
    for (const id of orderedIds.slice(start, end + 1)) {
      if (nextChecked) {
        current.add(id);
      } else {
        current.delete(id);
      }
    }
  } else if (nextChecked) {
    current.add(clickedId);
  } else {
    current.delete(clickedId);
  }

  return {
    selectedIds: orderedIds.filter((id) => current.has(id)),
    anchorId: clickedId,
  };
}

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
const WORKSPACE_CARD_SUMMARY_ROW_HEIGHT = 24;

type WorkspaceSummaryRow = {
  label: string;
  color: string;
  timestamp?: string | number | null;
  tooltip?: React.ReactNode;
  dismissNotice?: boolean;
  icon?: IconName;
  filled?: boolean;
};

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

function formatCompactMemoryMiB(memRss: number): string {
  if (!Number.isFinite(memRss) || memRss <= 0) return "0MiB";
  if (memRss >= 1024) {
    return `${(memRss / 1024).toFixed(memRss >= 10 * 1024 ? 0 : 1)}GiB`;
  }
  return `${Math.round(memRss)}MiB`;
}

function workspaceNoticeColor(
  level: NonNullable<WorkspaceRecord["notice"]>["level"],
): string {
  switch (level) {
    case "success":
      return COLORS.ANTD_GREEN_D;
    case "warning":
      return COLORS.ORANGE_WARN;
    case "error":
      return COLORS.ANTD_RED_WARN;
    default:
      return COLORS.BLUE_D;
  }
}

function buildWorkspaceSummaryRow(opts: {
  record: WorkspaceRecord;
  activity: WorkspaceActivityState;
  fileActivityLabel: string | null;
}): WorkspaceSummaryRow {
  const { record, activity, fileActivityLabel } = opts;
  if (record.notice != null) {
    const label = [record.notice.title, record.notice.text]
      .filter((part) => `${part ?? ""}`.trim())
      .join(" - ");
    return {
      label: label || "Workspace notice",
      color: workspaceNoticeColor(record.notice.level),
      timestamp: record.notice.updated_at,
      tooltip: (
        <div style={{ maxWidth: 320 }}>
          {record.notice.title ? <div>{record.notice.title}</div> : null}
          {record.notice.text ? (
            <div style={{ marginTop: record.notice.title ? 4 : 0 }}>
              {record.notice.text}
            </div>
          ) : null}
        </div>
      ),
      dismissNotice: true,
      icon: "info-circle",
    };
  }
  if (activity != null) {
    return {
      label: activity.kind === "done" ? "Ready for review" : activity.label,
      color:
        activity.kind === "running"
          ? COLORS.BLUE_D
          : activity.kind === "failed"
            ? COLORS.ANTD_RED_WARN
            : COLORS.ANTD_GREEN_D,
      timestamp: activity.updatedAt,
      tooltip:
        activity.kind === "done"
          ? "All Codex turns done. Open this workspace to review."
          : activity.label,
      icon:
        activity.kind === "done"
          ? "check-circle"
          : activity.kind === "failed"
            ? "warning"
            : undefined,
      filled: activity.kind === "done",
    };
  }
  if (fileActivityLabel != null) {
    return {
      label: fileActivityLabel,
      color: COLORS.GRAY_D,
      timestamp: record.last_used_at,
      tooltip: fileActivityLabel,
    };
  }
  return {
    label: "Idle",
    color: COLORS.GRAY_D,
    timestamp: record.last_used_at,
    tooltip: record.last_used_at
      ? "No live Codex or file activity"
      : "Workspace has not been used yet",
  };
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
  const chartWidth = Math.max(52, Math.min(88, containerWidth - 104));
  const cpuPoints = sparklinePoints(cpuValues, chartWidth, 18);
  const memPoints = sparklinePoints(memValues, chartWidth, 18);
  const renderChart = showChart && containerWidth >= 156;
  return (
    <div
      ref={containerRef}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        width: "100%",
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 8,
          fontSize: 11,
          color: COLORS.GRAY_D,
          whiteSpace: "nowrap",
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
          width={chartWidth}
          height="18"
          viewBox={`0 0 ${chartWidth} 18`}
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
      strong_theme: false,
      editor_theme: null,
      terminal_theme: null,
      chat_path: null,
    };
  }
  return {
    workspace_id: record.workspace_id,
    root_path: record.root_path,
    theme: themeDraftFromTheme(record.theme),
    pinned: record.pinned,
    strong_theme: record.strong_theme === true,
    editor_theme:
      typeof record.editor_theme === "string" && record.editor_theme.trim()
        ? record.editor_theme.trim()
        : null,
    terminal_theme:
      typeof record.terminal_theme === "string" && record.terminal_theme.trim()
        ? record.terminal_theme.trim()
        : null,
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

function processTooltipContent(
  summary: WorkspaceProcessSummary,
): React.JSX.Element {
  const details: string[] = [];
  if (summary.processCount > 0) {
    details.push(
      summary.processCount === 1
        ? "1 process"
        : `${summary.processCount} processes`,
    );
  }
  if (summary.terminals > 0) {
    details.push(
      summary.terminals === 1 ? "1 terminal" : `${summary.terminals} terminals`,
    );
  }
  if (summary.notebooks > 0) {
    details.push(
      summary.notebooks === 1 ? "1 notebook" : `${summary.notebooks} notebooks`,
    );
  }
  if (summary.other > 0) {
    details.push(summary.other === 1 ? "1 other" : `${summary.other} other`);
  }
  return (
    <div style={{ maxWidth: 320 }}>
      <div>{`CPU ${Math.round(summary.cpuPct)}%`}</div>
      <div>{`RAM ${formatMemoryMiB(summary.memRss)}`}</div>
      {details.length > 0 ? (
        <div style={{ marginTop: 4 }}>{details.join(" · ")}</div>
      ) : null}
    </div>
  );
}

function dateMs(value?: string): number {
  if (!value) return 0;
  const ms = new Date(value).valueOf();
  return Number.isFinite(ms) ? ms : 0;
}

export function getWorkspaceActivityState(
  record: WorkspaceRecord,
  sessions: AgentSessionRecord[],
): WorkspaceActivityState {
  const viewedAt = record.activity_viewed_at ?? 0;
  const runningSeenAt = record.activity_running_at ?? 0;
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
  if (
    runningSeenAt > viewedAt &&
    dateMs(latest.updated_at) >= runningSeenAt &&
    dateMs(latest.updated_at) > viewedAt
  ) {
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
  const [manageOpen, setManageOpen] = useState(false);
  const [managedWorkspaceIds, setManagedWorkspaceIds] = useState<string[]>([]);
  const [manageAnchorId, setManageAnchorId] = useState<string | null>(null);
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

  async function activateWorkspace(record: WorkspaceRecord): Promise<void> {
    const nextSelection = {
      kind: "workspace",
      workspace_id: record.workspace_id,
    } satisfies WorkspaceSelection;
    select(nextSelection);
    if (!actions) return;
    const target = getWorkspaceActivationTarget({
      record,
      activePath: activePath ?? "",
      openFilesOrder,
      resolveWorkspaceForPath: workspaces.resolveWorkspaceForPath,
    });
    if (target.kind === "file") {
      actions.set_active_tab(path_to_tab(target.path), {
        change_history: true,
      });
    } else {
      await actions.open_directory(target.path, true, true);
    }
    select(nextSelection);
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
    const record = workspaces.records.find(
      ({ workspace_id }) => workspace_id === workspaceId,
    );
    if (!record) return;
    const activity = getWorkspaceActivityState(record, agentSessions);
    if (activity == null || activity.kind === "running") return;
    workspaces.updateWorkspace(workspaceId, {
      activity_viewed_at: Date.now(),
    });
  }, [agentSessions, workspaces]);

  useEffect(() => {
    for (const record of workspaces.records) {
      const chatPath = `${record.chat_path ?? ""}`.trim();
      if (!chatPath) continue;
      const latestRunning = agentSessions
        .filter(
          (session) =>
            session.chat_path === chatPath && session.status === "running",
        )
        .reduce(
          (best, session) => Math.max(best, dateMs(session.updated_at)),
          0,
        );
      if (
        latestRunning > 0 &&
        latestRunning > (record.activity_running_at ?? 0)
      ) {
        workspaces.updateWorkspace(record.workspace_id, {
          activity_running_at: latestRunning,
        });
      }
    }
  }, [agentSessions, workspaces]);

  function openCreate(): void {
    const draft = makeDraft(null, defaultRootPath);
    setEditing(draft);
    setError("");
  }

  function openManage(): void {
    setManagedWorkspaceIds([]);
    setManageAnchorId(null);
    setManageOpen(true);
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

  function toggleManagedWorkspace(
    workspaceId: string,
    nextChecked: boolean,
    shiftKey: boolean,
  ): void {
    const next = applyWorkspaceBulkSelection({
      workspaceIds: workspaces.records.map(({ workspace_id }) => workspace_id),
      selectedIds: managedWorkspaceIds,
      anchorId: manageAnchorId,
      clickedId: workspaceId,
      nextChecked,
      shiftKey,
    });
    setManagedWorkspaceIds(next.selectedIds);
    setManageAnchorId(next.anchorId);
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
          strong_theme: values.strong_theme,
          editor_theme: values.editor_theme,
          terminal_theme: values.terminal_theme,
          chat_path: values.chat_path,
        });
      } else {
        workspaces.createWorkspace({
          root_path: values.root_path,
          ...themeFromDraft(values.theme),
          pinned: values.pinned,
          strong_theme: values.strong_theme,
          editor_theme: values.editor_theme,
          terminal_theme: values.terminal_theme,
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

  async function deleteManagedWorkspaces(): Promise<void> {
    if (managedWorkspaceIds.length === 0) return;
    setSaving(true);
    setError("");
    try {
      for (const workspaceId of managedWorkspaceIds) {
        workspaces.deleteWorkspace(workspaceId);
      }
      setManageOpen(false);
      setManagedWorkspaceIds([]);
      setManageAnchorId(null);
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

  async function floatWorkspaceChat(record: WorkspaceRecord): Promise<void> {
    setError("");
    try {
      const { chat_path } = await ensureWorkspaceChatPath({
        project_id,
        account_id,
        workspace_id: record.workspace_id,
      });
      if (record.chat_path !== chat_path) {
        workspaces.updateWorkspace(record.workspace_id, { chat_path });
      }
      const latestSession =
        agentSessions
          .filter((session) => session.chat_path === chat_path)
          .sort((a, b) => dateMs(b.updated_at) - dateMs(a.updated_at))[0] ??
        null;
      if (!latestSession) {
        setError(
          "No agent thread exists in this workspace chat yet. Open Chat first or start a Codex turn there.",
        );
        return;
      }
      const nextSelection = {
        kind: "workspace",
        workspace_id: record.workspace_id,
      } satisfies WorkspaceSelection;
      select(nextSelection);
      openFloatingAgentSession(project_id, latestSession, {
        workspaceId: record.workspace_id,
        workspaceOnly: true,
      });
    } catch (err) {
      setError(`${err}`);
    }
  }

  function renderRecord(record: WorkspaceRecord): React.JSX.Element {
    const selected =
      workspaces.selection.kind === "workspace" &&
      workspaces.selection.workspace_id === record.workspace_id;
    const imageUrl = record.theme.image_blob?.trim()
      ? `/blobs/theme-image.png?uuid=${encodeURIComponent(record.theme.image_blob.trim())}`
      : undefined;
    const activity = getWorkspaceActivityState(record, agentSessions);
    const fileActivity = getWorkspaceOpenFileActivity(
      record,
      openFilesOrder,
      openFiles,
    );
    const fileActivityLabel = workspaceOpenFileActivityLabel(fileActivity);
    const processSummary: WorkspaceProcessSummary | null =
      processSummaryByWorkspaceId.get(record.workspace_id) ?? null;
    const summaryRow = buildWorkspaceSummaryRow({
      record,
      activity,
      fileActivityLabel,
    });
    const compactProcessSummary =
      processSummary ??
      ({
        processCount: 0,
        terminals: 0,
        notebooks: 0,
        other: 0,
        cpuPct: 0,
        memRss: 0,
        cpuTrend: [],
        memTrend: [],
        timestamps: [],
      } satisfies WorkspaceProcessSummary);
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
        onClick={() => void activateWorkspace(record)}
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
                alignItems: "center",
                gap: 8,
              }}
            >
              <div
                style={{
                  minWidth: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                {selected ? (
                  <span
                    title="Selected workspace"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: COLORS.ANTD_GREEN_D,
                      flex: "0 0 auto",
                    }}
                  />
                ) : null}
                <Typography.Text
                  strong
                  style={{
                    minWidth: 0,
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    textOverflow: "ellipsis",
                  }}
                >
                  {record.theme.title}
                </Typography.Text>
              </div>
              <div
                onClick={(e) => e.stopPropagation()}
                style={{ color: COLORS.GRAY, flex: "0 0 auto" }}
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
              <Tooltip title={record.theme.description}>
                <Typography.Paragraph
                  type="secondary"
                  style={{ margin: "6px 0 0 0" }}
                  ellipsis={{ rows: isFlyout ? 2 : 3 }}
                >
                  {record.theme.description}
                </Typography.Paragraph>
              </Tooltip>
            ) : null}
            <div style={{ marginTop: 6 }}>
              <div
                style={{
                  minHeight: WORKSPACE_CARD_SUMMARY_ROW_HEIGHT,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <Tooltip title={summaryRow.tooltip ?? summaryRow.label}>
                  <div
                    style={{
                      minWidth: 0,
                      flex: 1,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      color: summaryRow.filled ? "#fff" : summaryRow.color,
                      background: summaryRow.filled
                        ? summaryRow.color
                        : record.notice != null
                          ? `${summaryRow.color}14`
                          : undefined,
                      borderRadius: 999,
                      padding:
                        summaryRow.filled || record.notice != null
                          ? "2px 8px"
                          : 0,
                    }}
                  >
                    {summaryRow.icon ? (
                      <Icon
                        name={summaryRow.icon}
                        style={{ flex: "0 0 auto", color: "inherit" }}
                      />
                    ) : (
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: summaryRow.color,
                          flex: "0 0 auto",
                        }}
                      />
                    )}
                    <span
                      style={{
                        minWidth: 0,
                        overflow: "hidden",
                        whiteSpace: "nowrap",
                        textOverflow: "ellipsis",
                        fontSize: 12,
                      }}
                    >
                      {summaryRow.label}
                    </span>
                  </div>
                </Tooltip>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 2,
                    flex: "0 0 auto",
                    color: COLORS.GRAY,
                    fontSize: 12,
                    whiteSpace: "nowrap",
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {summaryRow.timestamp ? (
                    <TimeAgo date={summaryRow.timestamp} />
                  ) : (
                    <span>Never</span>
                  )}
                  {summaryRow.dismissNotice ? (
                    <Button
                      type="text"
                      size="small"
                      style={{
                        paddingInline: 4,
                        color: COLORS.GRAY,
                        height: 20,
                      }}
                      icon={<Icon name="times" />}
                      onClick={() =>
                        workspaces.updateWorkspace(record.workspace_id, {
                          notice: null,
                        })
                      }
                    />
                  ) : null}
                </div>
              </div>
              <Tooltip title={processTooltipContent(compactProcessSummary)}>
                <div
                  style={{
                    marginTop: 4,
                    padding: "3px 6px",
                    borderRadius: 8,
                    background: PROCESS_PANEL_BG,
                    minHeight: WORKSPACE_CARD_SUMMARY_ROW_HEIGHT,
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <WorkspaceProcessSparkline
                    cpuValues={compactProcessSummary.cpuTrend}
                    memValues={compactProcessSummary.memTrend}
                    cpuColor={record.theme.color ?? COLORS.BLUE_D}
                    memColor={record.theme.accent_color ?? COLORS.ANTD_GREEN_D}
                    cpuLabel={`${Math.round(compactProcessSummary.cpuPct)}%`}
                    memLabel={formatCompactMemoryMiB(
                      compactProcessSummary.memRss,
                    )}
                    showChart
                  />
                </div>
              </Tooltip>
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
              <Tooltip title="Float the latest agent thread in this workspace chat">
                <Button
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    void floatWorkspaceChat(record);
                  }}
                >
                  Float
                </Button>
              </Tooltip>
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
          {workspaces.records.length > 0 ? (
            <Button onClick={openManage}>Manage</Button>
          ) : null}
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
            <div>
              <Typography.Text strong>Editor theme override</Typography.Text>
              <div style={{ marginTop: 8 }}>
                <SelectorInput
                  style={{ width: "100%" }}
                  selected={editing?.editor_theme ?? ""}
                  options={WORKSPACE_EDITOR_THEME_OPTIONS}
                  on_change={(editor_theme) =>
                    patchEditing({
                      editor_theme: `${editor_theme ?? ""}`.trim() || null,
                    })
                  }
                  showSearch={true}
                />
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Overrides the account editor theme while you are working in this
                workspace.
              </Typography.Text>
            </div>
            <div>
              <Typography.Text strong>Terminal theme override</Typography.Text>
              <div style={{ marginTop: 8 }}>
                <SelectorInput
                  style={{ width: "100%" }}
                  selected={editing?.terminal_theme ?? ""}
                  options={WORKSPACE_TERMINAL_THEME_OPTIONS}
                  on_change={(terminal_theme) =>
                    patchEditing({
                      terminal_theme: `${terminal_theme ?? ""}`.trim() || null,
                    })
                  }
                  showSearch={true}
                />
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Overrides the account terminal theme while you are working in
                this workspace.
              </Typography.Text>
            </div>
            <div>
              <Typography.Text strong>Stronger theme mode</Typography.Text>
              <div style={{ marginTop: 8 }}>
                <Switch
                  checked={editing?.strong_theme ?? false}
                  onChange={(strong_theme) => patchEditing({ strong_theme })}
                />
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Adds stronger workspace-colored chrome so it is easier to tell
                where you are.
              </Typography.Text>
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
      <Modal
        open={manageOpen}
        title="Manage Workspaces"
        onCancel={() => {
          setManageOpen(false);
          setManagedWorkspaceIds([]);
          setManageAnchorId(null);
        }}
        destroyOnClose
        footer={
          <Space>
            <Button
              onClick={() => {
                setManageOpen(false);
                setManagedWorkspaceIds([]);
                setManageAnchorId(null);
              }}
            >
              Close
            </Button>
            <Button
              onClick={() =>
                setManagedWorkspaceIds(
                  workspaces.records.map(({ workspace_id }) => workspace_id),
                )
              }
            >
              Select all
            </Button>
            <Button
              onClick={() => {
                setManagedWorkspaceIds([]);
                setManageAnchorId(null);
              }}
            >
              Clear
            </Button>
            <Popconfirm
              title={`Delete ${managedWorkspaceIds.length} workspace${managedWorkspaceIds.length === 1 ? "" : "s"}?`}
              description="This removes the saved workspace entries from this project."
              okButtonProps={{ danger: true }}
              onConfirm={() => void deleteManagedWorkspaces()}
              disabled={managedWorkspaceIds.length === 0}
            >
              <Button
                type="primary"
                danger
                disabled={managedWorkspaceIds.length === 0}
                loading={saving}
              >
                Delete
              </Button>
            </Popconfirm>
          </Space>
        }
      >
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Select one or more workspaces to delete. Shift-click selects a
            range.
          </Typography.Paragraph>
          <Typography.Text type="secondary">
            Selected: {managedWorkspaceIds.length} of{" "}
            {workspaces.records.length}
          </Typography.Text>
          <div
            style={{
              maxHeight: 420,
              overflow: "auto",
              border: `1px solid ${COLORS.GRAY_L}`,
              borderRadius: 8,
            }}
          >
            <Space direction="vertical" size={0} style={{ width: "100%" }}>
              {workspaces.records.map((record) => {
                const checked = managedWorkspaceIds.includes(
                  record.workspace_id,
                );
                return (
                  <div
                    key={record.workspace_id}
                    onClick={(e) =>
                      toggleManagedWorkspace(
                        record.workspace_id,
                        !checked,
                        e.shiftKey,
                      )
                    }
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "10px 12px",
                      cursor: "pointer",
                      background: checked ? COLORS.BLUE_LL : undefined,
                      borderBottom: `1px solid ${COLORS.GRAY_LL}`,
                    }}
                  >
                    <Checkbox
                      checked={checked}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        toggleManagedWorkspace(
                          record.workspace_id,
                          e.target.checked,
                          Boolean(e.nativeEvent.shiftKey),
                        )
                      }
                    />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <Typography.Text strong>
                        {record.theme.title}
                      </Typography.Text>
                      <div>
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 12 }}
                        >
                          {record.root_path}
                        </Typography.Text>
                      </div>
                    </div>
                  </div>
                );
              })}
            </Space>
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
