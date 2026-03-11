/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { IS_MOBILE } from "@cocalc/frontend/feature";
import {
  React,
  useCallback,
  useEditorRedux,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Loading } from "@cocalc/frontend/components";
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
import {
  getMessageByLookup,
  markChatAsReadIfUnseen,
  stableDraftKeyFromThreadKey,
} from "./utils";
import { COMBINED_FEED_KEY, useThreadSections } from "./threads";
import { ChatDocProvider, useChatDoc } from "./doc-context";
import { useChatComposerDraft } from "./use-chat-composer-draft";
import * as immutable from "immutable";
import { useChatThreadSelection } from "./thread-selection";
import { dateValue, field } from "./access";
import { useCodexPaymentSource } from "./use-codex-payment-source";
import { resetAcpThreadState } from "./acp-api";
import {
  upsertAgentSessionRecord,
  type AgentSessionRecord,
} from "./agent-session-index";
import { resolveAgentSessionIdForThread } from "./thread-session";
import { findInChatAndOpenFirstResult } from "./find-in-chat";
import type { AcpLoopConfig } from "@cocalc/conat/ai/acp/types";
import { useAnyChatOverlayOpen } from "./drawer-overlay-state";
import type { CodexThreadConfig } from "@cocalc/chat";
import { resolveCodexSessionMode } from "@cocalc/util/ai/codex";
import { persistExternalSideChatSelectedThreadKey } from "./external-side-chat-selection";
import { resolveCombinedComposerTargetKey } from "./combined-composer-target";

const GRID_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  margin: "auto",
  minHeight: 0,
  flex: 1,
} as const;

const DEFAULT_SIDEBAR_WIDTH = 260;
const COMBINED_FEED_MAX_PER_THREAD = 5;
const ACP_ACTIVE_STATES = new Set(["queue", "sending", "sent", "running"]);

function normalizeThreadKey(value?: string | null): string | undefined {
  const key = `${value ?? ""}`.trim();
  if (!key || key === COMBINED_FEED_KEY) return undefined;
  return key;
}

export function enabledLoopConfig(
  config?: AcpLoopConfig,
): AcpLoopConfig | undefined {
  return config?.enabled === true ? config : undefined;
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
    if (!isAcpTurn) return true;
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

function parseDateISOString(value: unknown): string | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value as string | number);
  if (!Number.isFinite(d.valueOf())) return undefined;
  return d.toISOString();
}

type MessageKeyWithTime = { key: string; time: number };

function pickNewestMessageKeys(
  entry: ThreadIndexEntry,
  messages: ChatMessages | undefined,
  limit: number,
): MessageKeyWithTime[] {
  if (!messages || limit <= 0) return [];
  const newest: MessageKeyWithTime[] = [];
  for (const key of entry.messageKeys) {
    const message = getMessageByLookup({ messages, key });
    if (!message) continue;
    const d = dateValue(message);
    if (!d) continue;
    const time = d.valueOf();
    if (!Number.isFinite(time)) continue;
    if (newest.length < limit) {
      newest.push({ key, time });
      newest.sort((a, b) => a.time - b.time);
      continue;
    }
    if (time <= newest[0].time) continue;
    newest[0] = { key, time };
    newest.sort((a, b) => a.time - b.time);
  }
  return newest;
}

function buildCombinedFeedKeys(
  threadIndex: Map<string, ThreadIndexEntry>,
  messages: ChatMessages | undefined,
  limitPerThread: number,
): string[] {
  const collected: MessageKeyWithTime[] = [];
  for (const entry of threadIndex.values()) {
    if (!entry.messageCount) continue;
    collected.push(...pickNewestMessageKeys(entry, messages, limitPerThread));
  }
  collected.sort((a, b) => a.time - b.time);
  return collected.map((item) => item.key);
}

export interface ChatPanelProps {
  actions: ChatActions;
  project_id: string;
  path: string;
  messages?: ChatMessages;
  threadIndex?: Map<string, ThreadIndexEntry>;
  docVersion?: number;
  fontSize?: number;
  desc?: NodeDesc;
  variant?: "default" | "compact";
  hideSidebar?: boolean;
  onFocus?: () => void;
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
  fontSize = 13,
  desc,
  variant = "default",
  hideSidebar = false,
  onFocus,
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
  const preferLatestThreadFromDescRaw = getDescValue(
    desc,
    "data-preferLatestThread",
  );
  const preferLatestThreadFromDesc =
    preferLatestThreadFromDescRaw === true ||
    preferLatestThreadFromDescRaw === "true" ||
    preferLatestThreadFromDescRaw === 1;
  const [sidebarWidth, setSidebarWidth] = useState<number>(
    typeof storedSidebarWidth === "number" && storedSidebarWidth > 50
      ? storedSidebarWidth
      : DEFAULT_SIDEBAR_WIDTH,
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
  const lastScrollRequestRef = useRef<{
    thread: string;
    reason: "unread" | "allread";
  } | null>(null);
  const visitedThreadsRef = useRef<Set<string>>(new Set());
  const unreadSeenRef = useRef<Map<string, number>>(new Map());
  const newestSeenRef = useRef<Map<string, number>>(new Map());
  const indexedAgentSessionsRef = useRef<Map<string, string>>(new Map());
  const combinedReadSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!actions?.frameTreeActions?.set_frame_data || !actions?.frameId) return;
    actions.frameTreeActions.set_frame_data({
      id: actions.frameId,
      sidebarWidth,
    });
  }, [sidebarWidth, actions?.frameTreeActions, actions?.frameId]);

  const { threads, archivedThreads, combinedThread, threadSections } =
    useThreadSections({
      messages,
      threadIndex,
      activity,
      accountId: account_id,
      actions,
      version: docVersion,
    });

  const {
    selectedThreadKey,
    setSelectedThreadKey,
    setAllowAutoSelectThread,
    isCombinedFeedSelected,
    singleThreadView,
    selectedThread,
  } = useChatThreadSelection({
    actions,
    threads,
    messages,
    fragmentId,
    storedThreadFromDesc,
    preferLatestThread: preferLatestThreadFromDesc,
  });

  useEffect(() => {
    if (!actions?.frameTreeActions?.set_frame_data || !actions?.frameId) return;
    const persistedSelectedThreadKey =
      selectedThreadKey != null && selectedThreadKey !== COMBINED_FEED_KEY
        ? selectedThreadKey
        : null;
    if ((storedThreadFromDesc ?? null) === persistedSelectedThreadKey) return;
    actions.frameTreeActions.set_frame_data({
      id: actions.frameId,
      selectedThreadKey: persistedSelectedThreadKey,
    });
  }, [
    selectedThreadKey,
    storedThreadFromDesc,
    actions?.frameTreeActions,
    actions?.frameId,
  ]);

  useEffect(() => {
    if (actions?.frameTreeActions?.set_frame_data && actions?.frameId) return;
    const persistedSelectedThreadKey =
      selectedThreadKey != null && selectedThreadKey !== COMBINED_FEED_KEY
        ? selectedThreadKey
        : null;
    persistExternalSideChatSelectedThreadKey({
      project_id,
      path,
      selectedThreadKey: persistedSelectedThreadKey,
    });
  }, [
    project_id,
    path,
    selectedThreadKey,
    actions?.frameTreeActions,
    actions?.frameId,
  ]);

  const [composerTargetKey, setComposerTargetKey] = useState<string | null>(
    null,
  );
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerSession, setComposerSession] = useState(0);
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
          baseNewThreadSetup.codexConfig.workingDirectory,
      },
    };
  }, [desc]);
  const [newThreadSetup, setNewThreadSetup] = useState<NewThreadSetup>(
    defaultNewThreadSetup,
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
  const inputRef = useRef<string>(input);
  const composerSessionRef = useRef<number>(composerSession);
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
    selectedThreadMetadata?.agent_kind === "acp" ||
    (isSelectedThreadAI &&
      typeof selectedThreadMetadata?.agent_model === "string" &&
      `${selectedThreadMetadata.agent_model}`.toLowerCase().includes("codex"));

  const persistedLoopConfig = useMemo(
    () => enabledLoopConfig(selectedThreadMetadata?.loop_config),
    [selectedThreadMetadata?.loop_config],
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

  const selectedThreadLookupKey = selectedThreadId;
  const selectedThreadMessages = useMemo(
    () =>
      selectedThreadLookupKey != null
        ? (actions.getMessagesInThread(selectedThreadLookupKey) ?? [])
        : [],
    [actions, selectedThreadLookupKey, messages],
  );
  const hasRunningAcpTurn = useMemo(() => {
    return hasActiveAcpTurnForComposer({
      isSelectedThreadAI,
      selectedThreadId,
      selectedThreadMessages,
      acpState,
    });
  }, [isSelectedThreadAI, selectedThreadId, selectedThreadMessages, acpState]);

  const agentSessionRecords = useMemo<AgentSessionRecord[]>(() => {
    if (typeof account_id !== "string" || !account_id.trim()) {
      return [];
    }
    const records: AgentSessionRecord[] = [];
    for (const thread of threads) {
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
      const threadState =
        threadId != null ? acpState?.get?.(`thread:${threadId}`) : undefined;
      const status = thread.isArchived
        ? "archived"
        : typeof threadState === "string" && ACP_ACTIVE_STATES.has(threadState)
          ? "running"
          : "active";
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
  }, [account_id, acpState, actions, path, project_id, threads]);

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

  const combinedFeedIndex = useMemo(() => {
    if (!threadIndex) return undefined;
    const combinedKeys = buildCombinedFeedKeys(
      threadIndex,
      messages,
      COMBINED_FEED_MAX_PER_THREAD,
    );
    const next = new Map(threadIndex);
    if (combinedThread) {
      const entry: ThreadIndexEntry = {
        key: COMBINED_FEED_KEY,
        newestTime: combinedThread.newestTime,
        messageCount: combinedKeys.length,
        messageKeys: new Set(combinedKeys),
        orderedKeys: combinedKeys,
        rootMessage: undefined,
      };
      next.set(COMBINED_FEED_KEY, entry);
    }
    // Ensure config-only threads have explicit empty index entries so selecting
    // them doesn't fall back to rendering all messages.
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
  }, [threadIndex, messages, combinedThread, threads]);

  const scrollCacheId = useMemo(() => {
    const base = `${project_id ?? ""}${path ?? ""}`;
    return `${base}-${selectedThreadKey ?? COMBINED_FEED_KEY}`;
  }, [project_id, path, selectedThreadKey]);

  useEffect(() => {
    const nextTargetKey = resolveCombinedComposerTargetKey(
      composerTargetKey,
      threads,
      isCombinedFeedSelected,
    );
    if (nextTargetKey !== composerTargetKey) {
      setComposerTargetKey(nextTargetKey);
    }
  }, [isCombinedFeedSelected, threads, composerTargetKey]);

  const combinedUnreadThreads = useMemo(
    () => threads.filter((thread) => (thread.unreadCount ?? 0) > 0),
    [threads],
  );
  const combinedReadSignature = useMemo(
    () =>
      combinedUnreadThreads
        .map(
          (thread) =>
            `${thread.key}:${thread.unreadCount ?? 0}:${thread.messageCount ?? 0}:${Number.isFinite(thread.newestTime) ? thread.newestTime : 0}`,
        )
        .join("|"),
    [combinedUnreadThreads],
  );

  useEffect(() => {
    if (!isCombinedFeedSelected) {
      combinedReadSignatureRef.current = null;
    }
  }, [isCombinedFeedSelected]);

  const mark_as_read = useCallback(() => {
    markChatAsReadIfUnseen(project_id, path);
    if (!isCombinedFeedSelected || !actions?.markThreadRead) return;
    if (
      combinedUnreadThreads.length === 0 ||
      combinedReadSignatureRef.current === combinedReadSignature
    ) {
      return;
    }
    combinedReadSignatureRef.current = combinedReadSignature;
    for (let i = 0; i < combinedUnreadThreads.length; i++) {
      const thread = combinedUnreadThreads[i];
      actions.markThreadRead(
        thread.key,
        thread.messageCount,
        i === combinedUnreadThreads.length - 1,
      );
    }
  }, [
    project_id,
    path,
    isCombinedFeedSelected,
    actions,
    combinedUnreadThreads,
    combinedReadSignature,
  ]);

  useEffect(() => {
    if (!singleThreadView || !selectedThreadKey) return;
    const thread = threads.find((t) => t.key === selectedThreadKey);
    if (!thread || !actions) return;

    const unread = Math.max(thread.unreadCount ?? 0, 0);
    const prevUnread = unreadSeenRef.current.get(thread.key) ?? 0;
    const newest = Number.isFinite(thread.newestTime) ? thread.newestTime : 0;
    const prevNewest = newestSeenRef.current.get(thread.key) ?? newest;
    const visited = visitedThreadsRef.current.has(thread.key);
    const hasNewUnread = unread > 0 && unread !== prevUnread;
    const newestAdvanced = newest > prevNewest;

    const scrollToFirstUnread = () => {
      const total = thread.messageCount ?? 0;
      const index = Math.max(0, Math.min(total - 1, total - unread));
      lastScrollRequestRef.current = { thread: thread.key, reason: "unread" };
      actions.scrollToIndex?.(index);
    };

    if (hasNewUnread || (!visited && unread > 0)) {
      if (visited && hasNewUnread && !newestAdvanced) {
        // Archived/history hydration can increase thread.messageCount (and thus
        // unreadCount) without any new newest message. Keep viewport stable.
        actions.markThreadRead?.(thread.key, thread.messageCount);
        unreadSeenRef.current.set(thread.key, unread);
        newestSeenRef.current.set(thread.key, newest);
        return;
      }
      if (thread.isAI) {
        lastScrollRequestRef.current = { thread: thread.key, reason: "unread" };
        actions.scrollToIndex?.(Number.MAX_SAFE_INTEGER);
      } else {
        scrollToFirstUnread();
      }
      actions.markThreadRead?.(thread.key, thread.messageCount);
      visitedThreadsRef.current.add(thread.key);
      unreadSeenRef.current.set(thread.key, unread);
      newestSeenRef.current.set(thread.key, newest);
      return;
    }

    if (!visited && unread === 0) {
      lastScrollRequestRef.current = { thread: thread.key, reason: "allread" };
      actions.scrollToIndex?.(Number.MAX_SAFE_INTEGER);
      visitedThreadsRef.current.add(thread.key);
      unreadSeenRef.current.set(thread.key, unread);
      newestSeenRef.current.set(thread.key, newest);
      return;
    }

    // Already visited and no new unread: preserve existing scroll (cached per thread via virtuoso cacheId).
    unreadSeenRef.current.set(thread.key, unread);
    newestSeenRef.current.set(thread.key, newest);
  }, [singleThreadView, selectedThreadKey, threads, actions]);

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
    if (isCombinedFeedSelected) {
      return resolveFromThreadKey(composerTargetKey ?? threads[0]?.key);
    }
    return resolveFromThreadKey(selectedThreadKey);
  }

  function interruptThreadIfRunning({
    thread_id,
    lookup,
  }: {
    thread_id?: string;
    lookup?: string;
  }): void {
    const threadMessages =
      (lookup ? actions.getMessagesInThread(lookup) : undefined) ?? [];
    const sessionId = resolveAgentSessionIdForThread({
      actions,
      threadId: thread_id,
      threadKey: thread_id ?? "",
      persistedSessionId: thread_id
        ? actions.getCodexConfig(thread_id)?.sessionId
        : undefined,
    });
    for (const msg of threadMessages) {
      if (field<boolean>(msg, "generating") !== true) continue;
      const msgDate = dateValue(msg);
      if (!msgDate) continue;
      const threadId = field<string>(msg, "thread_id");
      const threadState =
        threadId != null ? acpState?.get?.(`thread:${threadId}`) : undefined;
      const messageId = field<string>(msg, "message_id");
      const msgState =
        (messageId ? acpState?.get?.(`message:${messageId}`) : undefined) ??
        acpState?.get?.(`${msgDate.valueOf()}`);
      const isActive =
        (typeof threadState === "string" &&
          ACP_ACTIVE_STATES.has(threadState)) ||
        (typeof msgState === "string" && ACP_ACTIVE_STATES.has(msgState));
      if (!isActive) continue;
      const interruptTargetThreadId =
        field<string>(msg, "acp_thread_id") ?? sessionId;
      if (!interruptTargetThreadId) continue;
      actions.languageModelStopGenerating(new Date(msgDate.valueOf()), {
        threadId: interruptTargetThreadId,
        senderId: field<string>(msg, "sender_id"),
      });
    }
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
      // Creating a new thread should never auto-fallback to Combined while
      // thread metadata is hydrating.
      setAllowAutoSelectThread(false);
    } else if (isCombinedFeedSelected) {
      setAllowAutoSelectThread(false);
    }

    if (reply_thread_id && opts?.immediate && isSelectedThreadAI) {
      interruptThreadIfRunning(target);
      resetAcpThreadState({
        actions,
        threadId: reply_thread_id,
      });
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
      // Replies sent from Combined should keep Combined selected.
      // Brand new threads should always switch to the newly created thread.
      preserveSelectedThread: isCombinedFeedSelected && reply_thread_id != null,
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
    setAllowAutoSelectThread(false);
    setSelectedThreadKey(null);
    setNewThreadSetup(defaultNewThreadSetup);
  }

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

  const sendGitBrowserAgentPrompt = useCallback(
    async (prompt: string) => {
      const trimmed = `${prompt ?? ""}`.trim();
      if (!trimmed) return;
      const targetThreadKey =
        gitBrowserThreadKey ?? selectedThreadKey ?? composerTargetKey;
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
    [actions, gitBrowserThreadKey, selectedThreadKey, composerTargetKey],
  );

  const logGitBrowserDirectCommit = useCallback(
    async ({ hash, subject }: { hash: string; subject: string }) => {
      const commit = `${hash ?? ""}`.trim();
      if (!commit) return;
      const targetThreadKey =
        gitBrowserThreadKey ?? selectedThreadKey ?? composerTargetKey;
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
    [actions, gitBrowserThreadKey, selectedThreadKey, composerTargetKey],
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
    const targetThreadKey =
      gitBrowserThreadKey ?? selectedThreadKey ?? composerTargetKey;
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
  }, [
    actions,
    gitBrowserThreadKey,
    selectedThreadKey,
    composerTargetKey,
    setSelectedThreadKey,
  ]);

  const renderChatContent = () => (
    <div className="smc-vfill" style={GRID_STYLE}>
      <ChatRoomThreadPanel
        actions={actions}
        project_id={project_id}
        path={path}
        messages={messages as ChatMessages}
        threadIndex={combinedFeedIndex ?? threadIndex}
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
        composerTargetKey={composerTargetKey}
        composerFocused={composerFocused}
        codexPaymentSource={codexPaymentSource}
        codexPaymentSourceLoading={codexPaymentSourceLoading}
        refreshCodexPaymentSource={refreshCodexPaymentSource}
        newThreadSetup={newThreadSetup}
        onNewThreadSetupChange={setNewThreadSetup}
        showThreadImagePreview={showThreadImagePreview}
        hideChatTypeSelector={hideChatTypeSelector}
        activityJumpDate={activityJumpDate}
        activityJumpToken={activityJumpToken}
      />
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
        combinedFeedSelected={isCombinedFeedSelected}
        composerTargetKey={composerTargetKey}
        threads={threads}
        selectedThread={selectedThread}
        onComposerTargetChange={setComposerTargetKey}
        onComposerFocusChange={setComposerFocused}
        codexPaymentSource={codexPaymentSource}
        codexPaymentSourceLoading={codexPaymentSourceLoading}
        showLoopControls={isSelectedThreadCodex}
        loopConfig={composerLoopConfig}
        onLoopConfigChange={handleLoopConfigChange}
      />
    </div>
  );

  if (messages == null) {
    return <Loading theme={"medium"} />;
  }

  return (
    <div
      onMouseMove={mark_as_read}
      onClick={mark_as_read}
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
        hideSidebar={hideSidebar}
        sidebarContent={
          <ChatRoomSidebarContent
            actions={actions}
            isCompact={isCompact}
            selectedThreadKey={selectedThreadKey}
            setSelectedThreadKey={setSelectedThreadKey}
            setAllowAutoSelectThread={setAllowAutoSelectThread}
            setSidebarVisible={setSidebarVisible}
            threadSections={threadSections}
            archivedThreads={archivedThreads}
            combinedThread={combinedThread}
            openRenameModal={
              modalHandlers?.openRenameModal ??
              ((_threadKey, _label, _useCurrentLabel, _color, _icon) =>
                undefined)
            }
            openGitBrowser={openGitBrowserForThread}
            openExportModal={
              modalHandlers?.openExportModal ?? (() => undefined)
            }
            openForkModal={modalHandlers?.openForkModal ?? (() => undefined)}
            confirmDeleteThread={
              threadActionHandlers?.confirmDeleteThread ?? (() => undefined)
            }
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
        selectedThreadLabel={
          !isCombinedFeedSelected ? selectedThread?.label : undefined
        }
        isCombinedFeedSelected={isCombinedFeedSelected}
        onHandlers={setModalHandlers}
      />
      <ChatRoomThreadActions
        actions={actions}
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
}: EditorComponentProps) {
  const { messages, threadIndex, version } = useChatDoc();
  const useEditor = useEditorRedux<ChatState>({ project_id, path });
  // subscribe to syncdbReady to force re-render when sync attaches
  useEditor("syncdbReady");
  return (
    <ChatPanel
      actions={actions}
      project_id={project_id}
      path={path}
      messages={messages}
      threadIndex={threadIndex}
      docVersion={version}
      fontSize={font_size}
      desc={desc}
      variant="default"
      onFocus={onFocus}
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
