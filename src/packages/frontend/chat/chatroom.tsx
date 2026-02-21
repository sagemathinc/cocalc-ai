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
  toMsString,
} from "./utils";
import { COMBINED_FEED_KEY, useThreadSections } from "./threads";
import { ChatDocProvider, useChatDoc } from "./doc-context";
import { useChatComposerDraft } from "./use-chat-composer-draft";
import * as immutable from "immutable";
import { useChatThreadSelection } from "./thread-selection";
import { dateValue, field } from "./access";
import { useCodexPaymentSource } from "./use-codex-payment-source";
import { resetAcpThreadState } from "./acp-api";

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
  fontSize?: number;
  desc?: NodeDesc;
  variant?: "default" | "compact";
}

function getDescValue(desc: NodeDesc | undefined, key: string) {
  if (desc == null) return undefined;
  const getter: any = (desc as any).get;
  if (typeof getter === "function") {
    return getter.call(desc, key);
  }
  return (desc as any)[key];
}

export function ChatPanel({
  actions,
  project_id,
  path,
  messages,
  threadIndex,
  fontSize = 13,
  desc,
  variant = "default",
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
  const storedSidebarWidth = getDescValue(desc, "data-sidebarWidth");
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
  });

  const [composerTargetKey, setComposerTargetKey] = useState<string | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerSession, setComposerSession] = useState(0);
  const [newThreadSetup, setNewThreadSetup] =
    useState<NewThreadSetup>(DEFAULT_NEW_THREAD_SETUP);

  const composerDraftKey = useMemo(() => {
    if (
      singleThreadView &&
      selectedThreadDate instanceof Date &&
      !isNaN(selectedThreadDate.valueOf())
    ) {
      return -selectedThreadDate.valueOf();
    }
    return 0;
  }, [singleThreadView, selectedThreadDate]);

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
  const selectedThreadIso = useMemo(
    () =>
      selectedThreadDate && !isNaN(selectedThreadDate.valueOf())
        ? selectedThreadDate.toISOString()
        : undefined,
    [selectedThreadDate],
  );
  const selectedThreadMessages = useMemo(
    () =>
      selectedThreadIso != null
        ? actions.getMessagesInThread(selectedThreadIso) ?? []
        : [],
    [actions, selectedThreadIso, messages],
  );
  const hasActiveAcpTurn = useMemo(() => {
    if (!isSelectedThreadAI) return false;
    const activeStates = new Set(["queue", "sending", "sent", "running"]);
    const selectedThreadId = field<string>(selectedThread?.rootMessage, "thread_id");
    if (selectedThreadId) {
      const byThread = acpState?.get?.(`thread:${selectedThreadId}`);
      if (typeof byThread === "string" && activeStates.has(byThread)) {
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
        if (threadState && activeStates.has(threadState)) return true;
      }
      const messageId = field<string>(msg, "message_id");
      const state =
        (messageId ? acpState?.get?.(`message:${messageId}`) : undefined) ??
        acpState?.get?.(`${d.valueOf()}`);
      if (state && activeStates.has(state)) return true;
    }
    return false;
  }, [isSelectedThreadAI, selectedThreadMessages, acpState, selectedThread]);

  const {
    paymentSource: codexPaymentSource,
    loading: codexPaymentSourceLoading,
    refresh: refreshCodexPaymentSource,
  } = useCodexPaymentSource({
    projectId: project_id,
    enabled: isSelectedThreadAI,
  });

  const combinedFeedIndex = useMemo(() => {
    if (!threadIndex || !combinedThread) return undefined;
    const combinedKeys = buildCombinedFeedKeys(
      threadIndex,
      messages,
      COMBINED_FEED_MAX_PER_THREAD,
    );
    const entry: ThreadIndexEntry = {
      key: COMBINED_FEED_KEY,
      newestTime: combinedThread.newestTime,
      messageCount: combinedKeys.length,
      messageKeys: new Set(combinedKeys),
      orderedKeys: combinedKeys,
      rootMessage: undefined,
    };
    const next = new Map(threadIndex);
    next.set(COMBINED_FEED_KEY, entry);
    return next;
  }, [threadIndex, messages, combinedThread]);

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
    const visited = visitedThreadsRef.current.has(thread.key);
    const hasNewUnread = unread > 0 && unread !== prevUnread;

    const scrollToFirstUnread = () => {
      const total = thread.messageCount ?? 0;
      const index = Math.max(0, Math.min(total - 1, total - unread));
      lastScrollRequestRef.current = { thread: thread.key, reason: "unread" };
      actions.scrollToIndex?.(index);
    };

    if (hasNewUnread || (!visited && unread > 0)) {
      scrollToFirstUnread();
      actions.markThreadRead?.(thread.key, thread.messageCount);
      visitedThreadsRef.current.add(thread.key);
      unreadSeenRef.current.set(thread.key, unread);
      return;
    }

    if (!visited && unread === 0) {
      lastScrollRequestRef.current = { thread: thread.key, reason: "allread" };
      actions.scrollToIndex?.(Number.MAX_SAFE_INTEGER);
      visitedThreadsRef.current.add(thread.key);
      unreadSeenRef.current.set(thread.key, unread);
      return;
    }

    // Already visited and no new unread: preserve existing scroll (cached per thread via virtuoso cacheId).
    unreadSeenRef.current.set(thread.key, unread);
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

  function resolveReplyTarget(replyToOverride?: Date | null): Date | undefined {
    if (replyToOverride !== undefined) {
      return replyToOverride ?? undefined;
    }
    if (isCombinedFeedSelected) {
      const key = composerTargetKey ?? threads[0]?.key;
      if (key) {
        const millis = parseInt(key, 10);
        if (isFinite(millis)) {
          return new Date(millis);
        }
      }
      return undefined;
    }
    return selectedThreadDate;
  }

  function interruptThreadIfRunning(reply_to: Date): void {
    const rootIso = reply_to.toISOString();
    const threadMessages = actions.getMessagesInThread(rootIso) ?? [];
    const sessionId =
      actions.getCodexConfig(reply_to)?.sessionId ?? `${reply_to.valueOf()}`;
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
    const reply_to = resolveReplyTarget(replyToOverride);
    if (!reply_to) {
      setAllowAutoSelectThread(true);
    } else if (isCombinedFeedSelected) {
      setAllowAutoSelectThread(false);
    }

    if (reply_to && opts?.immediate && isSelectedThreadAI) {
      interruptThreadIfRunning(reply_to);
      resetAcpThreadState({ actions, threadRootDate: reply_to });
    }

    clearComposerNow(composerDraftKey);

    const timeStamp = actions.sendChat({
      submitMentionsRef,
      reply_to,
      extraInput,
      send_mode: opts?.immediate ? "immediate" : undefined,
      name:
        !reply_to && newThreadSetup.title.trim()
          ? newThreadSetup.title.trim()
          : undefined,
      threadAgent:
        !reply_to && newThreadSetup.agentMode
          ? {
              mode: newThreadSetup.agentMode,
              model: newThreadSetup.model?.trim(),
            }
          : undefined,
      threadAppearance:
        !reply_to
          ? {
              color: newThreadSetup.color?.trim(),
              icon: newThreadSetup.icon?.trim(),
              image: newThreadSetup.image?.trim(),
            }
          : undefined,
      preserveSelectedThread: isCombinedFeedSelected,
    });
    const threadKey = timeStamp ? toMsString(timeStamp) ?? timeStamp : null;
    if (!reply_to && threadKey) {
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
    if (!reply_to && threadKey && !isCombinedFeedSelected) {
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
    setNewThreadSetup(DEFAULT_NEW_THREAD_SETUP);
  }

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
        hasActiveAcpTurn={hasActiveAcpTurn}
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
  const { messages, threadIndex } = useChatDoc();
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
