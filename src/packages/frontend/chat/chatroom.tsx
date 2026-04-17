/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { IS_MOBILE } from "@cocalc/frontend/feature";
import { Alert, Button, Checkbox, Modal, Popconfirm, Space, Tag } from "antd";
import {
  delete_local_storage,
  get_local_storage,
  set_local_storage,
} from "@cocalc/frontend/misc";
import {
  React,
  redux,
  useCallback,
  useEditorRedux,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Loading, TimeAgo } from "@cocalc/frontend/components";
import type { NodeDesc } from "../frame-editors/frame-tree/types";
import { EditorComponentProps } from "../frame-editors/frame-tree/types";
import type { ChatActions } from "./actions";
import { ChatRoomComposer } from "./composer";
import { ChatRoomLayout } from "./chatroom-layout";
import { ChatRoomSidebarContent } from "./chatroom-sidebar";
import { GitCommitDrawer } from "./git-commit-drawer";
import type { ChatRoomModalHandlers } from "./chatroom-modals";
import { ChatRoomModals } from "./chatroom-modals";
import type { ChatRoomThreadActionHandlers } from "./chatroom-thread-actions";
import { ChatRoomThreadActions } from "./chatroom-thread-actions";
import { ChatRoomThreadPanel } from "./chatroom-thread-panel";
import {
  getDefaultNewThreadSetup,
  type NewThreadSetup,
} from "./chatroom-thread-panel";
import type { ChatState } from "./store";
import type { ChatMessage, ChatMessages, SubmitMentionsFn } from "./types";
import type { ThreadIndexEntry } from "./message-cache";
import { markChatAsReadIfUnseen, stableDraftKeyFromThreadKey } from "./utils";
import { useThreadSections } from "./threads";
import { ChatDocProvider, useChatDoc } from "./doc-context";
import { useChatComposerDraft } from "./use-chat-composer-draft";
import * as immutable from "immutable";
import {
  resetThreadSelectionForNewChat,
  useChatThreadSelection,
} from "./thread-selection";
import { dateValue, field } from "./access";
import { useCodexPaymentSource } from "./use-codex-payment-source";
import {
  acknowledgeThreadAutomation,
  deleteThreadAutomation,
  pauseThreadAutomation,
  resumeThreadAutomation,
  runThreadAutomationNow,
  upsertThreadAutomation,
} from "./acp-api";
import {
  AutomationConfigFields,
  buildAutomationDraft,
  describeAutomationSchedule,
  formatAutomationPausedReason,
  hasAutomationConfigContent,
  normalizeAutomationConfigForSave,
  shouldShowAutomationNextRun,
} from "./automation-form";
import {
  upsertAgentSessionRecord,
  type AgentSessionRecord,
} from "./agent-session-index";
import { resolveAgentSessionIdForThread } from "./thread-session";
import { findInChatAndOpenFirstResult } from "./find-in-chat";
import type {
  AcpAutomationConfig,
  AcpAutomationState,
  AcpLoopConfig,
  AcpLoopState,
} from "@cocalc/conat/ai/acp/types";
import {
  setChatOverlayOpen,
  useAnyChatOverlayOpen,
} from "./drawer-overlay-state";
import type { CodexThreadConfig } from "@cocalc/chat";
import {
  defaultWorkingDirectoryForChat,
  useWorkspaceChatWorkingDirectory,
} from "@cocalc/frontend/project/workspaces/chat-defaults";
import {
  clearWorkspaceNoticeForChatPath,
  setWorkspaceReadyForReviewNotice,
} from "@cocalc/frontend/project/workspaces/runtime";
import {
  isCodexModelName,
  resolveCodexSessionMode,
} from "@cocalc/util/ai/codex";
import { tab_to_path } from "@cocalc/util/misc";
import { persistExternalSideChatSelectedThreadKey } from "./external-side-chat-selection";
import type { ChatInputControl } from "./input";

const GRID_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  margin: "auto",
  minHeight: 0,
  flex: 1,
} as const;

const DEFAULT_SIDEBAR_WIDTH = 260;
const ACP_ACTIVE_STATES = new Set(["queue", "sending", "sent", "running"]);
const CODEX_TURN_NOTIFY_STORAGE_KEY = "cocalc:chat:codex-turn-notify";

function normalizeThreadKey(value?: string | null): string | undefined {
  const key = `${value ?? ""}`.trim();
  if (!key) return undefined;
  return key;
}

function readCodexTurnNotifyPreference(): boolean {
  return get_local_storage(CODEX_TURN_NOTIFY_STORAGE_KEY) === "true";
}

export type CodexTurnNotificationWatch = {
  threadKey: string;
  threadId: string;
  threadLabel: string;
};

export type CompletedCodexTurnNotification = CodexTurnNotificationWatch & {
  newestMessageDate?: string;
};

type CodexTurnNotificationSnapshot = {
  active: boolean;
  interrupted: boolean;
  newestMessageDate?: string;
};

type ChatThreadCompletionSnapshot = {
  active: boolean;
  interrupted: boolean;
  newestMessageDate?: string;
};

export function getLatestCodexActivityDate(
  messages: readonly ChatMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!field<string>(msg, "acp_account_id")) continue;
    const d = dateValue(msg);
    if (!d) continue;
    return `${d.valueOf()}`;
  }
  return undefined;
}

export function getLatestThreadMessageDate(
  messages: readonly ChatMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const d = dateValue(messages[i]);
    if (!d) continue;
    return `${d.valueOf()}`;
  }
  return undefined;
}

export function latestThreadAcpInterrupted(
  messages: readonly ChatMessage[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!field<string>(msg, "acp_account_id")) continue;
    return field<boolean>(msg, "acp_interrupted") === true;
  }
  return false;
}

export function splitCompletedCodexTurnNotifications({
  watches,
  snapshots,
}: {
  watches: readonly CodexTurnNotificationWatch[];
  snapshots: ReadonlyMap<string, CodexTurnNotificationSnapshot>;
}): {
  remainingWatches: CodexTurnNotificationWatch[];
  completedNotifications: CompletedCodexTurnNotification[];
} {
  const remainingWatches: CodexTurnNotificationWatch[] = [];
  const completedNotifications: CompletedCodexTurnNotification[] = [];
  for (const watch of watches) {
    const snapshot = snapshots.get(watch.threadKey);
    if (snapshot?.active === true) {
      remainingWatches.push(watch);
      continue;
    }
    if (snapshot?.interrupted === true) {
      continue;
    }
    completedNotifications.push({
      ...watch,
      newestMessageDate: snapshot?.newestMessageDate,
    });
  }
  return { remainingWatches, completedNotifications };
}

function buildChatThreadCompletionSnapshots({
  actions,
  acpState,
  threads,
}: {
  actions: ChatActions;
  acpState?: immutable.Map<string, string>;
  threads: readonly any[];
}): Map<string, ChatThreadCompletionSnapshot> {
  const snapshots = new Map<string, ChatThreadCompletionSnapshot>();
  for (const thread of threads) {
    if (!thread?.isAI) continue;
    const threadId = normalizeThreadKey(thread.key);
    if (!threadId) continue;
    const threadMessages = actions.getMessagesInThread(threadId) ?? [];
    snapshots.set(thread.key, {
      active: hasActiveAcpTurnForComposer({
        isSelectedThreadAI: true,
        selectedThreadId: threadId,
        selectedThreadMessages: threadMessages,
        acpState,
      }),
      interrupted: latestThreadAcpInterrupted(threadMessages),
      newestMessageDate: getLatestThreadMessageDate(threadMessages),
    });
  }
  return snapshots;
}

export function enabledLoopConfig(
  config?: AcpLoopConfig,
): AcpLoopConfig | undefined {
  return config?.enabled === true ? config : undefined;
}

function visibleAutomationConfig(
  config?: AcpAutomationConfig,
): AcpAutomationConfig | undefined {
  if (!hasAutomationConfigContent(config)) {
    return undefined;
  }
  return config;
}

function threadSupportsCodexAutomation(
  metadata?: {
    agent_kind?: string | null;
    agent_model?: string | null;
    acp_config?: unknown;
  } | null,
): boolean {
  if (!metadata) return false;
  if (metadata.agent_kind === "acp" || metadata.acp_config != null) {
    return true;
  }
  return isCodexModelName(`${metadata.agent_model ?? ""}`.trim());
}

export function clearThreadLoopRuntime(
  actions: Pick<ChatActions, "setThreadLoopConfig" | "setThreadLoopState">,
  threadKey?: string | null,
): void {
  const normalizedThreadKey = normalizeThreadKey(threadKey);
  if (!normalizedThreadKey) return;
  actions.setThreadLoopConfig?.(normalizedThreadKey, null);
  actions.setThreadLoopState?.(normalizedThreadKey, null);
}

export function hasActiveAcpTurnForComposer({
  isSelectedThreadAI,
  selectedThreadId,
  selectedThreadMessages,
  acpState,
}: {
  isSelectedThreadAI: boolean;
  selectedThreadId?: string | null;
  selectedThreadMessages: readonly ChatMessage[];
  acpState?: immutable.Map<string, string>;
}): boolean {
  if (!isSelectedThreadAI) return false;
  if (selectedThreadId) {
    const byThread = acpState?.get?.(`thread:${selectedThreadId}`);
    if (byThread === "running") {
      return true;
    }
  }
  if (!selectedThreadMessages.length) return false;
  for (const msg of selectedThreadMessages) {
    if (field<boolean>(msg, "generating") !== true) continue;
    const isAcpTurn = !!field<string>(msg, "acp_account_id");
    if (!isAcpTurn) continue;
    const d = dateValue(msg);
    if (!d) continue;
    const threadId = field<string>(msg, "thread_id");
    const threadState =
      threadId != null ? acpState?.get?.(`thread:${threadId}`) : undefined;
    const messageId = field<string>(msg, "message_id");
    const state =
      (messageId ? acpState?.get?.(`message:${messageId}`) : undefined) ??
      acpState?.get?.(`${d.valueOf()}`);
    if (
      (typeof threadState === "string" && ACP_ACTIVE_STATES.has(threadState)) ||
      (typeof state === "string" && ACP_ACTIVE_STATES.has(state))
    ) {
      return true;
    }
  }
  return false;
}

export function resolveAgentSessionRecordStatus({
  thread,
  threadId,
  actions,
  acpState,
}: {
  thread: { isArchived?: boolean };
  threadId?: string | null;
  actions: Pick<ChatActions, "getMessagesInThread">;
  acpState?: immutable.Map<string, string>;
}): AgentSessionRecord["status"] {
  if (thread.isArchived) return "archived";
  const normalizedThreadId = normalizeThreadKey(threadId);
  const threadState =
    normalizedThreadId != null
      ? acpState?.get?.(`thread:${normalizedThreadId}`)
      : undefined;
  if (typeof threadState === "string" && ACP_ACTIVE_STATES.has(threadState)) {
    return "running";
  }
  if (!normalizedThreadId) {
    return "active";
  }
  const threadMessages = actions.getMessagesInThread(normalizedThreadId) ?? [];
  for (let i = threadMessages.length - 1; i >= 0; i -= 1) {
    const msg = threadMessages[i];
    if (field<string>(msg, "acp_account_id") == null) continue;
    const rowState = `${field<string>(msg, "acp_state") ?? ""}`
      .trim()
      .toLowerCase();
    if (rowState === "queued" || rowState === "running") {
      return "running";
    }
    const messageId = `${field<string>(msg, "message_id") ?? ""}`.trim();
    const messageState =
      messageId.length > 0
        ? acpState?.get?.(`message:${messageId}`)
        : undefined;
    if (
      typeof messageState === "string" &&
      ACP_ACTIVE_STATES.has(messageState)
    ) {
      return "running";
    }
    if (field<boolean>(msg, "generating") === true) {
      return "running";
    }
  }
  return "active";
}

function parseDateISOString(value: unknown): string | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value as string | number);
  if (!Number.isFinite(d.valueOf())) return undefined;
  return d.toISOString();
}

export interface ChatPanelProps {
  actions: ChatActions;
  project_id: string;
  path: string;
  messages?: ChatMessages;
  threadIndex?: Map<string, ThreadIndexEntry>;
  docVersion?: number;
  readStateVersion?: number;
  fontSize?: number;
  desc?: NodeDesc;
  variant?: "default" | "compact";
  hideSidebar?: boolean;
  scrollCacheId?: string;
  forceScrollToBottomToken?: string | number;
  onFocus?: () => void;
  isVisible?: boolean;
  tabIsVisible?: boolean;
  onComposerReady?: (
    control: ChatInputControl | null,
    root: ParentNode | null,
  ) => void;
}

function getDescValue(desc: NodeDesc | undefined, key: string) {
  if (desc == null) return undefined;
  const getter: any = (desc as any).get;
  if (typeof getter === "function") {
    return getter.call(desc, key);
  }
  return (desc as any)[key];
}

function asBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function ChatPanel({
  actions,
  project_id,
  path,
  messages,
  threadIndex,
  docVersion,
  readStateVersion,
  fontSize = 13,
  desc,
  variant = "default",
  hideSidebar = false,
  scrollCacheId: scrollCacheIdOverride,
  forceScrollToBottomToken,
  onFocus,
  isVisible = true,
  tabIsVisible = true,
  onComposerReady,
}: ChatPanelProps) {
  const useEditor = useEditorRedux<ChatState>({ project_id, path });
  const activity: undefined | immutable.Map<string, number> =
    useEditor("activity");
  const acpState: immutable.Map<string, string> = useEditor("acpState");
  const account_id = useTypedRedux("account", "account_id");
  if (IS_MOBILE) {
    variant = "compact";
  }
  const scrollToIndex = getDescValue(desc, "data-scrollToIndex") ?? null;
  const scrollToDate = getDescValue(desc, "data-scrollToDate") ?? null;
  const fragmentId = getDescValue(desc, "data-fragmentId") ?? null;
  const showThreadImagePreviewRaw = getDescValue(
    desc,
    "data-showThreadImagePreview",
  );
  const showThreadImagePreview =
    showThreadImagePreviewRaw === false || showThreadImagePreviewRaw === "false"
      ? false
      : true;
  const hideChatTypeSelectorRaw = getDescValue(
    desc,
    "data-hideChatTypeSelector",
  );
  const hideChatTypeSelector = asBoolean(hideChatTypeSelectorRaw);
  const storedSidebarWidth = getDescValue(desc, "data-sidebarWidth");
  const storedSidebarHiddenRaw = getDescValue(desc, "data-sidebarHidden");
  const externalSideChatRaw = getDescValue(desc, "data-externalSideChat");
  const isExternalSideChat = asBoolean(externalSideChatRaw);
  const [sidebarWidth, setSidebarWidth] = useState<number>(
    typeof storedSidebarWidth === "number" && storedSidebarWidth > 50
      ? storedSidebarWidth
      : DEFAULT_SIDEBAR_WIDTH,
  );
  const [sidebarHidden, setSidebarHidden] = useState<boolean>(
    asBoolean(storedSidebarHiddenRaw),
  );
  const [sidebarVisible, setSidebarVisible] = useState<boolean>(false);
  const isCompact = variant === "compact";
  const storedThreadFromDesc =
    getDescValue(desc, "data-selectedThreadKey") ?? null;
  const [modalHandlers, setModalHandlers] =
    useState<ChatRoomModalHandlers | null>(null);
  const [threadActionHandlers, setThreadActionHandlers] =
    useState<ChatRoomThreadActionHandlers | null>(null);
  const submitMentionsRef = useRef<SubmitMentionsFn | undefined>(undefined);
  const scrollToBottomRef = useRef<any>(null);
  const previousSelectedThreadKeyRef = useRef<string | null>(null);
  const indexedAgentSessionsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!actions?.frameTreeActions?.set_frame_data || !actions?.frameId) return;
    actions.frameTreeActions.set_frame_data({
      id: actions.frameId,
      sidebarWidth,
    });
  }, [sidebarWidth, actions?.frameTreeActions, actions?.frameId]);
  useEffect(() => {
    if (!actions?.frameTreeActions?.set_frame_data || !actions?.frameId) return;
    actions.frameTreeActions.set_frame_data({
      id: actions.frameId,
      sidebarHidden,
    });
  }, [sidebarHidden, actions?.frameTreeActions, actions?.frameId]);

  const { threads, archivedThreads, threadSections } = useThreadSections({
    messages,
    threadIndex,
    activity,
    accountId: account_id,
    actions,
    version: docVersion,
    readStateVersion,
  });

  const {
    selectedThreadKey,
    setSelectedThreadKey,
    setAllowAutoSelectThread,
    singleThreadView,
    selectedThread,
  } = useChatThreadSelection({
    actions,
    threads,
    messages,
    fragmentId,
    storedThreadFromDesc,
  });

  useEffect(() => {
    if (
      !isExternalSideChat &&
      actions?.frameTreeActions?.set_frame_data &&
      actions?.frameId
    ) {
      return;
    }
    persistExternalSideChatSelectedThreadKey({
      project_id,
      path,
      selectedThreadKey,
    });
  }, [
    project_id,
    path,
    selectedThreadKey,
    isExternalSideChat,
    actions?.frameTreeActions,
    actions?.frameId,
  ]);

  const [composerSession, setComposerSession] = useState(0);
  const [codexTurnNotificationWatches, setCodexTurnNotificationWatches] =
    useState<CodexTurnNotificationWatch[]>([]);
  const [completedCodexTurnNotifications, setCompletedCodexTurnNotifications] =
    useState<CompletedCodexTurnNotification[]>([]);
  const [codexTurnNotifyDefaultEnabled, setCodexTurnNotifyDefaultEnabled] =
    useState<boolean>(() => readCodexTurnNotifyPreference());
  const accountOtherSettings = useTypedRedux("account", "other_settings");
  const activeProjectTab = useTypedRedux({ project_id }, "active_project_tab");
  const workspaceWorkingDirectory = useWorkspaceChatWorkingDirectory(path);
  const priorThreadCompletionSnapshotsRef = useRef<
    Map<string, ChatThreadCompletionSnapshot>
  >(new Map());
  const isChatForeground = useMemo(
    () => tab_to_path(activeProjectTab ?? "") === path,
    [activeProjectTab, path],
  );
  const defaultNewThreadSetup = useMemo<NewThreadSetup>(() => {
    const title = asTrimmedString(
      getDescValue(desc, "data-newThreadTitleDefault"),
    );
    const icon = asTrimmedString(
      getDescValue(desc, "data-newThreadIconDefault"),
    );
    const color = asTrimmedString(
      getDescValue(desc, "data-newThreadColorDefault"),
    );
    const navigatorWorkingDirectory = asTrimmedString(
      getDescValue(desc, "data-navigatorNewThreadWorkingDirectoryDefault"),
    );
    const baseNewThreadSetup = getDefaultNewThreadSetup();
    return {
      ...baseNewThreadSetup,
      title: title ?? baseNewThreadSetup.title,
      icon: icon ?? baseNewThreadSetup.icon,
      color: color ?? baseNewThreadSetup.color,
      agentMode: "codex",
      codexConfig: {
        ...baseNewThreadSetup.codexConfig,
        workingDirectory:
          navigatorWorkingDirectory ??
          defaultWorkingDirectoryForChat(path, workspaceWorkingDirectory),
      },
    };
  }, [accountOtherSettings, desc, path, workspaceWorkingDirectory]);
  const [newThreadSetup, setNewThreadSetup] = useState<NewThreadSetup>(
    defaultNewThreadSetup,
  );
  const [automationModalOpen, setAutomationModalOpen] = useState(false);
  const [automationModalThreadKey, setAutomationModalThreadKey] = useState<
    string | null
  >(null);
  const [automationSaving, setAutomationSaving] = useState(false);
  const [automationDraft, setAutomationDraft] = useState<AcpAutomationConfig>(
    () => buildAutomationDraft(),
  );
  const [gitBrowserOpen, setGitBrowserOpen] = useState<boolean>(false);
  const [gitBrowserCwd, setGitBrowserCwd] = useState<string | undefined>(
    undefined,
  );
  const [gitBrowserCommitHash, setGitBrowserCommitHash] = useState<
    string | undefined
  >(undefined);
  const [gitBrowserThreadKey, setGitBrowserThreadKey] = useState<
    string | undefined
  >(undefined);
  const [activityJumpDate, setActivityJumpDate] = useState<string | undefined>(
    undefined,
  );
  const [activityJumpToken, setActivityJumpToken] = useState<number>(0);
  const anyOverlayOpen = useAnyChatOverlayOpen();
  const gitBrowserOverlayKey = useMemo(
    () => `${project_id ?? "no-project"}:${path ?? "no-path"}:git-browser`,
    [project_id, path],
  );
  const composerDraftKey = useMemo(() => {
    if (!singleThreadView || !selectedThreadKey) return 0;
    return stableDraftKeyFromThreadKey(selectedThreadKey);
  }, [singleThreadView, selectedThreadKey]);

  const { input, setInput, clearInput, clearComposerDraft } =
    useChatComposerDraft({
      account_id,
      project_id,
      path,
      composerDraftKey,
    });
  useEffect(() => {
    setChatOverlayOpen(gitBrowserOverlayKey, gitBrowserOpen);
    return () => {
      setChatOverlayOpen(gitBrowserOverlayKey, false);
    };
  }, [gitBrowserOpen, gitBrowserOverlayKey]);
  const inputRef = useRef<string>(input);
  const composerSessionRef = useRef<number>(composerSession);
  const pendingThreadDraftTransferRef = useRef<{
    threadKey: string;
    text: string;
    sourceDraftKey: number;
  } | null>(null);
  useEffect(() => {
    inputRef.current = input;
  }, [input]);
  useEffect(() => {
    composerSessionRef.current = composerSession;
  }, [composerSession]);
  const setComposerInput = useCallback(
    (value: string, sessionToken?: number) => {
      if (sessionToken != null && sessionToken !== composerSessionRef.current) {
        return;
      }
      if (value === inputRef.current) {
        return;
      }
      inputRef.current = value;
      setInput(value);
    },
    [setInput],
  );
  useEffect(() => {
    const pending = pendingThreadDraftTransferRef.current;
    if (!pending || selectedThreadKey !== pending.threadKey) {
      return;
    }
    pendingThreadDraftTransferRef.current = null;
    if (pending.text.length > 0) {
      inputRef.current = pending.text;
      setInput(pending.text);
    }
    if (pending.sourceDraftKey !== composerDraftKey) {
      void clearComposerDraft(pending.sourceDraftKey);
    }
  }, [clearComposerDraft, composerDraftKey, selectedThreadKey, setInput]);
  const hasInput = input.trim().length > 0;
  const isSelectedThreadAI = selectedThread?.isAI ?? false;
  const [composerLoopConfig, setComposerLoopConfig] = useState<
    AcpLoopConfig | undefined
  >(undefined);
  const [composerLoopConfigDirty, setComposerLoopConfigDirty] = useState(false);
  const [suppressedLoopThreads, setSuppressedLoopThreads] = useState<
    Set<string>
  >(new Set());
  const selectedThreadId = useMemo(
    () => normalizeThreadKey(selectedThreadKey),
    [selectedThreadKey],
  );
  const notifyOnSelectedTurnFinish = useMemo(
    () =>
      !!selectedThreadKey &&
      (codexTurnNotifyDefaultEnabled ||
        codexTurnNotificationWatches.some(
          (watch) => watch.threadKey === selectedThreadKey,
        )),
    [
      codexTurnNotifyDefaultEnabled,
      codexTurnNotificationWatches,
      selectedThreadKey,
    ],
  );
  const selectedThreadMetadata = useMemo(
    () =>
      selectedThreadKey
        ? actions.getThreadMetadata?.(selectedThreadKey, {
            threadId: selectedThreadId,
          })
        : undefined,
    [actions, selectedThreadKey, selectedThreadId, docVersion],
  );
  const isSelectedThreadCodex =
    threadSupportsCodexAutomation(selectedThreadMetadata) ||
    (isSelectedThreadAI &&
      typeof selectedThreadMetadata?.agent_model === "string" &&
      `${selectedThreadMetadata.agent_model}`.toLowerCase().includes("codex"));

  const persistedLoopConfig = useMemo(
    () => enabledLoopConfig(selectedThreadMetadata?.loop_config),
    [selectedThreadMetadata?.loop_config],
  );
  const selectedThreadAutomationConfig = useMemo(
    () => visibleAutomationConfig(selectedThreadMetadata?.automation_config),
    [selectedThreadMetadata?.automation_config],
  );
  const selectedThreadAutomationState = useMemo(
    () =>
      selectedThreadMetadata?.automation_state as
        | AcpAutomationState
        | undefined,
    [selectedThreadMetadata?.automation_state],
  );
  const automationModalThreadId = useMemo(
    () => normalizeThreadKey(automationModalThreadKey ?? selectedThreadKey),
    [automationModalThreadKey, selectedThreadKey],
  );
  const automationModalMetadata = useMemo(
    () =>
      automationModalThreadId
        ? actions.getThreadMetadata?.(automationModalThreadId, {
            threadId: automationModalThreadId,
          })
        : undefined,
    [actions, automationModalThreadId, docVersion],
  );
  const automationModalConfig = useMemo(
    () => visibleAutomationConfig(automationModalMetadata?.automation_config),
    [automationModalMetadata?.automation_config],
  );
  const automationModalAllowsCodex = useMemo(
    () => threadSupportsCodexAutomation(automationModalMetadata),
    [automationModalMetadata],
  );
  const selectedThreadLoopState = useMemo(
    () => selectedThreadMetadata?.loop_state as AcpLoopState | undefined,
    [selectedThreadMetadata?.loop_state],
  );
  const visiblePersistedLoopConfig = useMemo(() => {
    if (
      selectedThreadKey != null &&
      suppressedLoopThreads.has(selectedThreadKey.trim())
    ) {
      return undefined;
    }
    return persistedLoopConfig;
  }, [persistedLoopConfig, selectedThreadKey, suppressedLoopThreads]);

  useEffect(() => {
    const threadKey = selectedThreadKey?.trim();
    if (!threadKey || persistedLoopConfig != null) return;
    setSuppressedLoopThreads((prev) => {
      if (!prev.has(threadKey)) return prev;
      const next = new Set(prev);
      next.delete(threadKey);
      return next;
    });
  }, [selectedThreadKey, persistedLoopConfig]);

  useEffect(() => {
    // When switching threads, reflect persisted loop state for that thread.
    setComposerLoopConfig(visiblePersistedLoopConfig);
    setComposerLoopConfigDirty(false);
  }, [selectedThreadKey, visiblePersistedLoopConfig]);

  useEffect(() => {
    // Once a local override has been consumed/reset, re-sync the switch from
    // persisted thread metadata so the UI matches backend loop behavior.
    if (composerLoopConfigDirty) return;
    setComposerLoopConfig(visiblePersistedLoopConfig);
  }, [visiblePersistedLoopConfig, composerLoopConfigDirty]);

  const handleLoopConfigChange = useCallback(
    (config?: AcpLoopConfig) => {
      const threadKey = selectedThreadKey?.trim();
      if (threadKey) {
        setSuppressedLoopThreads((prev) => {
          if (!prev.has(threadKey)) return prev;
          const next = new Set(prev);
          next.delete(threadKey);
          return next;
        });
      }
      if (config?.enabled !== true) {
        if (threadKey) {
          setSuppressedLoopThreads((prev) => {
            if (prev.has(threadKey)) return prev;
            const next = new Set(prev);
            next.add(threadKey);
            return next;
          });
        }
        clearThreadLoopRuntime(actions, selectedThreadKey);
        setComposerLoopConfig(undefined);
        setComposerLoopConfigDirty(false);
        return;
      }
      setComposerLoopConfig(config);
      setComposerLoopConfigDirty(true);
    },
    [actions, selectedThreadKey],
  );

  const handleAutomationSave = useCallback(
    async ({
      threadId,
      config,
    }: {
      threadId?: string | null;
      config: AcpAutomationConfig;
    }) => {
      if (!threadId) return;
      await upsertThreadAutomation({
        actions,
        threadId,
        config,
      });
    },
    [actions],
  );

  const handleAutomationPause = useCallback(async () => {
    if (!selectedThreadId) return;
    await pauseThreadAutomation({ actions, threadId: selectedThreadId });
  }, [actions, selectedThreadId]);

  const handleAutomationResume = useCallback(async () => {
    if (!selectedThreadId) return;
    await resumeThreadAutomation({ actions, threadId: selectedThreadId });
  }, [actions, selectedThreadId]);

  const handleAutomationRunNow = useCallback(async () => {
    if (!selectedThreadId) return;
    await runThreadAutomationNow({ actions, threadId: selectedThreadId });
  }, [actions, selectedThreadId]);

  const handleAutomationAcknowledge = useCallback(async () => {
    if (!selectedThreadId) return;
    await acknowledgeThreadAutomation({ actions, threadId: selectedThreadId });
  }, [actions, selectedThreadId]);

  const handleAutomationDelete = useCallback(async () => {
    if (!selectedThreadId) return;
    await deleteThreadAutomation({ actions, threadId: selectedThreadId });
  }, [actions, selectedThreadId]);

  const createThreadWithoutMessage = useCallback(async () => {
    const threadAgent =
      newThreadSetup.agentMode != null
        ? {
            mode: newThreadSetup.agentMode,
            model:
              newThreadSetup.codexConfig.model?.trim() ||
              newThreadSetup.model?.trim(),
            codexConfig:
              newThreadSetup.agentMode === "codex"
                ? {
                    ...newThreadSetup.codexConfig,
                    model:
                      newThreadSetup.codexConfig.model?.trim() ||
                      newThreadSetup.model?.trim(),
                  }
                : undefined,
          }
        : undefined;
    const threadKey = actions.createEmptyThread?.({
      name: newThreadSetup.title.trim() || undefined,
      threadAgent,
      threadAppearance: {
        color: newThreadSetup.color?.trim(),
        icon: newThreadSetup.icon?.trim(),
        image: newThreadSetup.image?.trim(),
      },
    });
    if (!threadKey) {
      return;
    }

    pendingThreadDraftTransferRef.current = {
      threadKey,
      text: inputRef.current ?? "",
      sourceDraftKey: composerDraftKey,
    };
    setAllowAutoSelectThread(false);
    setSelectedThreadKey(threadKey);
    setNewThreadSetup(defaultNewThreadSetup);

    const newThreadAutomationConfig = normalizeAutomationConfigForSave({
      draft: newThreadSetup.automationConfig,
      allowCodexRunKind: newThreadSetup.agentMode === "codex",
    });
    if (
      newThreadSetup.automationConfig?.enabled === true &&
      newThreadAutomationConfig
    ) {
      try {
        await handleAutomationSave({
          threadId: threadKey,
          config: newThreadAutomationConfig,
        });
      } catch (err) {
        console.error("Failed to create thread automation", err);
      }
    }
  }, [
    actions,
    composerDraftKey,
    defaultNewThreadSetup,
    handleAutomationSave,
    newThreadSetup,
    setAllowAutoSelectThread,
    setSelectedThreadKey,
  ]);

  useEffect(() => {
    if (!automationModalOpen) return;
    setAutomationDraft(
      buildAutomationDraft({
        config: automationModalConfig,
        enabled: automationModalConfig?.enabled !== false,
        allowCodexRunKind: automationModalAllowsCodex,
      }),
    );
  }, [automationModalAllowsCodex, automationModalConfig, automationModalOpen]);

  const handleAutomationModalSave = useCallback(async () => {
    if (!automationModalThreadId) return;
    const config = normalizeAutomationConfigForSave({
      draft: automationDraft,
      automationId: automationModalConfig?.automation_id,
      allowCodexRunKind: automationModalAllowsCodex,
    });
    if (!config) return;
    setAutomationSaving(true);
    try {
      await handleAutomationSave({
        threadId: automationModalThreadId,
        config,
      });
      setAutomationModalOpen(false);
    } finally {
      setAutomationSaving(false);
    }
  }, [
    automationDraft,
    automationModalAllowsCodex,
    automationModalConfig?.automation_id,
    automationModalThreadId,
    handleAutomationSave,
  ]);

  const selectedThreadLookupKey = selectedThreadId;
  const selectedThreadMessages = useMemo(
    () =>
      selectedThreadLookupKey != null
        ? (actions.getMessagesInThread(selectedThreadLookupKey) ?? [])
        : [],
    [actions, selectedThreadLookupKey, messages],
  );
  const setNotifyOnSelectedTurnFinish = useCallback(
    (checked: boolean) => {
      if (!selectedThreadKey || !selectedThreadId) return;
      setCodexTurnNotifyDefaultEnabled(checked);
      if (checked) {
        set_local_storage(CODEX_TURN_NOTIFY_STORAGE_KEY, "true");
      } else {
        delete_local_storage(CODEX_TURN_NOTIFY_STORAGE_KEY);
      }
      if (!checked) {
        setCodexTurnNotificationWatches((prev) =>
          prev.filter((watch) => watch.threadKey !== selectedThreadKey),
        );
        return;
      }
      const nextWatch = {
        threadKey: selectedThreadKey,
        threadId: selectedThreadId,
        threadLabel:
          `${selectedThread?.displayLabel ?? selectedThread?.label ?? ""}`.trim() ||
          "this chat",
      } satisfies CodexTurnNotificationWatch;
      setCodexTurnNotificationWatches((prev) => [
        ...prev.filter((watch) => watch.threadKey !== nextWatch.threadKey),
        nextWatch,
      ]);
    },
    [selectedThread, selectedThreadId, selectedThreadKey],
  );
  const setNotifyForThread = useCallback(
    ({
      checked,
      threadKey,
      threadId,
      threadLabel,
    }: {
      checked: boolean;
      threadKey: string;
      threadId: string;
      threadLabel: string;
    }) => {
      const normalizedThreadKey = `${threadKey ?? ""}`.trim();
      const normalizedThreadId = `${threadId ?? ""}`.trim();
      if (!normalizedThreadKey || !normalizedThreadId) return;
      setCodexTurnNotifyDefaultEnabled(checked);
      if (checked) {
        set_local_storage(CODEX_TURN_NOTIFY_STORAGE_KEY, "true");
      } else {
        delete_local_storage(CODEX_TURN_NOTIFY_STORAGE_KEY);
      }
      if (!checked) {
        setCodexTurnNotificationWatches((prev) =>
          prev.filter((watch) => watch.threadKey !== normalizedThreadKey),
        );
        return;
      }
      const nextWatch = {
        threadKey: normalizedThreadKey,
        threadId: normalizedThreadId,
        threadLabel: `${threadLabel ?? ""}`.trim() || "this chat",
      } satisfies CodexTurnNotificationWatch;
      setCodexTurnNotificationWatches((prev) => [
        ...prev.filter((watch) => watch.threadKey !== nextWatch.threadKey),
        nextWatch,
      ]);
    },
    [],
  );
  const hasRunningAcpTurn = useMemo(() => {
    return hasActiveAcpTurnForComposer({
      isSelectedThreadAI,
      selectedThreadId,
      selectedThreadMessages,
      acpState,
    });
  }, [isSelectedThreadAI, selectedThreadId, selectedThreadMessages, acpState]);
  useEffect(() => {
    if (
      !codexTurnNotifyDefaultEnabled ||
      !hasRunningAcpTurn ||
      !selectedThreadKey ||
      !selectedThreadId
    ) {
      return;
    }
    const nextWatch = {
      threadKey: selectedThreadKey,
      threadId: selectedThreadId,
      threadLabel:
        `${selectedThread?.displayLabel ?? selectedThread?.label ?? ""}`.trim() ||
        "this chat",
    } satisfies CodexTurnNotificationWatch;
    setCodexTurnNotificationWatches((prev) => {
      const existing = prev.find(
        (watch) => watch.threadKey === nextWatch.threadKey,
      );
      if (
        existing &&
        existing.threadId === nextWatch.threadId &&
        existing.threadLabel === nextWatch.threadLabel
      ) {
        return prev;
      }
      return [
        ...prev.filter((watch) => watch.threadKey !== nextWatch.threadKey),
        nextWatch,
      ];
    });
  }, [
    codexTurnNotifyDefaultEnabled,
    hasRunningAcpTurn,
    selectedThread,
    selectedThreadId,
    selectedThreadKey,
  ]);
  useEffect(() => {
    if (codexTurnNotificationWatches.length === 0) return;
    const snapshots = new Map<string, CodexTurnNotificationSnapshot>();
    for (const watch of codexTurnNotificationWatches) {
      const threadMessages = actions.getMessagesInThread(watch.threadId) ?? [];
      snapshots.set(watch.threadKey, {
        active: hasActiveAcpTurnForComposer({
          isSelectedThreadAI: true,
          selectedThreadId: watch.threadId,
          selectedThreadMessages: threadMessages,
          acpState,
        }),
        interrupted: latestThreadAcpInterrupted(threadMessages),
        newestMessageDate: getLatestThreadMessageDate(threadMessages),
      });
    }
    const { remainingWatches, completedNotifications } =
      splitCompletedCodexTurnNotifications({
        watches: codexTurnNotificationWatches,
        snapshots,
      });
    if (completedNotifications.length === 0) return;
    setCodexTurnNotificationWatches(remainingWatches);
    setCompletedCodexTurnNotifications((prev) => {
      const seen = new Set(
        prev.map(
          (notification) =>
            `${notification.threadKey}:${notification.newestMessageDate ?? ""}`,
        ),
      );
      const next = [...prev];
      for (const notification of completedNotifications) {
        const key = `${notification.threadKey}:${notification.newestMessageDate ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(notification);
      }
      return next;
    });
  }, [actions, acpState, codexTurnNotificationWatches, messages]);

  useEffect(() => {
    if (!project_id || !path?.trim() || !account_id?.trim()) {
      priorThreadCompletionSnapshotsRef.current = new Map();
      return;
    }
    const currentSnapshots = buildChatThreadCompletionSnapshots({
      actions,
      acpState,
      threads: [...threads, ...archivedThreads],
    });
    const previousSnapshots = priorThreadCompletionSnapshotsRef.current;
    priorThreadCompletionSnapshotsRef.current = currentSnapshots;

    if (isChatForeground) {
      return;
    }

    const anyActive = Array.from(currentSnapshots.values()).some(
      (snapshot) => snapshot.active,
    );
    if (anyActive) {
      return;
    }

    let newestCompletedAt = 0;
    for (const [threadKey, current] of currentSnapshots) {
      const previous = previousSnapshots.get(threadKey);
      if (!previous?.active || current.active || current.interrupted) continue;
      const completedAt = Number(current.newestMessageDate ?? "");
      if (Number.isFinite(completedAt) && completedAt > newestCompletedAt) {
        newestCompletedAt = completedAt;
      }
    }
    if (newestCompletedAt <= 0) return;

    void setWorkspaceReadyForReviewNotice({
      project_id,
      account_id,
      chat_path: path,
      updated_at: newestCompletedAt,
    }).catch(() => {});
  }, [
    account_id,
    acpState,
    actions,
    archivedThreads,
    isChatForeground,
    path,
    project_id,
    threads,
    messages,
  ]);

  useEffect(() => {
    if (
      !isChatForeground ||
      !project_id ||
      !path?.trim() ||
      !account_id?.trim()
    ) {
      return;
    }
    void clearWorkspaceNoticeForChatPath({
      project_id,
      account_id,
      chat_path: path,
    }).catch(() => {});
  }, [account_id, isChatForeground, path, project_id]);

  const agentSessionRecords = useMemo<AgentSessionRecord[]>(() => {
    if (typeof account_id !== "string" || !account_id.trim()) {
      return [];
    }
    const records: AgentSessionRecord[] = [];
    for (const thread of [...threads, ...archivedThreads]) {
      if (!thread.isAI) continue;
      const threadId = normalizeThreadKey(thread.key);
      const metadata = actions.getThreadMetadata?.(thread.key, {
        threadId,
      });
      const acpConfig = metadata?.acp_config ?? undefined;
      const sessionIdRaw = resolveAgentSessionIdForThread({
        actions,
        threadId,
        threadKey: thread.key,
        persistedSessionId: acpConfig?.sessionId,
      });
      const threadDateRaw =
        metadata?.thread_date ??
        (thread.newestTime
          ? new Date(thread.newestTime).toISOString()
          : undefined);
      const createdAt =
        parseDateISOString(threadDateRaw) ?? new Date().toISOString();
      const updatedAt =
        parseDateISOString(thread.newestTime) ??
        parseDateISOString(threadDateRaw) ??
        new Date().toISOString();
      const status = resolveAgentSessionRecordStatus({
        thread,
        threadId,
        actions,
        acpState,
      });
      records.push({
        session_id: sessionIdRaw,
        project_id,
        account_id,
        chat_path: path,
        thread_key: thread.key,
        title: thread.displayLabel || thread.label || "Agent session",
        created_at: createdAt,
        updated_at: updatedAt,
        status,
        entrypoint: path.includes("navigator.chat") ? "global" : "file",
        working_directory:
          typeof acpConfig?.workingDirectory === "string"
            ? acpConfig.workingDirectory
            : undefined,
        mode:
          acpConfig?.sessionMode === "read-only" ||
          acpConfig?.sessionMode === "workspace-write" ||
          acpConfig?.sessionMode === "full-access"
            ? acpConfig.sessionMode
            : undefined,
        model:
          typeof acpConfig?.model === "string"
            ? acpConfig.model
            : typeof metadata?.agent_model === "string"
              ? metadata.agent_model
              : undefined,
        reasoning:
          typeof acpConfig?.reasoning === "string"
            ? acpConfig.reasoning
            : undefined,
        thread_color:
          typeof thread.threadColor === "string"
            ? thread.threadColor
            : undefined,
        thread_accent_color:
          typeof thread.threadAccentColor === "string"
            ? thread.threadAccentColor
            : undefined,
        thread_icon:
          typeof thread.threadIcon === "string" ? thread.threadIcon : undefined,
        thread_image:
          typeof thread.threadImage === "string"
            ? thread.threadImage
            : undefined,
        thread_pin: thread.isPinned === true,
      });
    }
    return records;
  }, [
    account_id,
    acpState,
    actions,
    archivedThreads,
    path,
    project_id,
    threads,
  ]);

  useEffect(() => {
    if (!agentSessionRecords.length) return;
    for (const record of agentSessionRecords) {
      const serialized = JSON.stringify(record);
      if (
        indexedAgentSessionsRef.current.get(record.session_id) === serialized
      ) {
        continue;
      }
      void upsertAgentSessionRecord(record)
        .then(() => {
          indexedAgentSessionsRef.current.set(record.session_id, serialized);
        })
        .catch(() => {});
    }
  }, [agentSessionRecords, path]);

  const {
    paymentSource: codexPaymentSource,
    loading: codexPaymentSourceLoading,
    refresh: refreshCodexPaymentSource,
  } = useCodexPaymentSource({
    projectId: project_id,
    enabled: isSelectedThreadAI,
  });

  const indexedThreads = useMemo(() => {
    if (!threadIndex) return undefined;
    const next = new Map(threadIndex);
    for (const thread of threads) {
      if (next.has(thread.key)) continue;
      next.set(thread.key, {
        key: thread.key,
        newestTime: thread.newestTime,
        messageCount: 0,
        messageKeys: new Set<string>(),
        orderedKeys: [],
        rootMessage: thread.rootMessage as any,
      });
    }
    return next;
  }, [threadIndex, threads]);

  const scrollCacheId = useMemo(() => {
    if (scrollCacheIdOverride) {
      return scrollCacheIdOverride;
    }
    return `${project_id ?? ""}${path ?? ""}`;
  }, [project_id, path, scrollCacheIdOverride]);

  useEffect(() => {
    if (forceScrollToBottomToken == null) return;
    const scrollToBottom = () => {
      scrollToBottomRef.current?.(true);
    };
    scrollToBottom();
    const timers = [0, 50, 150, 300].map((delayMs) =>
      window.setTimeout(scrollToBottom, delayMs),
    );
    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [forceScrollToBottomToken]);

  const selectedThreadReadSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!singleThreadView || !selectedThreadKey || !actions?.markThreadRead) {
      selectedThreadReadSignatureRef.current = null;
      return;
    }
    const thread = threads.find((item) => item.key === selectedThreadKey);
    if (!thread) {
      selectedThreadReadSignatureRef.current = null;
      return;
    }
    const messageCount = Math.max(thread.messageCount ?? 0, 0);
    const unreadCount = Math.max(thread.unreadCount ?? 0, 0);
    const signature = `${thread.key}:${messageCount}`;
    if (
      selectedThreadReadSignatureRef.current === signature &&
      unreadCount <= 0
    ) {
      return;
    }
    if (messageCount <= 0) {
      selectedThreadReadSignatureRef.current = signature;
      return;
    }
    const ok = actions.markThreadRead(thread.key, messageCount);
    if (ok !== false) {
      selectedThreadReadSignatureRef.current = signature;
    }
  }, [singleThreadView, selectedThreadKey, threads, actions]);

  const mark_as_read = useCallback(() => {
    markChatAsReadIfUnseen(project_id, path);
  }, [project_id, path]);

  useEffect(() => {
    if (!singleThreadView) {
      previousSelectedThreadKeyRef.current = null;
      return;
    }
    if (!selectedThreadKey) {
      previousSelectedThreadKeyRef.current = null;
      return;
    }
    if (previousSelectedThreadKeyRef.current === selectedThreadKey) return;
    previousSelectedThreadKeyRef.current = selectedThreadKey;
    if (fragmentId || scrollToDate != null || scrollToIndex != null) return;
    if (activityJumpDate || activityJumpToken) return;
    actions?.scrollToIndex?.(Number.MAX_SAFE_INTEGER);
  }, [
    singleThreadView,
    selectedThreadKey,
    fragmentId,
    scrollToDate,
    scrollToIndex,
    activityJumpDate,
    activityJumpToken,
    actions,
  ]);

  const totalUnread = useMemo(
    () => threadSections.reduce((sum, section) => sum + section.unreadCount, 0),
    [threadSections],
  );

  const advanceComposerSession = useCallback((): number => {
    const nextSession = composerSessionRef.current + 1;
    composerSessionRef.current = nextSession;
    setComposerSession(nextSession);
    return nextSession;
  }, []);

  const clearComposerNow = useCallback(
    (draftKey: number) => {
      // Keep local guard state coherent immediately, before async state/render.
      inputRef.current = "";
      // Clear current composer draft before send switches selected thread context.
      actions.deleteDraft(draftKey);
      void clearInput();
    },
    [actions, clearInput],
  );

  function resolveReplyTarget(): {
    thread_id?: string;
    parent_message_id?: string;
    lookup?: string;
  } {
    const resolveFromThreadKey = (threadKey?: string | null) => {
      if (!threadKey) {
        return {
          thread_id: undefined,
          parent_message_id: undefined,
          lookup: undefined,
        };
      }
      const thread_id = normalizeThreadKey(threadKey);
      const threadMessages = thread_id
        ? (actions.getMessagesInThread(thread_id) ?? [])
        : [];
      const latestMessageId =
        `${(threadMessages[threadMessages.length - 1] as any)?.message_id ?? ""}`.trim() ||
        undefined;
      const lookup = thread_id;
      return {
        thread_id,
        parent_message_id: latestMessageId,
        lookup,
      };
    };
    return resolveFromThreadKey(selectedThreadKey);
  }

  function sendMessage(
    extraInput?: string,
    opts?: { immediate?: boolean },
  ): void {
    const rawSendingText = `${extraInput ?? inputRef.current ?? ""}`;
    const sendingText = rawSendingText.trim();
    if (sendingText.length === 0) return;
    advanceComposerSession();
    const target = resolveReplyTarget();
    const reply_thread_id = target.thread_id;
    const parent_message_id = target.parent_message_id;
    const existingThreadMetadata =
      reply_thread_id != null
        ? actions.getThreadMetadata?.(reply_thread_id, {
            threadId: reply_thread_id,
          })
        : undefined;
    if (!reply_thread_id) {
      setAllowAutoSelectThread(false);
    }

    clearComposerNow(composerDraftKey);

    const acpConfigOverride =
      !reply_thread_id && newThreadSetup.agentMode === "codex"
        ? (() => {
            const model =
              newThreadSetup.codexConfig.model?.trim() ||
              newThreadSetup.model?.trim();
            if (!model) return undefined;
            const next: Partial<CodexThreadConfig> = {
              ...newThreadSetup.codexConfig,
              model,
            };
            const sessionMode = resolveCodexSessionMode(
              next as CodexThreadConfig,
            );
            next.sessionMode = sessionMode;
            next.allowWrite = sessionMode !== "read-only";
            return next;
          })()
        : reply_thread_id && existingThreadMetadata?.agent_kind === "acp"
          ? (existingThreadMetadata.acp_config ??
            actions.getCodexConfig?.(reply_thread_id) ??
            undefined)
          : undefined;

    const timeStamp = actions.sendChat({
      submitMentionsRef,
      reply_thread_id,
      parent_message_id,
      extraInput,
      send_mode: opts?.immediate ? "immediate" : undefined,
      name:
        !reply_thread_id && newThreadSetup.title.trim()
          ? newThreadSetup.title.trim()
          : undefined,
      threadAgent:
        !reply_thread_id && newThreadSetup.agentMode
          ? {
              mode: newThreadSetup.agentMode,
              model:
                newThreadSetup.codexConfig.model?.trim() ||
                newThreadSetup.model?.trim(),
              codexConfig:
                newThreadSetup.agentMode === "codex"
                  ? {
                      ...newThreadSetup.codexConfig,
                      model:
                        newThreadSetup.codexConfig.model?.trim() ||
                        newThreadSetup.model?.trim(),
                    }
                  : undefined,
            }
          : undefined,
      threadAppearance: !reply_thread_id
        ? {
            color: newThreadSetup.color?.trim(),
            icon: newThreadSetup.icon?.trim(),
            image: newThreadSetup.image?.trim(),
          }
        : undefined,
      acp_loop_config:
        composerLoopConfig?.enabled === true &&
        (isSelectedThreadCodex ||
          (!reply_thread_id && newThreadSetup.agentMode === "codex"))
          ? composerLoopConfig
          : undefined,
      acpConfigOverride,
    });
    if (!timeStamp) {
      // If send preconditions fail after optimistic clear (e.g. transient
      // reply-target metadata race), restore the typed input so nothing vanishes.
      inputRef.current = rawSendingText;
      setInput(rawSendingText);
      return;
    }
    const threadKey =
      !reply_thread_id && timeStamp
        ? (() => {
            const created = actions.getMessageByDate(new Date(timeStamp));
            const threadId = field<string>(created as any, "thread_id");
            return threadId?.trim() || null;
          })()
        : null;
    const newThreadAutomationConfig = !reply_thread_id
      ? normalizeAutomationConfigForSave({
          draft: newThreadSetup.automationConfig,
          allowCodexRunKind: newThreadSetup.agentMode === "codex",
        })
      : undefined;
    if (
      !reply_thread_id &&
      threadKey &&
      newThreadSetup.automationConfig?.enabled === true &&
      newThreadAutomationConfig
    ) {
      void handleAutomationSave({
        threadId: threadKey,
        config: newThreadAutomationConfig,
      }).catch((err) => {
        console.error("Failed to create thread automation", err);
      });
    }
    const consumedLoopThreadKey = (reply_thread_id ?? threadKey)?.trim();
    if (composerLoopConfig?.enabled === true && consumedLoopThreadKey) {
      setSuppressedLoopThreads((prev) => {
        if (prev.has(consumedLoopThreadKey)) return prev;
        const next = new Set(prev);
        next.add(consumedLoopThreadKey);
        return next;
      });
    }
    // Clear local override; per-thread suppression keeps the one-shot loop
    // toggle off after a successful send until the user explicitly re-enables it.
    setComposerLoopConfig(undefined);
    setComposerLoopConfigDirty(false);
    if (!reply_thread_id && threadKey) {
      setAllowAutoSelectThread(false);
      setSelectedThreadKey(threadKey);
      setTimeout(() => {
        setSelectedThreadKey(threadKey);
      }, 100);
    }
    setTimeout(() => {
      if (anyOverlayOpen) return;
      scrollToBottomRef.current?.(true);
    }, 100);
  }
  function on_send(value?: string): void {
    sendMessage(value);
  }

  function on_send_immediately(value?: string): void {
    sendMessage(value, { immediate: true });
  }

  function onNewChat(): void {
    // Explicitly reset draft state for the global "new chat" composer bucket.
    advanceComposerSession();
    inputRef.current = "";
    setInput("");
    actions.deleteDraft(0);
    void clearComposerDraft(0);
    resetThreadSelectionForNewChat({
      actions,
      setAllowAutoSelectThread,
      setSelectedThreadKey,
    });
    setNewThreadSetup(defaultNewThreadSetup);
  }

  const activeCompletedCodexTurnNotification =
    completedCodexTurnNotifications[0];
  const notifyEnabledForCompletedCodexTurn = useMemo(() => {
    const notification = activeCompletedCodexTurnNotification;
    if (!notification) return codexTurnNotifyDefaultEnabled;
    return (
      codexTurnNotificationWatches.some(
        (watch) => watch.threadKey === notification.threadKey,
      ) || codexTurnNotifyDefaultEnabled
    );
  }, [
    activeCompletedCodexTurnNotification,
    codexTurnNotificationWatches,
    codexTurnNotifyDefaultEnabled,
  ]);

  const dismissCompletedCodexTurnNotification = useCallback(() => {
    setCompletedCodexTurnNotifications((prev) => prev.slice(1));
  }, []);

  const showCompletedCodexTurnNotification = useCallback(() => {
    const notification = activeCompletedCodexTurnNotification;
    if (!notification) return;
    dismissCompletedCodexTurnNotification();
    void (async () => {
      try {
        if (project_id && path?.trim()) {
          await redux.getProjectActions(project_id)?.open_file({
            path,
            foreground: true,
            foreground_project: true,
          });
        }
      } catch (err) {
        console.warn("chatroom: unable to foreground chat file", err);
      }
      setAllowAutoSelectThread(false);
      setSelectedThreadKey(notification.threadKey);
      const newestMessageDate = Number(notification.newestMessageDate);
      const scrollToNewest = () => {
        if (Number.isFinite(newestMessageDate)) {
          actions.scrollToDate(newestMessageDate, {
            persistFragment: false,
          });
        } else {
          scrollToBottomRef.current?.(true);
        }
      };
      for (const delayMs of [0, 50, 150, 300]) {
        window.setTimeout(scrollToNewest, delayMs);
      }
    })();
  }, [
    actions,
    activeCompletedCodexTurnNotification,
    dismissCompletedCodexTurnNotification,
    path,
    project_id,
    setAllowAutoSelectThread,
    setSelectedThreadKey,
  ]);

  const openGitBrowserForThread = useCallback(
    (threadKey: string) => {
      const threadId = normalizeThreadKey(threadKey);
      const metadata = actions.getThreadMetadata?.(threadKey, {
        threadId,
      });
      const codexConfig =
        actions.getCodexConfig?.(threadId ?? threadKey) ??
        metadata?.acp_config ??
        undefined;
      const wd =
        typeof codexConfig?.workingDirectory === "string" &&
        codexConfig.workingDirectory.trim()
          ? codexConfig.workingDirectory.trim()
          : undefined;
      setGitBrowserCwd(wd);
      setGitBrowserThreadKey(threadKey);
      setGitBrowserCommitHash(undefined);
      setGitBrowserOpen(true);
    },
    [actions],
  );

  const openAutomationModalForThread = useCallback(
    (threadKey: string) => {
      const normalized = `${threadKey ?? ""}`.trim();
      if (!normalized) return;
      if (normalized !== selectedThreadKey) {
        setSelectedThreadKey(normalized);
      }
      setAllowAutoSelectThread(false);
      setAutomationModalThreadKey(normalized);
      setAutomationModalOpen(true);
    },
    [selectedThreadKey, setSelectedThreadKey, setAllowAutoSelectThread],
  );

  const openGitBrowserFromMessage = useCallback(
    ({
      threadKey,
      cwdOverride,
      commitHash,
    }: {
      threadKey: string;
      cwdOverride?: string;
      commitHash: string;
    }) => {
      const normalizedThreadKey = `${threadKey ?? ""}`.trim();
      if (!normalizedThreadKey) return;
      setGitBrowserCwd(
        typeof cwdOverride === "string" && cwdOverride.trim()
          ? cwdOverride.trim()
          : undefined,
      );
      setGitBrowserThreadKey(normalizedThreadKey);
      setGitBrowserCommitHash(`${commitHash ?? ""}`.trim() || undefined);
      setGitBrowserOpen(true);
    },
    [],
  );

  const sendGitBrowserAgentPrompt = useCallback(
    async (prompt: string) => {
      const trimmed = `${prompt ?? ""}`.trim();
      if (!trimmed) return;
      const targetThreadKey = gitBrowserThreadKey ?? selectedThreadKey;
      const thread_id = normalizeThreadKey(targetThreadKey);
      actions.sendChat({
        extraInput: trimmed,
        reply_thread_id: thread_id,
        parent_message_id:
          `${(actions.getMessagesInThread(thread_id ?? "")?.slice(-1)[0] as any)?.message_id ?? ""}`.trim() ||
          undefined,
        preserveSelectedThread: true,
      });
    },
    [actions, gitBrowserThreadKey, selectedThreadKey],
  );

  const logGitBrowserDirectCommit = useCallback(
    async ({ hash, subject }: { hash: string; subject: string }) => {
      const commit = `${hash ?? ""}`.trim();
      if (!commit) return;
      const targetThreadKey = gitBrowserThreadKey ?? selectedThreadKey;
      const thread_id = normalizeThreadKey(targetThreadKey);
      const lines = ["Committed manually.", `Commit: ${commit}`];
      if (`${subject ?? ""}`.trim()) {
        lines.push(`Subject: ${subject.trim()}`);
      }
      actions.sendChat({
        extraInput: lines.join("\n"),
        reply_thread_id: thread_id,
        parent_message_id:
          `${(actions.getMessagesInThread(thread_id ?? "")?.slice(-1)[0] as any)?.message_id ?? ""}`.trim() ||
          undefined,
        preserveSelectedThread: true,
        skipModelDispatch: true,
      });
    },
    [actions, gitBrowserThreadKey, selectedThreadKey],
  );

  const findCommitInCurrentChat = useCallback(
    async (query: string) => {
      await findInChatAndOpenFirstResult({ actions, project_id, path, query });
      setGitBrowserOpen(false);
      setGitBrowserThreadKey(undefined);
    },
    [actions, path, project_id],
  );

  const openActivityFromGitBrowser = useCallback(() => {
    const targetThreadKey = gitBrowserThreadKey ?? selectedThreadKey;
    const thread_id = normalizeThreadKey(targetThreadKey);
    if (!thread_id) return;
    const threadMessages = actions.getMessagesInThread(thread_id) ?? [];
    let newestCodexDate: number | undefined;
    for (let i = threadMessages.length - 1; i >= 0; i--) {
      const msg = threadMessages[i];
      if (!field<string>(msg, "acp_account_id")) continue;
      const d = dateValue(msg);
      if (!d) continue;
      newestCodexDate = d.valueOf();
      break;
    }
    if (!Number.isFinite(newestCodexDate)) return;
    if (targetThreadKey && targetThreadKey !== selectedThreadKey) {
      setSelectedThreadKey(targetThreadKey);
    }
    setGitBrowserOpen(false);
    setGitBrowserThreadKey(undefined);
    setActivityJumpDate(`${newestCodexDate}`);
    setActivityJumpToken((n) => n + 1);
  }, [actions, gitBrowserThreadKey, selectedThreadKey, setSelectedThreadKey]);

  const activeLoopState =
    isSelectedThreadCodex &&
    selectedThreadLoopState &&
    selectedThreadLoopState.status !== "stopped"
      ? selectedThreadLoopState
      : undefined;
  const latestSelectedThreadCodexActivityDate = useMemo(
    () => getLatestCodexActivityDate(selectedThreadMessages),
    [selectedThreadMessages],
  );

  const loopBanner = activeLoopState ? (
    <Alert
      type={activeLoopState.status === "paused" ? "warning" : "info"}
      style={{ margin: "8px 8px 0 8px" }}
      title={
        <Space size="small" wrap>
          <strong>Codex loop</strong>
          <Tag
            color={
              activeLoopState.status === "paused" ? "orange" : "processing"
            }
          >
            {activeLoopState.status}
          </Tag>
          <span>
            Iteration {activeLoopState.iteration}
            {typeof activeLoopState.max_turns === "number"
              ? ` / ${activeLoopState.max_turns}`
              : ""}
          </span>
          {typeof activeLoopState.max_wall_time_ms === "number" ? (
            <span>
              Max wall time{" "}
              {Math.max(
                1,
                Math.round(activeLoopState.max_wall_time_ms / 60000),
              )}{" "}
              min
            </span>
          ) : null}
          {typeof activeLoopState.updated_at_ms === "number" ? (
            <span>
              Updated <TimeAgo date={new Date(activeLoopState.updated_at_ms)} />
            </span>
          ) : null}
        </Space>
      }
      description={
        <Space size="small" wrap>
          {activeLoopState.next_prompt ? (
            <span>Next prompt queued.</span>
          ) : null}
          {activeLoopState.stop_reason ? (
            <span>{activeLoopState.stop_reason}</span>
          ) : null}
          {latestSelectedThreadCodexActivityDate ? (
            <Button
              size="small"
              type="link"
              style={{ padding: 0, height: "auto" }}
              onClick={() => {
                setActivityJumpDate(latestSelectedThreadCodexActivityDate);
                setActivityJumpToken((n) => n + 1);
              }}
            >
              View activity log
            </Button>
          ) : null}
        </Space>
      }
    />
  ) : null;

  const automationBanner = selectedThreadAutomationConfig ? (
    <Alert
      type={
        selectedThreadAutomationState?.status === "error"
          ? "error"
          : selectedThreadAutomationState?.status === "paused"
            ? "warning"
            : "info"
      }
      style={{ margin: "8px 8px 0 8px" }}
      title={
        <Space size="small" wrap>
          <strong>
            {selectedThreadAutomationConfig.title?.trim() ||
              "Scheduled automation"}
          </strong>
          <Tag
            color={
              selectedThreadAutomationConfig.enabled === false
                ? "default"
                : "blue"
            }
          >
            {selectedThreadAutomationState?.status ??
              (selectedThreadAutomationConfig.enabled === false
                ? "paused"
                : "active")}
          </Tag>
          {describeAutomationSchedule(selectedThreadAutomationConfig) ? (
            <span>
              {describeAutomationSchedule(selectedThreadAutomationConfig)}.
            </span>
          ) : null}
          {selectedThreadAutomationState?.next_run_at_ms != null &&
          shouldShowAutomationNextRun({
            enabled: selectedThreadAutomationConfig.enabled,
            status: selectedThreadAutomationState?.status,
            next_run_at_ms: selectedThreadAutomationState.next_run_at_ms,
          }) ? (
            <span>
              Next run{" "}
              <TimeAgo
                date={new Date(selectedThreadAutomationState.next_run_at_ms)}
              />
              .
            </span>
          ) : null}
          {selectedThreadAutomationState?.last_run_finished_at_ms ? (
            <span>
              Last run{" "}
              <TimeAgo
                date={
                  new Date(
                    selectedThreadAutomationState.last_run_finished_at_ms,
                  )
                }
              />
              .
            </span>
          ) : null}
          {typeof selectedThreadAutomationState?.unacknowledged_runs ===
            "number" &&
          selectedThreadAutomationState.unacknowledged_runs > 0 ? (
            <Tag color="orange">
              {selectedThreadAutomationState.unacknowledged_runs} unacknowledged
            </Tag>
          ) : null}
        </Space>
      }
      description={
        <Space size="small" wrap>
          {selectedThreadAutomationState?.paused_reason ? (
            <span>
              {formatAutomationPausedReason(
                selectedThreadAutomationState.paused_reason,
              )}
            </span>
          ) : null}
          {selectedThreadAutomationState?.last_error ? (
            <span>{selectedThreadAutomationState.last_error}</span>
          ) : null}
          <Button size="small" onClick={() => void handleAutomationRunNow()}>
            Run now
          </Button>
          {selectedThreadAutomationState?.status === "paused" ||
          selectedThreadAutomationConfig.enabled === false ? (
            <Button size="small" onClick={() => void handleAutomationResume()}>
              Resume
            </Button>
          ) : (
            <Button size="small" onClick={() => void handleAutomationPause()}>
              Pause
            </Button>
          )}
          <Button
            size="small"
            onClick={() => void handleAutomationAcknowledge()}
          >
            Acknowledge
          </Button>
          {selectedThreadKey ? (
            <Button
              size="small"
              onClick={() => openAutomationModalForThread(selectedThreadKey)}
            >
              Edit
            </Button>
          ) : null}
          <Popconfirm
            title="Delete scheduled automation?"
            description="This removes the schedule from this chat thread."
            okText="Delete"
            cancelText="Cancel"
            onConfirm={() => void handleAutomationDelete()}
          >
            <Button danger size="small">
              Delete schedule
            </Button>
          </Popconfirm>
        </Space>
      }
    />
  ) : null;

  const renderChatContent = () => (
    <div className="smc-vfill" style={GRID_STYLE}>
      <ChatRoomThreadPanel
        actions={actions}
        project_id={project_id}
        path={path}
        messages={messages as ChatMessages}
        threadIndex={indexedThreads ?? threadIndex}
        acpState={acpState}
        scrollToBottomRef={scrollToBottomRef}
        scrollCacheId={scrollCacheId}
        fontSize={fontSize}
        selectedThreadKey={selectedThreadKey}
        selectedThread={selectedThread}
        variant={variant}
        scrollToIndex={scrollToIndex}
        scrollToDate={scrollToDate}
        fragmentId={fragmentId}
        threadsCount={threads.length}
        onNewChat={() => {
          onNewChat();
        }}
        codexPaymentSource={codexPaymentSource}
        codexPaymentSourceLoading={codexPaymentSourceLoading}
        refreshCodexPaymentSource={refreshCodexPaymentSource}
        newThreadSetup={newThreadSetup}
        onNewThreadSetupChange={setNewThreadSetup}
        onCreateThread={createThreadWithoutMessage}
        showThreadImagePreview={showThreadImagePreview}
        hideChatTypeSelector={hideChatTypeSelector}
        activityJumpDate={activityJumpDate}
        activityJumpToken={activityJumpToken}
        shortcutEnabled={isVisible && tabIsVisible}
        onOpenGitBrowser={openGitBrowserFromMessage}
        notifyOnTurnFinish={notifyOnSelectedTurnFinish}
        onNotifyOnTurnFinishChange={setNotifyOnSelectedTurnFinish}
        allowSidebarToggle={!hideSidebar && !isCompact && !isExternalSideChat}
        sidebarHidden={sidebarHidden}
        onToggleSidebar={() => setSidebarHidden((hidden) => !hidden)}
      />
      {loopBanner}
      {automationBanner}
      <ChatRoomComposer
        actions={actions}
        project_id={project_id}
        path={path}
        fontSize={fontSize}
        composerDraftKey={composerDraftKey}
        composerSession={composerSession}
        input={input}
        setInput={setComposerInput}
        on_send={on_send}
        on_send_immediately={on_send_immediately}
        submitMentionsRef={submitMentionsRef}
        hasInput={hasInput}
        isSelectedThreadAI={isSelectedThreadAI}
        hasActiveAcpTurn={hasRunningAcpTurn}
        threads={threads}
        selectedThread={selectedThread}
        onComposerFocusChange={() => undefined}
        onComposerReady={onComposerReady}
        codexPaymentSource={codexPaymentSource}
        codexPaymentSourceLoading={codexPaymentSourceLoading}
        showLoopControls={isSelectedThreadCodex}
        loopConfig={composerLoopConfig}
        onLoopConfigChange={handleLoopConfigChange}
      />
      <Modal
        title="Codex turn finished"
        open={activeCompletedCodexTurnNotification != null}
        destroyOnHidden
        onCancel={dismissCompletedCodexTurnNotification}
        footer={[
          <Button key="cancel" onClick={dismissCompletedCodexTurnNotification}>
            Cancel
          </Button>,
          <Button
            key="show"
            type="primary"
            onClick={showCompletedCodexTurnNotification}
          >
            Show
          </Button>,
        ]}
      >
        <p style={{ marginBottom: 0 }}>
          Codex finished working in{" "}
          <strong>
            {activeCompletedCodexTurnNotification?.threadLabel ?? "this chat"}
          </strong>
          .
        </p>
        {activeCompletedCodexTurnNotification ? (
          <div style={{ marginTop: 12 }}>
            <Checkbox
              checked={notifyEnabledForCompletedCodexTurn}
              onChange={(e) =>
                setNotifyForThread({
                  checked: e.target.checked,
                  threadKey: activeCompletedCodexTurnNotification.threadKey,
                  threadId: activeCompletedCodexTurnNotification.threadId,
                  threadLabel: activeCompletedCodexTurnNotification.threadLabel,
                })
              }
            >
              Notify
            </Checkbox>
          </div>
        ) : null}
      </Modal>
      <Modal
        title="Thread automation"
        open={automationModalOpen}
        destroyOnHidden
        onCancel={() => setAutomationModalOpen(false)}
        onOk={() => {
          void handleAutomationModalSave();
        }}
        okText="Save"
        confirmLoading={automationSaving}
      >
        <AutomationConfigFields
          draft={automationDraft}
          allowCodexRunKind={automationModalAllowsCodex}
          onChange={(patch) =>
            setAutomationDraft((prev) => ({ ...prev, ...patch }))
          }
        />
      </Modal>
    </div>
  );

  if (messages == null) {
    return <Loading theme={"medium"} />;
  }

  return (
    <div
      onMouseMove={mark_as_read}
      onClick={mark_as_read}
      onWheel={mark_as_read}
      onTouchMove={mark_as_read}
      onFocusCapture={onFocus}
      className="smc-vfill"
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <ChatRoomLayout
        variant={variant === "compact" ? "compact" : "default"}
        sidebarWidth={sidebarWidth}
        setSidebarWidth={setSidebarWidth}
        sidebarVisible={sidebarVisible}
        setSidebarVisible={setSidebarVisible}
        totalUnread={totalUnread}
        hideSidebar={hideSidebar || sidebarHidden}
        sidebarContent={
          <ChatRoomSidebarContent
            actions={actions}
            acpState={acpState}
            isCompact={isCompact}
            selectedThreadKey={selectedThreadKey}
            setSelectedThreadKey={setSelectedThreadKey}
            setAllowAutoSelectThread={setAllowAutoSelectThread}
            setSidebarVisible={setSidebarVisible}
            threadSections={threadSections}
            archivedThreads={archivedThreads}
            openAppearanceModal={
              modalHandlers?.openAppearanceModal ??
              ((_threadKey, _label, _useCurrentLabel, _color, _icon) =>
                undefined)
            }
            openBehaviorModal={
              modalHandlers?.openBehaviorModal ?? (() => undefined)
            }
            openGitBrowser={openGitBrowserForThread}
            openExportModal={
              modalHandlers?.openExportModal ?? (() => undefined)
            }
            openImportModal={
              modalHandlers?.openImportModal ?? (() => undefined)
            }
            openForkModal={modalHandlers?.openForkModal ?? (() => undefined)}
            confirmResetThread={
              threadActionHandlers?.confirmResetThread ?? (() => undefined)
            }
            confirmDeleteThread={
              threadActionHandlers?.confirmDeleteThread ?? (() => undefined)
            }
            openAutomationModal={openAutomationModalForThread}
          />
        }
        chatContent={renderChatContent()}
        onNewChat={() => {
          onNewChat();
        }}
        newChatSelected={!selectedThreadKey}
      />
      <ChatRoomModals
        actions={actions}
        path={path}
        selectedThreadKey={selectedThreadKey}
        selectedThreadLabel={selectedThread?.label}
        onHandlers={setModalHandlers}
      />
      <ChatRoomThreadActions
        actions={actions}
        path={path}
        selectedThreadKey={selectedThreadKey}
        setSelectedThreadKey={setSelectedThreadKey}
        onHandlers={setThreadActionHandlers}
      />
      <GitCommitDrawer
        projectId={project_id}
        sourcePath={path}
        cwdOverride={gitBrowserCwd}
        commitHash={gitBrowserCommitHash}
        open={gitBrowserOpen}
        onClose={() => {
          setGitBrowserOpen(false);
          setGitBrowserThreadKey(undefined);
        }}
        fontSize={fontSize}
        onRequestAgentTurn={sendGitBrowserAgentPrompt}
        onDirectCommitLogged={logGitBrowserDirectCommit}
        onFindInChat={findCommitInCurrentChat}
        onOpenActivityLog={openActivityFromGitBrowser}
      />
    </div>
  );
}

function ChatRoomInner({
  actions,
  project_id,
  path,
  font_size,
  desc,
  onFocus,
  is_visible,
  tab_is_visible,
}: EditorComponentProps) {
  const { messages, threadIndex, version } = useChatDoc();
  const useEditor = useEditorRedux<ChatState>({ project_id, path });
  // subscribe to syncdbReady to force re-render when sync attaches
  useEditor("syncdbReady");
  const readStateVersion = useEditor("readStateVersion");
  return (
    <ChatPanel
      actions={actions}
      project_id={project_id}
      path={path}
      messages={messages}
      threadIndex={threadIndex}
      docVersion={version}
      readStateVersion={readStateVersion}
      fontSize={font_size}
      desc={desc}
      variant="default"
      onFocus={onFocus}
      isVisible={is_visible}
      tabIsVisible={tab_is_visible}
    />
  );
}

export function ChatRoom(props: EditorComponentProps) {
  return (
    <ChatDocProvider cache={props.actions?.messageCache}>
      <ChatRoomInner {...props} />
    </ChatDocProvider>
  );
}
