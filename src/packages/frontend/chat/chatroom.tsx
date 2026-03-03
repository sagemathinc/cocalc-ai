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
  DEFAULT_NEW_THREAD_SETUP,
  type NewThreadSetup,
} from "./chatroom-thread-panel";
import type { ChatState } from "./store";
import type { ChatMessages, SubmitMentionsFn } from "./types";
import type { ThreadIndexEntry } from "./message-cache";
import {
  getMessageByLookup,
  markChatAsReadIfUnseen,
  newest_content,
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
import { webapp_client } from "@cocalc/frontend/webapp-client";

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

function parseDateISOString(value: unknown): string | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value as string | number);
  if (!Number.isFinite(d.valueOf())) return undefined;
  return d.toISOString();
}

function stableDraftKeyFromThreadKey(threadKey: string): number {
  let hash = 0;
  for (let i = 0; i < threadKey.length; i++) {
    hash = (hash * 33 + threadKey.charCodeAt(i)) >>> 0;
  }
  // keep it negative and non-zero so it doesn't collide with root draft key 0
  return -(hash || 1);
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
  const hideChatTypeSelectorRaw = getDescValue(desc, "data-hideChatTypeSelector");
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
  useEffect(() => {
    if (!actions?.frameTreeActions?.set_frame_data || !actions?.frameId) return;
    actions.frameTreeActions.set_frame_data({
      id: actions.frameId,
      sidebarWidth,
    });
  }, [sidebarWidth, actions?.frameTreeActions, actions?.frameId]);

  const { threads, archivedThreads, combinedThread, threadSections } = useThreadSections({
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
    selectedThreadDate,
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

  const [composerTargetKey, setComposerTargetKey] = useState<string | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerSession, setComposerSession] = useState(0);
  const defaultNewThreadSetup = useMemo<NewThreadSetup>(() => {
    const title = asTrimmedString(getDescValue(desc, "data-newThreadTitleDefault"));
    const icon = asTrimmedString(getDescValue(desc, "data-newThreadIconDefault"));
    const color = asTrimmedString(getDescValue(desc, "data-newThreadColorDefault"));
    return {
      ...DEFAULT_NEW_THREAD_SETUP,
      title: title ?? DEFAULT_NEW_THREAD_SETUP.title,
      icon: icon ?? DEFAULT_NEW_THREAD_SETUP.icon,
      color: color ?? DEFAULT_NEW_THREAD_SETUP.color,
      agentMode: "codex",
    };
  }, [desc]);
  const [newThreadSetup, setNewThreadSetup] =
    useState<NewThreadSetup>(defaultNewThreadSetup);
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

  const composerDraftKey = useMemo(() => {
    if (!singleThreadView || !selectedThreadKey) return 0;
    if (selectedThreadDate instanceof Date && !isNaN(selectedThreadDate.valueOf())) {
      return -selectedThreadDate.valueOf();
    }
    return stableDraftKeyFromThreadKey(selectedThreadKey);
  }, [singleThreadView, selectedThreadDate, selectedThreadKey]);

  const { input, setInput, clearInput, clearComposerDraft } = useChatComposerDraft({
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
      if (
        sessionToken != null &&
        sessionToken !== composerSessionRef.current
      ) {
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
  const selectedThreadId = useMemo(
    () => normalizeThreadKey(selectedThreadKey),
    [selectedThreadKey],
  );

  const selectedThreadLookupKey = selectedThreadId;
  const selectedThreadMessages = useMemo(
    () =>
      selectedThreadLookupKey != null
        ? actions.getMessagesInThread(selectedThreadLookupKey) ?? []
        : [],
    [actions, selectedThreadLookupKey, messages],
  );
  const hasRunningAcpTurn = useMemo(() => {
    if (!isSelectedThreadAI) return false;
    if (selectedThreadId) {
      const byThread = acpState?.get?.(`thread:${selectedThreadId}`);
      if (byThread === "running") {
        return true;
      }
    }
    if (!selectedThreadMessages.length) return false;
    for (const msg of selectedThreadMessages) {
      const d = dateValue(msg);
      if (!d) continue;
      if (field<boolean>(msg, "generating") === true) return true;
      const threadId = field<string>(msg, "thread_id");
      if (threadId) {
        const threadState = acpState?.get?.(`thread:${threadId}`);
        if (threadState === "running") return true;
      }
      const messageId = field<string>(msg, "message_id");
      const state =
        (messageId ? acpState?.get?.(`message:${messageId}`) : undefined) ??
        acpState?.get?.(`${d.valueOf()}`);
      if (state === "running") return true;
    }
    return false;
  }, [isSelectedThreadAI, selectedThreadMessages, acpState, selectedThread]);

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
      const sessionIdRaw =
        typeof acpConfig?.sessionId === "string" && acpConfig.sessionId.trim()
          ? acpConfig.sessionId.trim()
          : thread.key;
      const threadDateRaw =
        metadata?.thread_date ??
        (thread.newestTime ? new Date(thread.newestTime).toISOString() : undefined);
      const createdAt =
        parseDateISOString(threadDateRaw) ??
        new Date().toISOString();
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
          typeof thread.threadColor === "string" ? thread.threadColor : undefined,
        thread_icon:
          typeof thread.threadIcon === "string" ? thread.threadIcon : undefined,
        thread_image:
          typeof thread.threadImage === "string" ? thread.threadImage : undefined,
        thread_pin: thread.isPinned === true,
      });
    }
    return records;
  }, [account_id, acpState, actions, path, project_id, threads]);

  useEffect(() => {
    if (!agentSessionRecords.length) return;
    for (const record of agentSessionRecords) {
      const serialized = JSON.stringify(record);
      if (indexedAgentSessionsRef.current.get(record.session_id) === serialized) {
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
    if (!isCombinedFeedSelected) {
      if (composerTargetKey != null) {
        setComposerTargetKey(null);
      }
      return;
    }
    if (threads.length === 0) {
      if (composerTargetKey != null) {
        setComposerTargetKey(null);
      }
      return;
    }
    if (composerTargetKey == null) {
      setComposerTargetKey(threads[0].key);
      return;
    }
    const exists = threads.some((thread) => thread.key === composerTargetKey);
    if (!exists) {
      setComposerTargetKey(threads[0].key);
    }
  }, [isCombinedFeedSelected, threads, composerTargetKey]);

  const mark_as_read = () => markChatAsReadIfUnseen(project_id, path);

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

  function resolveReplyTarget(replyToOverride?: Date | null): {
    reply_to?: Date;
    thread_id?: string;
    lookup?: string;
  } {
    if (replyToOverride !== undefined) {
      return { reply_to: replyToOverride ?? undefined };
    }
    const resolveFromThreadKey = (threadKey?: string | null) => {
      if (!threadKey) return { reply_to: undefined, thread_id: undefined, lookup: undefined };
      const thread_id = normalizeThreadKey(threadKey);
      const metadata = actions.getThreadMetadata?.(threadKey, {
        threadId: thread_id,
      });
      const configDate =
        metadata?.thread_date != null ? new Date(metadata.thread_date) : undefined;
      const reply_to =
        configDate && !Number.isNaN(configDate.valueOf()) ? configDate : undefined;
      const lookup = thread_id;
      return { reply_to: reply_to ?? undefined, thread_id, lookup };
    };
    if (isCombinedFeedSelected) {
      return resolveFromThreadKey(composerTargetKey ?? threads[0]?.key);
    }
    return resolveFromThreadKey(selectedThreadKey);
  }

  function interruptThreadIfRunning({
    reply_to,
    thread_id,
    lookup,
  }: {
    reply_to?: Date;
    thread_id?: string;
    lookup?: string;
  }): void {
    const threadMessages =
      (lookup ? actions.getMessagesInThread(lookup) : undefined) ?? [];
    const sessionId =
      (thread_id ? actions.getCodexConfig(thread_id)?.sessionId : undefined) ??
      thread_id ??
      (reply_to ? `${reply_to.valueOf()}` : undefined);
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
        (typeof threadState === "string" && ACP_ACTIVE_STATES.has(threadState)) ||
        (typeof msgState === "string" && ACP_ACTIVE_STATES.has(msgState));
      if (!isActive) continue;
      const interruptTargetThreadId =
        field<string>(msg, "acp_thread_id") ?? sessionId;
      if (!interruptTargetThreadId) continue;
      actions.languageModelStopGenerating(new Date(msgDate.valueOf()), {
        threadId: interruptTargetThreadId,
        replyTo: reply_to,
        senderId: field<string>(msg, "sender_id"),
      });
    }
  }

  function sendMessage(
    replyToOverride?: Date | null,
    extraInput?: string,
    opts?: { immediate?: boolean },
  ): void {
    const rawSendingText = `${extraInput ?? inputRef.current ?? ""}`;
    const sendingText = rawSendingText.trim();
    if (sendingText.length === 0) return;
    advanceComposerSession();
    const target = resolveReplyTarget(replyToOverride);
    const reply_to = target.reply_to;
    const reply_thread_id = target.thread_id;
    if (!reply_to && !reply_thread_id) {
      // Creating a new thread should never auto-fallback to Combined while
      // thread metadata is hydrating.
      setAllowAutoSelectThread(false);
    } else if (isCombinedFeedSelected) {
      setAllowAutoSelectThread(false);
    }

    if ((reply_to || reply_thread_id) && opts?.immediate && isSelectedThreadAI) {
      interruptThreadIfRunning(target);
      resetAcpThreadState({
        actions,
        threadRootDate: reply_to,
        threadId: reply_thread_id,
      });
    }

    clearComposerNow(composerDraftKey);

    const timeStamp = actions.sendChat({
      submitMentionsRef,
      reply_to,
      reply_thread_id,
      extraInput,
      send_mode: opts?.immediate ? "immediate" : undefined,
      name:
        !reply_to && !reply_thread_id && newThreadSetup.title.trim()
          ? newThreadSetup.title.trim()
          : undefined,
      threadAgent:
        !reply_to && !reply_thread_id && newThreadSetup.agentMode
          ? {
              mode: newThreadSetup.agentMode,
              model: newThreadSetup.model?.trim(),
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
      threadAppearance:
        !reply_to && !reply_thread_id
          ? {
              color: newThreadSetup.color?.trim(),
              icon: newThreadSetup.icon?.trim(),
              image: newThreadSetup.image?.trim(),
            }
          : undefined,
      // Replies sent from Combined should keep Combined selected.
      // Brand new threads should always switch to the newly created thread.
      preserveSelectedThread:
        isCombinedFeedSelected && (reply_to != null || reply_thread_id != null),
    });
    const threadKey =
      !reply_to && !reply_thread_id && timeStamp
        ? (() => {
            const created = actions.getMessageByDate(new Date(timeStamp));
            const threadId = field<string>(created as any, "thread_id");
            return threadId?.trim() || null;
          })()
        : null;
    if (!reply_to && !reply_thread_id && threadKey) {
      if (
        newThreadSetup.color?.trim() ||
        newThreadSetup.icon?.trim() ||
        newThreadSetup.image?.trim()
      ) {
        actions.setThreadAppearance?.(threadKey, {
          color: newThreadSetup.color?.trim(),
          icon: newThreadSetup.icon?.trim(),
          image: newThreadSetup.image?.trim(),
        });
      }
    }
    if (!reply_to && !reply_thread_id && threadKey) {
      setAllowAutoSelectThread(false);
      setSelectedThreadKey(threadKey);
      setTimeout(() => {
        setSelectedThreadKey(threadKey);
      }, 100);
    }
    setTimeout(() => {
      scrollToBottomRef.current?.(true);
    }, 100);
  }
  function on_send(value?: string): void {
    sendMessage(undefined, value);
  }

  function on_send_immediately(value?: string): void {
    sendMessage(undefined, value, { immediate: true });
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
      const metadata =
        targetThreadKey != null
          ? actions.getThreadMetadata?.(targetThreadKey, { threadId: thread_id })
          : undefined;
      const threadDate =
        metadata?.thread_date != null ? new Date(metadata.thread_date) : undefined;
      const reply_to =
        threadDate && !Number.isNaN(threadDate.valueOf()) ? threadDate : undefined;
      actions.sendChat({
        extraInput: trimmed,
        reply_to,
        reply_thread_id: thread_id,
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
      const metadata =
        targetThreadKey != null
          ? actions.getThreadMetadata?.(targetThreadKey, { threadId: thread_id })
          : undefined;
      const threadDate =
        metadata?.thread_date != null ? new Date(metadata.thread_date) : undefined;
      const reply_to =
        threadDate && !Number.isNaN(threadDate.valueOf()) ? threadDate : undefined;
      const lines = ["Committed manually.", `Commit: ${commit}`];
      if (`${subject ?? ""}`.trim()) {
        lines.push(`Subject: ${subject.trim()}`);
      }
      actions.sendChat({
        extraInput: lines.join("\n"),
        reply_to,
        reply_thread_id: thread_id,
        preserveSelectedThread: true,
        skipModelDispatch: true,
      });
    },
    [actions, gitBrowserThreadKey, selectedThreadKey, composerTargetKey],
  );

  const findCommitInCurrentChat = useCallback(
    async (query: string) => {
      const normalized = `${query ?? ""}`.trim().toLowerCase();
      if (!normalized || !project_id || !path) return;
      const searchTerm = /^[0-9a-f]{7,40}$/i.test(normalized)
        ? normalized.slice(0, 10)
        : normalized;
      const searchTermLower = searchTerm.toLowerCase();

      const frameActions = actions.frameTreeActions as any;
      let searchFrameId =
        frameActions?.show_focused_frame_of_type?.("search", "col", false, 0.8) ??
        undefined;
      if (!searchFrameId) {
        await frameActions?.show_search?.();
        searchFrameId =
          frameActions?.show_focused_frame_of_type?.("search", "col", false, 0.8) ??
          undefined;
      }
      if (searchFrameId) {
        frameActions?.set_frame_data?.({
          id: searchFrameId,
          search: searchTerm,
          searchThread: "__all_messages__",
        });
      }

      let localBestDateMs: number | undefined;
      const allMessages = actions.getAllMessages?.();
      for (const msg of allMessages?.values?.() ?? []) {
        const d = dateValue(msg)?.valueOf?.();
        if (!Number.isFinite(d)) continue;
        const text = newest_content(msg).replace(/<[^>]*>/g, " ").toLowerCase();
        if (!text.includes(searchTermLower)) continue;
        if (localBestDateMs == null || (d as number) > localBestDateMs) {
          localBestDateMs = d as number;
        }
      }

      const hubProjects = webapp_client.conat_client?.hub?.projects;
      let archivedBestDateMs: number | undefined;
      let archivedBest:
        | { row_id?: number; message_id?: string; thread_id?: string }
        | undefined;
      if (hubProjects) {
        try {
          const archived = await hubProjects.chatStoreSearch({
            project_id,
            chat_path: path,
            query: searchTerm,
            limit: 50,
            offset: 0,
          });
          for (const hit of archived?.hits ?? []) {
            const dateMs = Number(hit?.date_ms);
            if (!Number.isFinite(dateMs)) continue;
            if (archivedBestDateMs == null || dateMs > archivedBestDateMs) {
              archivedBestDateMs = dateMs;
              archivedBest = {
                row_id: hit?.row_id,
                message_id: hit?.message_id,
                thread_id: hit?.thread_id,
              };
            }
          }
        } catch {
          // ignore backend search errors; local hits may still exist
        }
      }

      const bestDateMs =
        localBestDateMs == null
          ? archivedBestDateMs
          : archivedBestDateMs == null
            ? localBestDateMs
            : Math.max(localBestDateMs, archivedBestDateMs);

      if (
        bestDateMs != null &&
        Number.isFinite(bestDateMs) &&
        archivedBestDateMs != null &&
        bestDateMs === archivedBestDateMs &&
        archivedBest &&
        hubProjects
      ) {
        try {
          const rowResp = await hubProjects.chatStoreReadArchivedHit({
            project_id,
            chat_path: path,
            row_id: archivedBest.row_id,
            message_id: archivedBest.message_id,
            thread_id: archivedBest.thread_id,
          });
          const row = rowResp?.row?.row;
          if (row != null) {
            actions.hydrateArchivedRows?.([row]);
          }
        } catch {
          // ignore hydration failures and still navigate by fragment
        }
      }

      if (bestDateMs != null && Number.isFinite(bestDateMs)) {
        actions.setFragment?.(new Date(bestDateMs));
      }
      setGitBrowserOpen(false);
      setGitBrowserThreadKey(undefined);
    },
    [actions, path, project_id],
  );

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
              ((
                _threadKey,
                _label,
                _useCurrentLabel,
                _color,
                _icon,
              ) => undefined)
            }
            openGitBrowser={openGitBrowserForThread}
            openExportModal={modalHandlers?.openExportModal ?? (() => undefined)}
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
