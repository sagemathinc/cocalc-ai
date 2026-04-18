/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Button,
  Input,
  message as antdMessage,
  Modal,
  Popover,
  Select,
  Space,
  Switch,
} from "antd";
import {
  React,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { debounce } from "lodash";
import { ColorButton } from "@cocalc/frontend/components/color-picker";
import { COLORS } from "@cocalc/util/theme";
import {
  DEFAULT_CODEX_MODEL_NAME,
  DEFAULT_CODEX_MODELS,
  isCodexModelName,
  resolveCodexSessionMode,
  type CodexReasoningLevel,
  type CodexReasoningId,
  type CodexSessionMode,
} from "@cocalc/util/ai/codex";
import { deriveAcpLogRefs, type CodexThreadConfig } from "@cocalc/chat";
import type { AcpAutomationConfig } from "@cocalc/conat/ai/acp/types";
import { ChatLog } from "./chat-log";
import { AgentMessageStatus } from "./agent-message-status";
import CodexConfigButton from "./codex";
import { ThreadBadge } from "./thread-badge";
import type { ChatActions } from "./actions";
import type { ChatMessages } from "./types";
import type * as immutable from "immutable";
import type { ThreadIndexEntry } from "./message-cache";
import type { ThreadListItem, ThreadMeta } from "./threads";
import { dateValue, field } from "./access";
import { getThreadRootDate, newest_content } from "./utils";
import type { CodexPaymentSourceInfo } from "@cocalc/conat/hub/api/system";
import type {
  ChatStoreArchivedRow,
  ChatStoreStats,
  ChatStoreSearchHit,
} from "@cocalc/conat/hub/api/projects";
import { ChatIconPicker } from "./chat-icon-picker";
import {
  codexNewChatDefaultsEqual,
  getDefaultCodexNewChatDefaults,
  getCodexNewChatModeOptions,
  getDefaultCodexSessionMode,
  saveCodexNewChatDefaults,
} from "./codex-defaults";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useAnyChatOverlayOpen } from "./drawer-overlay-state";
import { resolveThreadStatusDot } from "./chatroom-sidebar";
import {
  chatPanelOwnsThreadSearchShortcut,
  shouldOpenThreadSearchShortcut,
} from "./chatroom-thread-panel-shortcuts";
import { resolveAgentSessionIdForThread } from "./thread-session";
import { useCodexLog } from "./use-codex-log";
import {
  AutomationConfigFields,
  buildAutomationDraft,
  getDefaultAutomationConfig,
} from "./automation-form";

const CHAT_LOG_STYLE: React.CSSProperties = {
  padding: "0",
  background: "white",
  flex: "1 1 0",
  minHeight: 0,
  position: "relative",
} as const;

const SETUP_CARD_STYLE: React.CSSProperties = {
  width: "min(840px, 96%)",
  margin: "0 auto",
  padding: "18px 20px",
  border: "1px solid #eee",
  borderRadius: 12,
  background: "#fcfcfc",
} as const;

const DEFAULT_CODEX_MODEL =
  DEFAULT_CODEX_MODELS[0]?.name ?? DEFAULT_CODEX_MODEL_NAME;
const ARCHIVED_SEARCH_LIMIT = 20;
const ARCHIVED_HISTORY_LIMIT = 50;
const ARCHIVED_INLINE_PREVIEW_LIMIT = 6;

function logChatArchiveDiagnostic(
  message: string,
  details: Record<string, unknown>,
): void {
  console.log(`[chat-archive] ${message}`, details);
}

export type NewThreadAgentMode = "codex" | "human" | "model";
export interface NewThreadSetup {
  title: string;
  icon?: string;
  color?: string;
  image?: string;
  agentMode: NewThreadAgentMode;
  model: string;
  codexConfig: Partial<CodexThreadConfig>;
  automationConfig?: AcpAutomationConfig;
}

export function getDefaultNewThreadSetup(): NewThreadSetup {
  const defaults = getDefaultCodexNewChatDefaults();
  return {
    title: "",
    icon: undefined,
    color: undefined,
    image: "",
    agentMode: "codex",
    model: defaults.model,
    codexConfig: {
      model: defaults.model,
      sessionMode: defaults.sessionMode,
      reasoning: defaults.reasoning,
    },
    automationConfig: getDefaultAutomationConfig({ enabled: false }),
  };
}

export const DEFAULT_NEW_THREAD_SETUP: NewThreadSetup =
  getDefaultNewThreadSetup();

export function resolveActiveThreadSearchMatchDate({
  threadSearchOpen,
  matchCount,
  normalizedCursor,
  threadSearchMatches,
}: {
  threadSearchOpen: boolean;
  matchCount: number;
  normalizedCursor: number;
  threadSearchMatches: string[];
}): string | undefined {
  if (!threadSearchOpen || !matchCount) return undefined;
  return threadSearchMatches[normalizedCursor];
}

export function resolveThreadSearchHighlightQuery({
  threadSearchOpen,
  threadSearchQuery,
}: {
  threadSearchOpen: boolean;
  threadSearchQuery: string;
}): string {
  return threadSearchOpen ? threadSearchQuery : "";
}

export function resolveCompactThreadBadgeAppearance({
  thread,
  acpState,
  activityNow,
}: {
  thread?: ThreadMeta;
  acpState: immutable.Map<string, string>;
  activityNow: number;
}): { badgeColor?: string; badgeSize: number } {
  if (!thread?.hasCustomAppearance) {
    return { badgeColor: thread?.threadColor, badgeSize: 18 };
  }
  if (`${thread.threadImage ?? ""}`.trim()) {
    return { badgeColor: thread.threadColor, badgeSize: 18 };
  }
  const status = resolveThreadStatusDot({
    thread,
    acpState,
    activityNow,
  });
  if (!status.showDot) {
    return { badgeColor: thread.threadColor, badgeSize: 18 };
  }
  return {
    badgeColor: status.dotColor,
    badgeSize: 16,
  };
}

export function applyNewThreadSetupPatch(
  current: NewThreadSetup,
  patch: Partial<NewThreadSetup>,
): NewThreadSetup {
  return { ...current, ...patch };
}

export function resolveSelectedThreadRunningCodexMessage(
  threadMessages: ChatMessages | any[] | undefined,
) {
  const entries = Array.isArray(threadMessages) ? threadMessages : [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const message = entries[i];
    if (message == null) continue;
    if (!field<string>(message, "acp_account_id")) continue;
    if (field<boolean>(message, "acp_interrupted") === true) continue;
    if (field<boolean>(message, "generating") !== true) continue;
    return message;
  }
  return undefined;
}

function getAcpStartedAtMs(message: any): number | undefined {
  const value = field<number | string>(message, "acp_started_at_ms");
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function getLatestCodexActivityAtMs(
  events: any[] | null | undefined,
): number | undefined {
  if (!Array.isArray(events)) return undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const time = (events[i] as any)?.time;
    if (typeof time === "number" && Number.isFinite(time)) {
      return time;
    }
  }
  return undefined;
}

function normalizeThreadKey(value?: string | null): string | undefined {
  const key = `${value ?? ""}`.trim();
  if (!key) return undefined;
  return key;
}

interface ChatRoomThreadPanelProps {
  actions: ChatActions;
  project_id?: string;
  path?: string;
  messages: ChatMessages;
  threadIndex?: Map<string, ThreadIndexEntry>;
  acpState: immutable.Map<string, string>;
  scrollToBottomRef: React.MutableRefObject<any>;
  scrollCacheId: string;
  fontSize?: number;
  selectedThreadKey: string | null;
  selectedThread?: ThreadMeta | ThreadListItem;
  variant: "compact" | "default";
  scrollToIndex: number | null;
  scrollToDate: string | null;
  fragmentId: string | null;
  threadsCount: number;
  onNewChat: () => void;
  codexPaymentSource?: CodexPaymentSourceInfo;
  codexPaymentSourceLoading?: boolean;
  refreshCodexPaymentSource?: () => void;
  newThreadSetup: NewThreadSetup;
  onNewThreadSetupChange: React.Dispatch<React.SetStateAction<NewThreadSetup>>;
  onCreateThread: () => void | Promise<void>;
  showThreadImagePreview?: boolean;
  hideChatTypeSelector?: boolean;
  activityJumpDate?: string;
  activityJumpToken?: number;
  shortcutEnabled?: boolean;
  notifyOnTurnFinish?: boolean;
  onNotifyOnTurnFinishChange?: (checked: boolean) => void;
  allowSidebarToggle?: boolean;
  sidebarHidden?: boolean;
  onToggleSidebar?: () => void;
  onOpenGitBrowser?: (request: {
    threadKey: string;
    cwdOverride?: string;
    commitHash: string;
  }) => void;
}

export function ChatRoomThreadPanel({
  actions,
  project_id,
  path,
  messages,
  threadIndex,
  acpState,
  scrollToBottomRef,
  scrollCacheId,
  fontSize,
  selectedThreadKey,
  selectedThread,
  variant,
  scrollToIndex,
  scrollToDate,
  fragmentId,
  threadsCount,
  onNewChat,
  codexPaymentSource,
  codexPaymentSourceLoading,
  refreshCodexPaymentSource,
  newThreadSetup,
  onNewThreadSetupChange,
  onCreateThread,
  showThreadImagePreview = true,
  hideChatTypeSelector = false,
  activityJumpDate,
  activityJumpToken,
  shortcutEnabled = true,
  notifyOnTurnFinish = false,
  onNotifyOnTurnFinishChange,
  allowSidebarToggle = false,
  sidebarHidden = false,
  onToggleSidebar,
  onOpenGitBrowser,
}: ChatRoomThreadPanelProps) {
  const defaultSessionMode = getDefaultCodexSessionMode();
  const accountOtherSettings = useTypedRedux("account", "other_settings");
  const defaultNewChatCodexDefaults = useMemo(
    () => getDefaultCodexNewChatDefaults(),
    [accountOtherSettings],
  );
  const [threadSearchOpen, setThreadSearchOpen] = useState(false);
  const [threadSearchInput, setThreadSearchInput] = useState("");
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [threadSearchCursor, setThreadSearchCursor] = useState(0);
  const [threadSearchJumpToken, setThreadSearchJumpToken] = useState(0);
  const [archivedSearchLoading, setArchivedSearchLoading] = useState(false);
  const [archivedSearchHits, setArchivedSearchHits] = useState<
    ChatStoreSearchHit[]
  >([]);
  const [archivedSearchTotal, setArchivedSearchTotal] = useState(0);
  const [archivedSearchError, setArchivedSearchError] = useState("");
  const [archivedHistoryOpen, setArchivedHistoryOpen] = useState(false);
  const [archivedHistoryLoading, setArchivedHistoryLoading] = useState(false);
  const [archivedHistoryRows, setArchivedHistoryRows] = useState<
    ChatStoreArchivedRow[]
  >([]);
  const [archivedHistoryError, setArchivedHistoryError] = useState("");
  const [archivedHistoryNextOffset, setArchivedHistoryNextOffset] = useState<
    number | undefined
  >(undefined);
  const [archivedLoadInProgress, setArchivedLoadInProgress] = useState(false);
  const [archivedLoadMode, setArchivedLoadMode] = useState<
    "more" | "all" | null
  >(null);
  const [archivedLoadError, setArchivedLoadError] = useState("");
  const [archivedLoadOffsetByThread, setArchivedLoadOffsetByThread] = useState<
    Record<string, number>
  >({});
  const [archivedLoadDoneByThread, setArchivedLoadDoneByThread] = useState<
    Record<string, boolean>
  >({});
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [maintenanceLoading, setMaintenanceLoading] = useState(false);
  const [maintenanceBusy, setMaintenanceBusy] = useState<string | null>(null);
  const [maintenanceError, setMaintenanceError] = useState("");
  const [maintenanceStatus, setMaintenanceStatus] = useState("");
  const [maintenanceStats, setMaintenanceStats] =
    useState<ChatStoreStats | null>(null);
  const [maintenanceDeleteDays, setMaintenanceDeleteDays] = useState("30");
  const [threadNearTop, setThreadNearTop] = useState(false);
  const anyOverlayOpen = useAnyChatOverlayOpen();
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<any>(null);
  const selectedThreadId = useMemo(
    () => normalizeThreadKey(selectedThreadKey),
    [selectedThreadKey],
  );
  const selectedThreadMeta =
    selectedThreadId != null
      ? actions.getThreadMetadata(selectedThreadId, {
          threadId: selectedThreadId,
        })
      : undefined;
  const archivedRowsCount = (() => {
    const value = selectedThreadMeta?.archived_chat_rows;
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value));
  })();
  const archivedRowsLogRef = useRef<{
    projectId?: string;
    path?: string;
    threadId?: string;
    archivedRowsCount: number;
    selectedThreadMessageCount: number;
  } | null>(null);
  const selectedThreadLookup = selectedThreadId;
  const selectedThreadMessages = useMemo(
    () =>
      selectedThreadLookup != null
        ? (actions.getMessagesInThread(selectedThreadLookup) ?? [])
        : [],
    [actions, selectedThreadLookup, messages],
  );
  const selectedRunningCodexMessage = useMemo(
    () => resolveSelectedThreadRunningCodexMessage(selectedThreadMessages),
    [selectedThreadMessages],
  );
  const selectedRunningCodexDate = useMemo(
    () => dateValue(selectedRunningCodexMessage)?.valueOf(),
    [selectedRunningCodexMessage],
  );
  const selectedRunningAcpStartedAtMs = useMemo(
    () => getAcpStartedAtMs(selectedRunningCodexMessage),
    [selectedRunningCodexMessage],
  );
  const selectedRunningMessageId = useMemo(
    () => field<string>(selectedRunningCodexMessage, "message_id"),
    [selectedRunningCodexMessage],
  );
  const selectedRunningThreadId = useMemo(
    () =>
      field<string>(selectedRunningCodexMessage, "thread_id") ??
      selectedThreadId,
    [selectedRunningCodexMessage, selectedThreadId],
  );
  const selectedRunningThreadRootMs = useMemo(() => {
    if (selectedRunningCodexDate == null) return undefined;
    const root = getThreadRootDate({
      date: selectedRunningCodexDate,
      messages,
    });
    const rootMs =
      root?.valueOf?.() ?? (typeof root === "number" ? root : undefined);
    return Number.isFinite(rootMs)
      ? (rootMs as number)
      : selectedRunningCodexDate;
  }, [messages, selectedRunningCodexDate]);
  const selectedRunningFallbackLogRefs = useMemo(() => {
    const derived =
      project_id && path && selectedRunningThreadId && selectedRunningMessageId
        ? deriveAcpLogRefs({
            project_id,
            path,
            thread_id: selectedRunningThreadId,
            message_id: selectedRunningMessageId,
          })
        : undefined;
    return {
      store: derived?.store,
      key: derived?.key,
      subject: derived?.subject,
      liveStream: derived?.liveStream,
    };
  }, [path, project_id, selectedRunningMessageId, selectedRunningThreadId]);
  const selectedRunningLogStore = useMemo(
    () =>
      field<string>(selectedRunningCodexMessage, "acp_log_store") ??
      selectedRunningFallbackLogRefs.store,
    [selectedRunningCodexMessage, selectedRunningFallbackLogRefs.store],
  );
  const selectedRunningLogKey = useMemo(
    () =>
      field<string>(selectedRunningCodexMessage, "acp_log_key") ??
      selectedRunningFallbackLogRefs.key,
    [selectedRunningCodexMessage, selectedRunningFallbackLogRefs.key],
  );
  const selectedRunningLogSubject = useMemo(
    () =>
      field<string>(selectedRunningCodexMessage, "acp_log_subject") ??
      selectedRunningFallbackLogRefs.subject,
    [selectedRunningCodexMessage, selectedRunningFallbackLogRefs.subject],
  );
  const selectedRunningLiveLogStream = useMemo(
    () =>
      field<string>(selectedRunningCodexMessage, "acp_live_log_stream") ??
      selectedRunningFallbackLogRefs.liveStream,
    [selectedRunningCodexMessage, selectedRunningFallbackLogRefs.liveStream],
  );
  const selectedRunningCodexLog = useCodexLog({
    projectId: project_id,
    logStore: selectedRunningLogStore,
    logKey: selectedRunningLogKey,
    logSubject: selectedRunningLogSubject,
    liveLogStream: selectedRunningLiveLogStream,
    generating: selectedRunningCodexMessage != null,
    enabled: selectedRunningCodexMessage != null,
  });
  const selectedRunningLastActivityAtMs = useMemo(
    () => getLatestCodexActivityAtMs(selectedRunningCodexLog.events),
    [selectedRunningCodexLog.events],
  );
  const selectedRunningSessionIdForInterrupt = useMemo(() => {
    if (!selectedThreadId) return undefined;
    const resolved = resolveAgentSessionIdForThread({
      actions,
      threadId: selectedThreadId,
      threadKey: selectedThreadId,
      persistedSessionId: selectedThreadMeta?.acp_config?.sessionId,
    });
    return (
      field<string>(selectedRunningCodexMessage, "acp_thread_id") ?? resolved
    );
  }, [
    actions,
    selectedRunningCodexMessage,
    selectedThreadId,
    selectedThreadMeta,
  ]);
  const [interruptRequested, setInterruptRequested] = useState(false);
  const threadSearchMatches = useMemo(() => {
    const needle = threadSearchQuery.trim().toLowerCase();
    if (!needle) return [] as string[];
    const matches: string[] = [];
    for (const message of selectedThreadMessages) {
      const text = newest_content(message)
        .replace(/<[^>]*>/g, " ")
        .toLowerCase();
      if (!text.includes(needle)) continue;
      const d = dateValue(message);
      if (!d) continue;
      matches.push(`${d.valueOf()}`);
    }
    return matches;
  }, [threadSearchQuery, selectedThreadMessages]);
  const matchCount = threadSearchMatches.length;
  const normalizedCursor = useMemo(() => {
    if (!matchCount) return 0;
    const c = threadSearchCursor % matchCount;
    return c >= 0 ? c : c + matchCount;
  }, [threadSearchCursor, matchCount]);
  const activeSearchMatchDate = useMemo(
    () =>
      resolveActiveThreadSearchMatchDate({
        threadSearchOpen,
        matchCount,
        normalizedCursor,
        threadSearchMatches,
      }),
    [matchCount, normalizedCursor, threadSearchMatches, threadSearchOpen],
  );
  const threadSearchHighlightQuery = useMemo(
    () =>
      resolveThreadSearchHighlightQuery({
        threadSearchOpen,
        threadSearchQuery,
      }),
    [threadSearchOpen, threadSearchQuery],
  );
  const archivedMatchCount = archivedSearchHits.length;
  const archivedLoadedOffset = selectedThreadId
    ? (archivedLoadOffsetByThread[selectedThreadId] ?? 0)
    : 0;
  const archivedLoadDone = selectedThreadId
    ? !!archivedLoadDoneByThread[selectedThreadId]
    : false;
  const showArchivedBanner =
    !!selectedThreadId &&
    archivedRowsCount > 0 &&
    (threadSearchOpen || threadNearTop);

  useEffect(() => {
    setThreadNearTop(false);
  }, [selectedThreadId]);

  useEffect(() => {
    if (selectedRunningCodexMessage == null) {
      setInterruptRequested(false);
    }
  }, [selectedRunningCodexDate, selectedRunningCodexMessage]);

  const handleInterruptSelectedRunningTurn = useCallback(async () => {
    if (
      interruptRequested ||
      selectedRunningCodexMessage == null ||
      selectedRunningCodexDate == null
    ) {
      return;
    }
    setInterruptRequested(true);
    const ok = await actions.languageModelStopGenerating(
      new Date(selectedRunningCodexDate),
      {
        threadId: selectedRunningSessionIdForInterrupt,
        senderId: field<string>(selectedRunningCodexMessage, "sender_id"),
      },
    );
    if (!ok) {
      setInterruptRequested(false);
      antdMessage.error("Failed to interrupt Codex turn.");
    }
  }, [
    actions,
    interruptRequested,
    selectedRunningCodexDate,
    selectedRunningCodexMessage,
    selectedRunningSessionIdForInterrupt,
  ]);

  const loadArchivedHistory = useCallback(
    async (offset = 0, append = false) => {
      if (!project_id || !path || !selectedThreadId) {
        setArchivedHistoryRows([]);
        setArchivedHistoryNextOffset(undefined);
        return;
      }
      const hubProjects = webapp_client.conat_client?.hub?.projects;
      if (!hubProjects) {
        setArchivedHistoryError("Conat project API is unavailable.");
        setArchivedHistoryRows([]);
        setArchivedHistoryNextOffset(undefined);
        return;
      }
      setArchivedHistoryLoading(true);
      setArchivedHistoryError("");
      try {
        const result = await hubProjects.chatStoreReadArchived({
          project_id,
          chat_path: path,
          thread_id: selectedThreadId,
          limit: ARCHIVED_HISTORY_LIMIT,
          offset,
        });
        setArchivedHistoryRows((prev) =>
          append ? [...prev, ...(result.rows ?? [])] : (result.rows ?? []),
        );
        setArchivedHistoryNextOffset(result.next_offset);
      } catch (err) {
        setArchivedHistoryError(`${err}`);
      } finally {
        setArchivedHistoryLoading(false);
      }
    },
    [project_id, path, selectedThreadId],
  );

  const loadArchivedIntoThread = useCallback(
    async (mode: "more" | "all" = "more") => {
      if (!project_id || !path || !selectedThreadId) {
        setArchivedLoadError("");
        return;
      }
      const hubProjects = webapp_client.conat_client?.hub?.projects;
      if (!hubProjects) {
        setArchivedLoadError("Conat project API is unavailable.");
        return;
      }
      if (archivedLoadInProgress) return;
      const anchorDateMs = (() => {
        const oldestVisible = selectedThreadMessages[0];
        const d = oldestVisible ? dateValue(oldestVisible) : undefined;
        return d ? d.valueOf() : undefined;
      })();
      const startOffset = archivedLoadOffsetByThread[selectedThreadId] ?? 0;
      let offset = startOffset;
      let totalRows = 0;
      let totalApplied = 0;
      let finished = false;
      setArchivedLoadInProgress(true);
      setArchivedLoadMode(mode);
      setArchivedLoadError("");
      try {
        for (let i = 0; i < 200; i++) {
          const result = await hubProjects.chatStoreReadArchived({
            project_id,
            chat_path: path,
            thread_id: selectedThreadId,
            limit: ARCHIVED_HISTORY_LIMIT,
            offset,
          });
          const rows = result.rows ?? [];
          const hydrate = actions.hydrateArchivedRows(
            rows.map((row) => row.row).filter((row) => row != null),
          );
          totalRows += rows.length;
          totalApplied += hydrate.applied;
          if (rows.length === 0 || result.next_offset == null) {
            finished = true;
            break;
          }
          offset = result.next_offset;
          if (mode !== "all") break;
        }
        if (totalRows > 0) {
          const nextOffset = startOffset + totalRows;
          setArchivedLoadOffsetByThread((prev) => ({
            ...prev,
            [selectedThreadId]: nextOffset,
          }));
        }
        if (finished) {
          setArchivedLoadDoneByThread((prev) => ({
            ...prev,
            [selectedThreadId]: true,
          }));
        }
        if (totalRows > 0 && totalApplied === 0) {
          setArchivedLoadError(
            "No additional backend-stored messages were loaded.",
          );
        }
        if (
          totalApplied > 0 &&
          typeof anchorDateMs === "number" &&
          Number.isFinite(anchorDateMs)
        ) {
          setTimeout(() => {
            actions.scrollToDate(anchorDateMs);
          }, 0);
        }
      } catch (err) {
        setArchivedLoadError(`${err}`);
      } finally {
        setArchivedLoadInProgress(false);
        setArchivedLoadMode(null);
      }
    },
    [
      actions,
      archivedLoadInProgress,
      archivedLoadOffsetByThread,
      path,
      project_id,
      selectedThreadMessages,
      selectedThreadId,
    ],
  );

  const openArchivedSearchHit = useCallback(
    async (hit: ChatStoreSearchHit) => {
      if (!project_id || !path) return;
      const hubProjects = webapp_client.conat_client?.hub?.projects;
      if (!hubProjects) return;
      try {
        const hydrated = await hubProjects.chatStoreReadArchivedHit({
          project_id,
          chat_path: path,
          row_id:
            typeof hit.row_id === "number" && Number.isFinite(hit.row_id)
              ? hit.row_id
              : undefined,
          message_id: `${hit.message_id ?? ""}`.trim() || undefined,
          thread_id: `${hit.thread_id ?? ""}`.trim() || undefined,
        });
        const hydratedRow = hydrated?.row?.row;
        if (hydratedRow != null) {
          actions.hydrateArchivedRows([hydratedRow]);
        }
        const hydratedDateMs = Number(
          hydrated?.row?.date_ms ??
            (hydratedRow as any)?.date_ms ??
            hit.date_ms,
        );
        if (!Number.isFinite(hydratedDateMs)) return;
        actions.scrollToDate(hydratedDateMs);
      } catch (err) {
        setArchivedSearchError(`${err}`);
        const fallbackDateMs =
          typeof hit.date_ms === "number" && Number.isFinite(hit.date_ms)
            ? hit.date_ms
            : undefined;
        if (fallbackDateMs == null) return;
        actions.scrollToDate(fallbackDateMs);
      }
    },
    [actions, path, project_id],
  );

  const loadMaintenanceStats = useCallback(async () => {
    if (!project_id || !path) {
      setMaintenanceStats(null);
      return;
    }
    const hubProjects = webapp_client.conat_client?.hub?.projects;
    if (!hubProjects) {
      setMaintenanceError("Conat project API is unavailable.");
      return;
    }
    setMaintenanceLoading(true);
    setMaintenanceError("");
    try {
      const stats = await hubProjects.chatStoreStats({
        project_id,
        chat_path: path,
      });
      setMaintenanceStats(stats);
    } catch (err) {
      setMaintenanceError(`${err}`);
    } finally {
      setMaintenanceLoading(false);
    }
  }, [path, project_id]);

  const runMaintenanceAction = useCallback(
    async (label: string, action: () => Promise<any>) => {
      setMaintenanceBusy(label);
      setMaintenanceError("");
      setMaintenanceStatus("");
      logChatArchiveDiagnostic("maintenance started", {
        action: label,
        project_id,
        chat_path: path,
        thread_id: selectedThreadId,
        archived_chat_rows: archivedRowsCount,
      });
      try {
        const result = await action();
        logChatArchiveDiagnostic("maintenance finished", {
          action: label,
          project_id,
          chat_path: path,
          thread_id: selectedThreadId,
          archived_chat_rows: archivedRowsCount,
          result,
        });
        setMaintenanceStatus(
          typeof result?.reason === "string" && result.reason.trim().length > 0
            ? `${label}: ${result.reason}`
            : `${label}: complete`,
        );
        await loadMaintenanceStats();
      } catch (err) {
        logChatArchiveDiagnostic("maintenance failed", {
          action: label,
          project_id,
          chat_path: path,
          thread_id: selectedThreadId,
          archived_chat_rows: archivedRowsCount,
          error: `${err}`,
        });
        setMaintenanceError(`${err}`);
      } finally {
        setMaintenanceBusy(null);
      }
    },
    [
      archivedRowsCount,
      loadMaintenanceStats,
      path,
      project_id,
      selectedThreadId,
    ],
  );

  const setSearchQueryDebounced = useMemo(
    () =>
      debounce((value: string) => {
        setThreadSearchQuery(value);
      }, 300),
    [],
  );

  useEffect(() => {
    return () => {
      setSearchQueryDebounced.cancel();
    };
  }, [setSearchQueryDebounced]);

  useEffect(() => {
    if (!project_id || !path || !selectedThreadId) {
      archivedRowsLogRef.current = null;
      return;
    }
    const next = {
      projectId: project_id,
      path,
      threadId: selectedThreadId,
      archivedRowsCount,
      selectedThreadMessageCount: selectedThreadMessages.length,
    };
    const prev = archivedRowsLogRef.current;
    archivedRowsLogRef.current = next;
    if (prev == null) return;
    if (
      prev.projectId !== project_id ||
      prev.path !== path ||
      prev.threadId !== selectedThreadId
    ) {
      return;
    }
    if (prev.archivedRowsCount !== archivedRowsCount) {
      logChatArchiveDiagnostic("archived row count changed", {
        project_id,
        chat_path: path,
        thread_id: selectedThreadId,
        previous_archived_chat_rows: prev.archivedRowsCount,
        archived_chat_rows: archivedRowsCount,
        delta_archived_chat_rows: archivedRowsCount - prev.archivedRowsCount,
        previous_visible_thread_rows: prev.selectedThreadMessageCount,
        visible_thread_rows: selectedThreadMessages.length,
      });
    }
    if (
      archivedRowsCount > prev.archivedRowsCount &&
      selectedThreadMessages.length < prev.selectedThreadMessageCount
    ) {
      logChatArchiveDiagnostic("possible archive head rewrite observed", {
        project_id,
        chat_path: path,
        thread_id: selectedThreadId,
        previous_archived_chat_rows: prev.archivedRowsCount,
        archived_chat_rows: archivedRowsCount,
        previous_visible_thread_rows: prev.selectedThreadMessageCount,
        visible_thread_rows: selectedThreadMessages.length,
        removed_visible_thread_rows:
          prev.selectedThreadMessageCount - selectedThreadMessages.length,
      });
    }
  }, [
    archivedRowsCount,
    path,
    project_id,
    selectedThreadId,
    selectedThreadMessages.length,
  ]);

  useEffect(() => {
    setThreadSearchCursor(0);
  }, [threadSearchQuery, selectedThreadKey]);

  useEffect(() => {
    setThreadSearchInput("");
    setThreadSearchQuery("");
    setThreadSearchOpen(false);
    setArchivedSearchHits([]);
    setArchivedSearchTotal(0);
    setArchivedSearchError("");
    setArchivedHistoryRows([]);
    setArchivedHistoryError("");
    setArchivedHistoryNextOffset(undefined);
    setArchivedHistoryOpen(false);
    setArchivedLoadError("");
  }, [selectedThreadKey]);

  useEffect(() => {
    if (!matchCount) return;
    if (threadSearchCursor >= matchCount) {
      setThreadSearchCursor(matchCount - 1);
    }
  }, [threadSearchCursor, matchCount]);

  useEffect(() => {
    if (!activeSearchMatchDate) return;
    setThreadSearchJumpToken((n) => n + 1);
  }, [activeSearchMatchDate]);

  useEffect(() => {
    const query = threadSearchQuery.trim();
    if (
      !threadSearchOpen ||
      !query ||
      !project_id ||
      !path ||
      !selectedThreadId
    ) {
      setArchivedSearchLoading(false);
      setArchivedSearchHits([]);
      setArchivedSearchTotal(0);
      setArchivedSearchError("");
      return;
    }
    let canceled = false;
    setArchivedSearchLoading(true);
    setArchivedSearchError("");
    void (async () => {
      const hubProjects = webapp_client.conat_client?.hub?.projects;
      if (!hubProjects) {
        setArchivedSearchLoading(false);
        setArchivedSearchHits([]);
        setArchivedSearchTotal(0);
        setArchivedSearchError("Conat project API is unavailable.");
        return;
      }
      try {
        const result = await hubProjects.chatStoreSearch({
          project_id,
          chat_path: path,
          query,
          thread_id: selectedThreadId,
          limit: ARCHIVED_SEARCH_LIMIT,
          offset: 0,
        });
        if (canceled) return;
        setArchivedSearchHits(result.hits ?? []);
        setArchivedSearchTotal(
          parseArchivedTotalCount(result, (result.hits ?? []).length),
        );
      } catch (err) {
        if (canceled) return;
        setArchivedSearchHits([]);
        setArchivedSearchTotal(0);
        setArchivedSearchError(`${err}`);
      } finally {
        if (!canceled) {
          setArchivedSearchLoading(false);
        }
      }
    })();
    return () => {
      canceled = true;
    };
  }, [threadSearchOpen, threadSearchQuery, project_id, path, selectedThreadId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !shouldOpenThreadSearchShortcut(event, anyOverlayOpen, shortcutEnabled)
      ) {
        return;
      }
      if (!chatPanelOwnsThreadSearchShortcut(panelRef.current, event)) return;
      event.preventDefault();
      setThreadSearchOpen(true);
      setTimeout(() => {
        searchInputRef.current?.focus?.();
      }, 0);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [anyOverlayOpen, shortcutEnabled]);

  const onSearchInputChange = (value: string) => {
    setThreadSearchInput(value);
    if (!value.trim()) {
      setSearchQueryDebounced.cancel();
      setThreadSearchQuery("");
      return;
    }
    setSearchQueryDebounced(value);
  };
  if (!selectedThreadKey) {
    type ModelOption = {
      value: string;
      label: string;
      description?: string;
      reasoning?: CodexReasoningLevel[];
    };
    const update = (patch: Partial<NewThreadSetup>) =>
      onNewThreadSetupChange((current) =>
        applyNewThreadSetupPatch(current, patch),
      );
    const codexModel = newThreadSetup.codexConfig.model ?? DEFAULT_CODEX_MODEL;
    const codexModelOptions: ModelOption[] = DEFAULT_CODEX_MODELS.map(
      (model) => ({
        value: model.name,
        label: model.name,
        description: model.description,
        reasoning: model.reasoning,
      }),
    );
    const codexReasoningOptions = (
      codexModelOptions.find((model) => model.value === codexModel)
        ?.reasoning ?? []
    ).map((r) => ({
      value: r.id,
      label: r.label,
      description: r.description,
      default: r.default,
    }));
    const stagedCodexDefaults = {
      model: codexModel,
      reasoning: getReasoningForModel({
        modelValue: codexModel,
        desired: newThreadSetup.codexConfig.reasoning,
      }),
      sessionMode:
        normalizeSessionMode(newThreadSetup.codexConfig) ?? defaultSessionMode,
    };
    const stagedCodexMatchesDefault = codexNewChatDefaultsEqual(
      stagedCodexDefaults,
      defaultNewChatCodexDefaults,
    );
    const shouldHideChatType = hideChatTypeSelector;
    const automationDraft = buildAutomationDraft({
      config: newThreadSetup.automationConfig,
      enabled: newThreadSetup.automationConfig?.enabled === true,
      allowCodexRunKind: newThreadSetup.agentMode === "codex",
    });
    const automationEnabled = automationDraft.enabled === true;
    return (
      <div
        ref={panelRef}
        className="smc-vfill"
        style={{
          ...CHAT_LOG_STYLE,
          overflowY: "auto",
          padding: "14px 10px",
        }}
      >
        <div style={SETUP_CARD_STYLE}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 6,
            }}
          >
            <div style={{ fontWeight: 600 }}>New chat setup</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: COLORS.GRAY_D, fontSize: 13 }}>
                Automation
              </span>
              <Switch
                checked={automationEnabled}
                onChange={(checked) =>
                  update({
                    automationConfig: {
                      ...automationDraft,
                      enabled: checked,
                    },
                  })
                }
              />
            </div>
          </div>
          <div style={{ color: "#666", marginBottom: 14, fontSize: 13 }}>
            All fields are optional and can be edited later from settings. Codex
            is selected by default.
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
              marginBottom: 12,
            }}
          >
            <div>
              <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>Title</div>
              <Input
                placeholder="Optional title"
                value={newThreadSetup.title}
                onChange={(e) => update({ title: e.target.value })}
              />
            </div>
            <div>
              {!shouldHideChatType ? (
                <>
                  <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                    Chat type
                  </div>
                  <Select
                    value={newThreadSetup.agentMode}
                    style={{ width: "100%" }}
                    onChange={(value) => {
                      const mode = value as NewThreadAgentMode;
                      if (mode === "codex") {
                        const model = isCodexModelName(newThreadSetup.model)
                          ? newThreadSetup.model
                          : DEFAULT_CODEX_MODEL;
                        update({
                          agentMode: mode,
                          automationConfig: buildAutomationDraft({
                            config: newThreadSetup.automationConfig,
                            enabled:
                              newThreadSetup.automationConfig?.enabled === true,
                            allowCodexRunKind: true,
                          }),
                          model,
                          codexConfig: {
                            ...newThreadSetup.codexConfig,
                            model,
                            sessionMode:
                              normalizeSessionMode(
                                newThreadSetup.codexConfig,
                              ) ?? defaultSessionMode,
                            reasoning: getReasoningForModel({
                              modelValue: model,
                              desired: newThreadSetup.codexConfig.reasoning,
                            }),
                          },
                        });
                        return;
                      }
                      update({
                        agentMode: mode,
                        automationConfig: buildAutomationDraft({
                          config: newThreadSetup.automationConfig,
                          enabled:
                            newThreadSetup.automationConfig?.enabled === true,
                          allowCodexRunKind: false,
                        }),
                      });
                    }}
                    options={[
                      { value: "codex", label: "Codex (agent)" },
                      { value: "human", label: "Human only" },
                    ]}
                  />
                </>
              ) : null}
            </div>
            <div>
              <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>Icon</div>
              <ChatIconPicker
                value={newThreadSetup.icon}
                onChange={(value) =>
                  update({ icon: value ? String(value) : undefined })
                }
                modalTitle="Select Chat Icon"
                placeholder="Optional icon"
              />
            </div>
            <div>
              <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>Color</div>
              <Space>
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    background: newThreadSetup.color ?? COLORS.GRAY_L,
                    border: `1px solid ${COLORS.GRAY_L}`,
                  }}
                />
                <ColorButton
                  onChange={(value) => update({ color: value })}
                  title="Select chat color"
                />
                <Button
                  size="small"
                  onClick={() => update({ color: undefined })}
                >
                  Clear
                </Button>
              </Space>
            </div>
          </div>
          {newThreadSetup.agentMode === "codex" && (
            <>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: 12,
                  marginBottom: 12,
                }}
              >
                <div>
                  <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                    Codex model
                  </div>
                  <Select
                    value={codexModel}
                    style={{ width: "100%" }}
                    options={codexModelOptions}
                    optionRender={(option) =>
                      renderOptionWithDescription({
                        title: `${option.data.label}`,
                        description: option.data.description,
                      })
                    }
                    showSearch
                    optionFilterProp="label"
                    onChange={(value) => {
                      const model = String(value);
                      update({
                        model,
                        codexConfig: {
                          ...newThreadSetup.codexConfig,
                          model,
                          reasoning: getReasoningForModel({
                            modelValue: model,
                            desired: newThreadSetup.codexConfig.reasoning,
                          }),
                        },
                      });
                    }}
                  />
                </div>
                <div>
                  <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                    Reasoning
                  </div>
                  <Select
                    allowClear
                    value={newThreadSetup.codexConfig.reasoning}
                    style={{ width: "100%" }}
                    options={codexReasoningOptions}
                    optionRender={(option) =>
                      renderOptionWithDescription({
                        title: `${option.data.label}${
                          option.data.default ? " (default)" : ""
                        }`,
                        description: option.data.description,
                      })
                    }
                    onChange={(value) =>
                      update({
                        codexConfig: {
                          ...newThreadSetup.codexConfig,
                          reasoning: value as CodexReasoningId,
                        },
                      })
                    }
                  />
                </div>
                <div>
                  <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                    Execution mode
                  </div>
                  <Select
                    value={
                      normalizeSessionMode(newThreadSetup.codexConfig) ??
                      defaultSessionMode
                    }
                    style={{ width: "100%" }}
                    options={getCodexNewChatModeOptions()}
                    onChange={(value) =>
                      update({
                        codexConfig: {
                          ...newThreadSetup.codexConfig,
                          sessionMode: value as CodexSessionMode,
                        },
                      })
                    }
                  />
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  marginBottom: 12,
                }}
              >
                <span style={{ color: COLORS.GRAY_D, fontSize: 13 }}>
                  Save this Codex setup as the default for future new chats.
                </span>
                {stagedCodexMatchesDefault ? (
                  <Button size="small" type="text" disabled>
                    Default for new chats
                  </Button>
                ) : (
                  <Button
                    size="small"
                    onClick={() =>
                      saveCodexNewChatDefaults(stagedCodexDefaults)
                    }
                  >
                    Make default
                  </Button>
                )}
              </div>
            </>
          )}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {(newThreadSetup.icon || newThreadSetup.color) && (
                <ThreadBadge
                  icon={newThreadSetup.icon}
                  color={newThreadSetup.color}
                  image={newThreadSetup.image}
                  size={20}
                />
              )}
              <span style={{ color: "#666", fontSize: 13 }}>
                {threadsCount === 0
                  ? "No chats yet. Create the chat now, or send a first message below if you want."
                  : "Use these defaults for the next new chat you create or send."}
              </span>
            </div>
            <Space>
              <Button size="small" onClick={onNewChat}>
                Reset
              </Button>
              <Button type="primary" onClick={() => void onCreateThread()}>
                {automationEnabled ? "Create automation chat" : "Create chat"}
              </Button>
            </Space>
          </div>
        </div>
        {automationEnabled ? (
          <div
            style={{
              ...SETUP_CARD_STYLE,
              marginTop: 32,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              New automation setup
            </div>
            <div style={{ color: "#666", marginBottom: 14, fontSize: 13 }}>
              Configure the next new chat as a scheduled automation. Codex
              threads can run prompts or commands; non-Codex threads can run
              commands. Once created, it will live in the Automations section
              and can still be edited from thread settings later.
            </div>
            <AutomationConfigFields
              draft={automationDraft}
              allowCodexRunKind={newThreadSetup.agentMode === "codex"}
              showEnableToggle={false}
              onChange={(patch) =>
                update({
                  automationConfig: {
                    ...automationDraft,
                    ...patch,
                  },
                })
              }
            />
          </div>
        ) : null}
      </div>
    );
  }

  const shouldShowCodexConfig = Boolean(
    selectedThreadId &&
    (selectedThreadMeta?.agent_kind === "acp" ||
      selectedThreadMeta?.acp_config != null ||
      isCodexModelName(`${selectedThreadMeta?.agent_model ?? ""}`) ||
      actions?.getCodexConfig?.(selectedThreadId) != null),
  );
  const showTopControls = shouldShowCodexConfig || allowSidebarToggle;
  const selectedThreadForLog = selectedThreadKey ?? undefined;
  const threadMeta =
    selectedThread && "displayLabel" in selectedThread
      ? selectedThread
      : undefined;
  const compactThreadLabel = threadMeta?.displayLabel ?? selectedThread?.label;
  const compactThreadIcon = threadMeta?.threadIcon;
  const compactThreadImage = threadMeta?.threadImage;
  const compactThreadHasAppearance = threadMeta?.hasCustomAppearance ?? false;
  const compactThreadThemeLineColor =
    threadMeta?.threadColor ?? threadMeta?.threadAccentColor;
  const {
    badgeColor: compactThreadBadgeColor,
    badgeSize: compactThreadBadgeSize,
  } = resolveCompactThreadBadgeAppearance({
    thread: threadMeta,
    acpState,
    activityNow: Date.now(),
  });
  const threadImagePreview = showThreadImagePreview
    ? compactThreadImage?.trim()
    : undefined;
  const runningStatusTop = showTopControls ? 52 : 8;
  const contentTopInset =
    (showTopControls ? 44 : 0) + (selectedRunningCodexMessage ? 56 : 0);

  return (
    <div
      ref={panelRef}
      className="smc-vfill"
      style={{
        ...CHAT_LOG_STYLE,
        position: "relative",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {showTopControls && (
        <div style={{ position: "absolute", top: 8, left: 8, zIndex: 10 }}>
          <Space size={6}>
            {allowSidebarToggle ? (
              <Tooltip
                title={
                  sidebarHidden ? "Show chats sidebar" : "Hide chats sidebar"
                }
              >
                <Button
                  size="small"
                  type="text"
                  aria-label={
                    sidebarHidden ? "Show chats sidebar" : "Hide chats sidebar"
                  }
                  icon={
                    <Icon
                      name={sidebarHidden ? "chevron-right" : "chevron-left"}
                    />
                  }
                  onClick={onToggleSidebar}
                />
              </Tooltip>
            ) : null}
            {shouldShowCodexConfig ? (
              <CodexConfigButton
                threadKey={selectedThreadKey}
                chatPath={path ?? ""}
                projectId={project_id}
                actions={actions}
                threadConfig={selectedThreadMeta?.acp_config ?? null}
                paymentSource={codexPaymentSource}
                paymentSourceLoading={codexPaymentSourceLoading}
                refreshPaymentSource={refreshCodexPaymentSource}
              />
            ) : null}
          </Space>
        </div>
      )}
      {selectedRunningCodexMessage != null &&
      selectedRunningCodexDate != null ? (
        <div
          style={{
            position: "absolute",
            top: runningStatusTop,
            left: 8,
            right: threadImagePreview ? 112 : 8,
            zIndex: 10,
            pointerEvents: "none",
          }}
        >
          <div style={{ pointerEvents: "auto" }}>
            <AgentMessageStatus
              show={true}
              generating={true}
              durationLabel=""
              lastActivityAtMs={selectedRunningLastActivityAtMs}
              startedAtMs={selectedRunningAcpStartedAtMs}
              fontSize={fontSize}
              project_id={project_id}
              path={path}
              activityBasePath={
                selectedThreadMeta?.acp_config?.workingDirectory
              }
              date={selectedRunningCodexDate}
              logRefs={{
                store: selectedRunningLogStore,
                key: selectedRunningLogKey,
                subject: selectedRunningLogSubject,
                liveStream: selectedRunningLiveLogStream,
              }}
              activityContext={{
                actions,
                message: selectedRunningCodexMessage,
                messages,
                threadRootMs: selectedRunningThreadRootMs,
                threadId: selectedRunningThreadId,
                project_id,
                path,
              }}
              logEvents={selectedRunningCodexLog.events}
              deleteLog={selectedRunningCodexLog.deleteLog}
              notifyOnTurnFinish={notifyOnTurnFinish}
              onNotifyOnTurnFinishChange={onNotifyOnTurnFinishChange}
              interruptRequested={interruptRequested}
              onInterrupt={handleInterruptSelectedRunningTurn}
            />
          </div>
        </div>
      ) : null}
      {threadImagePreview ? (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 16,
            zIndex: 10,
            borderRadius: 10,
            overflow: "hidden",
            border: "1px solid #ddd",
            background: "white",
            boxShadow: "0 1px 8px rgba(0,0,0,0.12)",
          }}
        >
          <img
            src={threadImagePreview}
            alt="Chat image"
            style={{
              width: 84,
              height: 84,
              objectFit: "cover",
              display: "block",
            }}
          />
        </div>
      ) : null}
      {variant === "compact" && compactThreadLabel && (
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid #e5e5e5",
            background: "#f7f7f7",
            color: "#555",
            fontWeight: 600,
            fontSize: "12px",
            letterSpacing: "0.02em",
            textTransform: "uppercase",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            borderLeft: compactThreadThemeLineColor
              ? `3px solid ${compactThreadThemeLineColor}`
              : undefined,
            paddingLeft: compactThreadThemeLineColor ? 10 : 12,
          }}
        >
          {compactThreadHasAppearance && (
            <ThreadBadge
              icon={compactThreadIcon}
              color={compactThreadBadgeColor}
              accentColor={threadMeta?.threadAccentColor}
              image={compactThreadImage}
              size={compactThreadBadgeSize}
            />
          )}
          {compactThreadLabel}
        </div>
      )}
      <div
        style={{
          position: "absolute",
          top: 8,
          right: threadImagePreview ? 116 : 12,
          zIndex: 20,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Tooltip title="Search thread (Ctrl/Cmd+F)">
          <Button
            size="small"
            onClick={() => {
              setThreadSearchOpen((open) => {
                const next = !open;
                if (next) {
                  setTimeout(() => searchInputRef.current?.focus?.(), 0);
                }
                return next;
              });
            }}
            icon={<Icon name="search" />}
          >
            Search
          </Button>
        </Tooltip>
      </div>
      {threadSearchOpen ? (
        <div
          style={{
            position: "absolute",
            top: 44,
            right: threadImagePreview ? 116 : 12,
            zIndex: 21,
            padding: "10px",
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            gap: 8,
            background: "rgba(250,250,250,0.98)",
            border: "1px solid #ddd",
            borderRadius: 8,
            boxShadow: "0 2px 10px rgba(0,0,0,0.12)",
            width: "min(90vw, 350px)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Input
              ref={searchInputRef}
              size="small"
              allowClear
              placeholder={
                selectedThreadId
                  ? "Find in this thread"
                  : "Select a thread to search"
              }
              value={threadSearchInput}
              onChange={(e) => onSearchInputChange(e.target.value)}
              onPressEnter={() => {
                if (!matchCount) return;
                setThreadSearchCursor((n) => n + 1);
              }}
              style={{ flex: 1, minWidth: 180 }}
              disabled={!selectedThreadId}
            />
            <Button
              size="small"
              type="text"
              onClick={() => setThreadSearchOpen(false)}
            >
              ×
            </Button>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <div
              style={{ display: "inline-flex", gap: 8, whiteSpace: "nowrap" }}
            >
              <Button
                size="small"
                disabled={!selectedThreadId || !matchCount}
                onClick={() => setThreadSearchCursor((n) => n - 1)}
              >
                Prev
              </Button>
              <Button
                size="small"
                disabled={!selectedThreadId || !matchCount}
                onClick={() => setThreadSearchCursor((n) => n + 1)}
              >
                Next
              </Button>
            </div>
            <Button
              size="small"
              disabled={!selectedThreadId || !project_id || !path}
              onClick={() => {
                setArchivedHistoryOpen(true);
                void loadArchivedHistory(0, false);
              }}
            >
              History
            </Button>
            <Button
              size="small"
              disabled={!project_id || !path}
              onClick={() => {
                setMaintenanceOpen(true);
                void loadMaintenanceStats();
              }}
            >
              Maintenance
            </Button>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              color: "#666",
              fontSize: 12,
              borderTop: "1px solid #efefef",
              paddingTop: 6,
            }}
          >
            <span>
              {!selectedThreadId
                ? "Select a thread to search"
                : matchCount
                  ? `Loaded: ${matchCount} hits (${normalizedCursor + 1}/${matchCount})`
                  : "Loaded: 0 hits"}
            </span>
            {selectedThreadId && threadSearchQuery.trim().length > 0 ? (
              <span>
                {archivedSearchLoading
                  ? "Stored on backend: searching..."
                  : archivedSearchError
                    ? "Stored on backend: error"
                    : `Stored on backend: ${archivedSearchTotal} hits (${Math.min(
                        ARCHIVED_INLINE_PREVIEW_LIMIT,
                        archivedMatchCount,
                      )} shown)`}
              </span>
            ) : null}
          </div>
          {selectedThreadId && threadSearchQuery.trim().length > 0 ? (
            <div
              style={{
                width: "100%",
                maxHeight: 160,
                overflowY: "auto",
                borderTop: "1px solid #e6e6e6",
                paddingTop: 6,
                color: "#555",
                fontSize: 12,
              }}
            >
              {archivedSearchLoading ? (
                <div>Searching backend-stored history…</div>
              ) : archivedSearchError ? (
                <div style={{ color: "#b71c1c" }}>{archivedSearchError}</div>
              ) : archivedSearchHits.length === 0 ? (
                <div>No matches in backend-stored history.</div>
              ) : (
                archivedSearchHits
                  .slice(0, ARCHIVED_INLINE_PREVIEW_LIMIT)
                  .map((hit) => {
                    const when =
                      typeof hit.date_ms === "number"
                        ? new Date(hit.date_ms).toLocaleString()
                        : "";
                    const text = (hit.snippet ?? hit.excerpt ?? "")
                      .replace(/<[^>]*>/g, " ")
                      .replace(/\s+/g, " ")
                      .trim();
                    return (
                      <div
                        key={`${hit.segment_id}:${hit.row_id}`}
                        style={{
                          marginBottom: 6,
                          lineHeight: "16px",
                          cursor:
                            typeof hit.date_ms === "number"
                              ? "pointer"
                              : "default",
                        }}
                        onClick={() => {
                          void openArchivedSearchHit(hit);
                        }}
                      >
                        <div style={{ fontSize: 11, color: "#888" }}>
                          {when}
                        </div>
                        <div>{text || "(no preview)"}</div>
                      </div>
                    );
                  })
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      <Modal
        title="Older thread history (stored on backend)"
        open={archivedHistoryOpen}
        width={680}
        onCancel={() => setArchivedHistoryOpen(false)}
        footer={[
          <Button key="close" onClick={() => setArchivedHistoryOpen(false)}>
            Close
          </Button>,
          <Button
            key="more"
            onClick={() => {
              if (archivedHistoryNextOffset == null) return;
              void loadArchivedHistory(archivedHistoryNextOffset, true);
            }}
            disabled={
              archivedHistoryLoading || archivedHistoryNextOffset == null
            }
          >
            Load more
          </Button>,
        ]}
      >
        <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
          {archivedHistoryLoading && archivedHistoryRows.length === 0 ? (
            <div style={{ color: "#666" }}>Loading backend history…</div>
          ) : archivedHistoryError ? (
            <div style={{ color: "#b71c1c" }}>{archivedHistoryError}</div>
          ) : archivedHistoryRows.length === 0 ? (
            <div style={{ color: "#666" }}>
              No backend-stored rows for this thread.
            </div>
          ) : (
            archivedHistoryRows.map((row) => {
              const when =
                typeof row.date_ms === "number"
                  ? new Date(row.date_ms).toLocaleString()
                  : "(unknown time)";
              const text = (row.excerpt ?? "")
                .replace(/<[^>]*>/g, " ")
                .replace(/\s+/g, " ")
                .trim();
              return (
                <div
                  key={`${row.segment_id}:${row.row_id}`}
                  style={{
                    borderBottom: "1px solid #f0f0f0",
                    padding: "8px 0",
                    fontSize: 12,
                  }}
                >
                  <div style={{ color: "#888", marginBottom: 2 }}>{when}</div>
                  <div style={{ color: "#333" }}>{text || "(no preview)"}</div>
                </div>
              );
            })
          )}
        </div>
      </Modal>
      <Modal
        title={
          <Space size={8}>
            <span>Chat Store Maintenance</span>
            <Popover
              trigger={["hover", "click"]}
              placement="bottomLeft"
              content={
                <div style={{ maxWidth: 520, fontSize: 12, lineHeight: 1.5 }}>
                  <div style={{ marginBottom: 8 }}>
                    <b>Storage model</b>: recent messages stay in this chat file
                    (the realtime head), while older messages are stored in the
                    backend SQLite chat store for scalability.
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <b>Head</b> stats are what remains in the chat file right
                    now.
                    <b> Stored</b> stats are historical rows kept in backend
                    storage.
                  </div>
                  <div style={{ marginBottom: 4 }}>
                    <b>Actions</b>:
                  </div>
                  <div>Refresh Stats: reload current counts/bytes.</div>
                  <div>
                    Rotate Now: move older head rows into backend storage.
                  </div>
                  <div>
                    Vacuum: compact the SQLite file and reclaim disk space.
                  </div>
                  <div>
                    Delete This Chat (Stored): delete backend-stored rows for
                    the selected chat thread only.
                  </div>
                  <div>
                    Delete Older Than N Days: delete backend-stored rows older
                    than a cutoff date.
                  </div>
                  <div>
                    Delete All Stored Rows: delete all backend-stored rows for
                    this chat file.
                  </div>
                  <div style={{ marginTop: 8 }}>
                    These actions only affect backend-stored rows; they do not
                    edit currently loaded head messages in the chat file.
                  </div>
                </div>
              }
            >
              <Button
                size="small"
                shape="circle"
                style={{ width: 20, minWidth: 20 }}
              >
                ?
              </Button>
            </Popover>
          </Space>
        }
        open={maintenanceOpen}
        width={700}
        onCancel={() => setMaintenanceOpen(false)}
        footer={[
          <Button key="close" onClick={() => setMaintenanceOpen(false)}>
            Close
          </Button>,
        ]}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 16,
              color: "#444",
              fontSize: 13,
            }}
          >
            <span>Head rows: {maintenanceStats?.head_rows ?? "?"}</span>
            <span>
              Head chat rows: {maintenanceStats?.head_chat_rows ?? "?"}
            </span>
            <span>Head bytes: {formatBytes(maintenanceStats?.head_bytes)}</span>
            <span>Stored rows: {maintenanceStats?.archived_rows ?? "?"}</span>
            <span>
              Stored bytes: {formatBytes(maintenanceStats?.archived_bytes)}
            </span>
            <span>Segments: {maintenanceStats?.segments ?? "?"}</span>
            {maintenanceStats?.pending_rotate_status ? (
              <span>
                Pending rotate: {maintenanceStats.pending_rotate_status}
              </span>
            ) : null}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Button
              size="small"
              loading={maintenanceLoading}
              disabled={maintenanceBusy != null}
              onClick={() => {
                void loadMaintenanceStats();
              }}
            >
              Refresh Stats
            </Button>
            <Button
              size="small"
              loading={maintenanceBusy === "Rotate now"}
              disabled={!project_id || !path || maintenanceBusy != null}
              onClick={() => {
                const hubProjects = webapp_client.conat_client?.hub?.projects;
                if (!hubProjects) return;
                void runMaintenanceAction("Rotate now", () =>
                  hubProjects.chatStoreRotate({
                    project_id: project_id!,
                    chat_path: path!,
                    force: true,
                    require_idle: false,
                  }),
                );
              }}
            >
              Rotate Now
            </Button>
            <Button
              size="small"
              loading={maintenanceBusy === "Vacuum"}
              disabled={!project_id || !path || maintenanceBusy != null}
              onClick={() => {
                const hubProjects = webapp_client.conat_client?.hub?.projects;
                if (!hubProjects) return;
                void runMaintenanceAction("Vacuum", () =>
                  hubProjects.chatStoreVacuum({
                    project_id: project_id!,
                    chat_path: path!,
                  }),
                );
              }}
            >
              Vacuum
            </Button>
            <Button
              size="small"
              danger
              loading={maintenanceBusy === "Delete Thread Scope"}
              disabled={
                !project_id ||
                !path ||
                !selectedThreadId ||
                maintenanceBusy != null
              }
              onClick={() => {
                if (
                  !window.confirm(
                    "Delete backend-stored rows for the current chat only?",
                  )
                ) {
                  return;
                }
                const hubProjects = webapp_client.conat_client?.hub?.projects;
                if (!hubProjects || !selectedThreadId) return;
                void runMaintenanceAction("Delete Thread Scope", () =>
                  hubProjects.chatStoreDelete({
                    project_id: project_id!,
                    chat_path: path!,
                    scope: "thread",
                    thread_id: selectedThreadId,
                  }),
                );
              }}
            >
              Delete This Chat (Stored)
            </Button>
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
            }}
          >
            <Input
              size="small"
              value={maintenanceDeleteDays}
              onChange={(e) => setMaintenanceDeleteDays(e.target.value)}
              style={{ width: 120 }}
              placeholder="Days"
            />
            <Button
              size="small"
              danger
              loading={maintenanceBusy === "Delete Older Scope"}
              disabled={!project_id || !path || maintenanceBusy != null}
              onClick={() => {
                const days = Number(maintenanceDeleteDays);
                if (!Number.isFinite(days) || days <= 0) {
                  setMaintenanceError(
                    "Delete older: days must be a positive number.",
                  );
                  return;
                }
                if (
                  !window.confirm(
                    `Delete backend-stored rows older than ${Math.floor(days)} days?`,
                  )
                ) {
                  return;
                }
                const hubProjects = webapp_client.conat_client?.hub?.projects;
                if (!hubProjects) return;
                const before_date_ms =
                  Date.now() - Math.floor(days) * 24 * 60 * 60 * 1000;
                void runMaintenanceAction("Delete Older Scope", () =>
                  hubProjects.chatStoreDelete({
                    project_id: project_id!,
                    chat_path: path!,
                    scope: "before_date",
                    before_date_ms,
                  }),
                );
              }}
            >
              Delete Older Than N Days
            </Button>
            <Button
              size="small"
              danger
              loading={maintenanceBusy === "Delete All Stored"}
              disabled={!project_id || !path || maintenanceBusy != null}
              onClick={() => {
                if (
                  !window.confirm(
                    "Delete all backend-stored rows for this chat file?",
                  )
                ) {
                  return;
                }
                const hubProjects = webapp_client.conat_client?.hub?.projects;
                if (!hubProjects) return;
                void runMaintenanceAction("Delete All Stored", () =>
                  hubProjects.chatStoreDelete({
                    project_id: project_id!,
                    chat_path: path!,
                    scope: "chat",
                  }),
                );
              }}
            >
              Delete All Stored Rows
            </Button>
          </div>
          {maintenanceStatus ? (
            <div style={{ color: "#1b5e20", fontSize: 12 }}>
              {maintenanceStatus}
            </div>
          ) : null}
          {maintenanceError ? (
            <div style={{ color: "#b71c1c", fontSize: 12 }}>
              {maintenanceError}
            </div>
          ) : null}
        </div>
      </Modal>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: "1 1 0",
          minHeight: 0,
          paddingTop: contentTopInset,
        }}
      >
        {showArchivedBanner ? (
          <div
            style={{
              margin: "8px 12px 0 12px",
              padding: "8px 10px",
              border: "1px solid #ffe58f",
              background: "#fffbe6",
              borderRadius: 8,
              color: "#8a6d3b",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 6,
              zIndex: 1,
            }}
          >
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              {archivedRowsCount.toLocaleString()} older message
              {archivedRowsCount === 1 ? "" : "s"} stored on backend
              {archivedLoadedOffset > 0 ? (
                <> ({archivedLoadedOffset.toLocaleString()} loaded)</>
              ) : (
                "."
              )}
              <Button
                size="small"
                type="link"
                style={{ padding: 0, height: "auto" }}
                onClick={() => {
                  void loadArchivedIntoThread();
                }}
                disabled={archivedLoadInProgress || archivedLoadDone}
              >
                {archivedLoadInProgress
                  ? "Loading..."
                  : archivedLoadDone
                    ? "All loaded"
                    : "Load more"}
              </Button>
              <Button
                size="small"
                type="link"
                style={{ padding: 0, height: "auto" }}
                onClick={() => {
                  void loadArchivedIntoThread("all");
                }}
                disabled={archivedLoadInProgress || archivedLoadDone}
              >
                {archivedLoadInProgress && archivedLoadMode === "all"
                  ? "Loading all..."
                  : "Load all"}
              </Button>
              <Button
                size="small"
                type="link"
                style={{ padding: 0, height: "auto" }}
                onClick={() => {
                  setArchivedHistoryOpen(true);
                  void loadArchivedHistory(0, false);
                }}
              >
                Preview
              </Button>
            </span>
          </div>
        ) : null}
        {selectedThreadId && archivedLoadError ? (
          <div
            style={{
              margin: "6px 12px 0 12px",
              color: "#b71c1c",
              fontSize: 12,
            }}
          >
            {archivedLoadError}
          </div>
        ) : null}
        <ChatLog
          actions={actions}
          project_id={project_id ?? ""}
          path={path ?? ""}
          messages={messages}
          threadIndex={threadIndex}
          acpState={acpState}
          scrollToBottomRef={scrollToBottomRef}
          scrollCacheId={scrollCacheId}
          mode={variant === "compact" ? "sidechat" : "standalone"}
          fontSize={fontSize}
          selectedThread={selectedThreadForLog}
          scrollToIndex={scrollToIndex}
          scrollToDate={scrollToDate}
          selectedDate={activeSearchMatchDate ?? fragmentId ?? undefined}
          searchJumpDate={activeSearchMatchDate}
          searchJumpToken={threadSearchJumpToken}
          searchQuery={threadSearchHighlightQuery}
          onAtTopStateChange={setThreadNearTop}
          activityJumpDate={activityJumpDate}
          activityJumpToken={activityJumpToken}
          notifyOnTurnFinish={notifyOnTurnFinish}
          onNotifyOnTurnFinishChange={onNotifyOnTurnFinishChange}
          onOpenGitBrowser={onOpenGitBrowser}
          suppressInlineCodexStatusDate={
            selectedRunningCodexDate != null
              ? `${selectedRunningCodexDate}`
              : undefined
          }
        />
      </div>
    </div>
  );
}

function parseArchivedTotalCount(
  response: { total_hits?: unknown; total?: unknown } | undefined,
  fallback: number,
): number {
  const totalHits = Number(response?.total_hits);
  if (Number.isFinite(totalHits) && totalHits >= 0)
    return Math.floor(totalHits);
  const legacyTotal = Number(response?.total);
  if (Number.isFinite(legacyTotal) && legacyTotal >= 0) {
    return Math.floor(legacyTotal);
  }
  return fallback;
}

function formatBytes(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024) return `${Math.floor(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let x = n / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(x >= 10 ? 0 : 1)} ${units[i]}`;
}

function getReasoningForModel({
  modelValue,
  desired,
}: {
  modelValue?: string;
  desired?: CodexReasoningId;
}): CodexReasoningId | undefined {
  const model =
    DEFAULT_CODEX_MODELS.find((m) => m.name === modelValue) ??
    DEFAULT_CODEX_MODELS[0];
  const options = model?.reasoning ?? [];
  if (!options.length) return undefined;
  const match = options.find((r) => r.id === desired);
  return match?.id ?? options.find((r) => r.default)?.id ?? options[0]?.id;
}

function normalizeSessionMode(
  config?: Partial<CodexThreadConfig>,
): CodexSessionMode | undefined {
  return getCodexNewChatModeOptions().some(
    ({ value }) =>
      value === resolveCodexSessionMode(config as CodexThreadConfig),
  )
    ? (resolveCodexSessionMode(config as CodexThreadConfig) as CodexSessionMode)
    : getDefaultCodexSessionMode();
}

function renderOptionWithDescription({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div style={{ lineHeight: "18px" }}>
      <div>{title}</div>
      {description ? (
        <div style={{ fontSize: 11, color: "#888", lineHeight: "14px" }}>
          {description}
        </div>
      ) : null}
    </div>
  );
}
