/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Render all the messages in the chat.
*/

// cSpell:ignore: timespan

import {
  KeyboardEvent,
  MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { VirtuosoHandle } from "react-virtuoso";
import StatefulVirtuoso from "@cocalc/frontend/components/stateful-virtuoso";
import { chatBotName, isChatBot } from "@cocalc/frontend/account/chatbot";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { DivTempHeight } from "@cocalc/frontend/jupyter/div-temp-height";
import { cmp } from "@cocalc/util/misc";
import type { ChatActions } from "./actions";
import Composing from "./composing";
import Message from "./message";
import type {
  ChatMessageTyped,
  ChatMessages,
  Mode,
  NumChildren,
} from "./types";
import { useAnyChatOverlayOpen } from "./drawer-overlay-state";
import type { ThreadIndexEntry } from "./message-cache";
import {
  getMessageAtDate,
  newest_content,
  orderLinearThreadMessages,
} from "./utils";
import { dateValue, field, parentMessageId } from "./access";
import { COMBINED_FEED_KEY } from "./threads";

// you can use this to quickly disabled virtuoso, but rendering large chatrooms will
// become basically impossible.
const USE_VIRTUOSO = true;
const ACP_ACTIVE_STATES = new Set(["queue", "sending", "sent", "running"]);

const CHAT_LOG_CONTAINER_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: "1 1 0",
  minHeight: 0,
} as const;

const MESSAGE_LIST_CONTAINER_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: "1 1 0",
  minHeight: 0,
} as const;

function stripHtml(value: string): string {
  if (!value) return "";
  return value.replace(/<[^>]*>/g, "");
}

function isEditableOrOverlayInteractionTarget(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return Boolean(
    target.closest(
      [
        '[contenteditable="true"]',
        '[data-slate-editor="true"]',
        ".slate-editor",
        ".CodeMirror",
        ".CodeMirror-code",
        ".cm-editor",
        ".cm-content",
        '[role="textbox"]',
        ".ant-drawer",
        ".ant-drawer-mask",
        ".ant-select-dropdown",
        ".ant-dropdown",
        ".ant-modal",
        ".ant-popover",
        ".ant-tooltip",
      ].join(", "),
    ),
  );
}

interface Props {
  project_id: string; // used to render links more effectively
  path: string;
  messages?: ChatMessages;
  threadIndex?: Map<string, ThreadIndexEntry>;
  mode: Mode;
  scrollToBottomRef?: MutableRefObject<(force?: boolean) => void>;
  setLastVisible?: (x: Date | null) => void;
  fontSize?: number;
  actions: ChatActions;
  selectedThread?: string;
  scrollToIndex?: null | number | undefined;
  // scrollToDate = string ms from epoch
  scrollToDate?: null | undefined | string;
  selectedDate?: string;
  scrollCacheId?: string;
  acpState?;
  composerTargetKey?: string | null;
  composerFocused?: boolean;
  searchJumpDate?: string;
  searchJumpToken?: number;
  searchQuery?: string;
  onAtTopStateChange?: (atTop: boolean) => void;
  activityJumpDate?: string;
  activityJumpToken?: number;
  notifyOnTurnFinish?: boolean;
  onNotifyOnTurnFinishChange?: (checked: boolean) => void;
  onOpenGitBrowser?: (request: {
    threadKey: string;
    cwdOverride?: string;
    commitHash: string;
  }) => void;
}

export function ChatLog({
  project_id,
  path,
  messages: messagesProp,
  threadIndex,
  scrollToBottomRef,
  mode,
  setLastVisible,
  fontSize,
  actions,
  selectedThread,
  scrollToIndex,
  scrollToDate,
  selectedDate,
  scrollCacheId,
  acpState,
  composerTargetKey,
  composerFocused,
  searchJumpDate,
  searchJumpToken,
  searchQuery,
  onAtTopStateChange,
  activityJumpDate,
  activityJumpToken,
  notifyOnTurnFinish = false,
  onNotifyOnTurnFinishChange,
  onOpenGitBrowser,
}: Props) {
  const singleThreadView = selectedThread != null;
  const messages = messagesProp ?? new Map();
  const showThreadHeaders = selectedThread === COMBINED_FEED_KEY;
  const visibleKeys = useMemo<Set<string> | undefined>(() => {
    if (!selectedThread || !threadIndex) return undefined;
    return threadIndex.get(selectedThread)?.messageKeys;
  }, [selectedThread, threadIndex]);
  const combinedKeys = useMemo<string[] | undefined>(() => {
    if (!showThreadHeaders || !threadIndex) return undefined;
    return threadIndex.get(COMBINED_FEED_KEY)?.orderedKeys;
  }, [showThreadHeaders, threadIndex]);
  const user_map = useTypedRedux("users", "user_map");
  const account_id = useTypedRedux("account", "account_id");
  const anyOverlayOpen = useAnyChatOverlayOpen();
  const activeTopTab = useTypedRedux("page", "active_top_tab");
  const activeProjectTab = useTypedRedux({ project_id }, "active_project_tab");
  const isForegroundChatTab =
    activeTopTab === project_id && activeProjectTab === `editor-${path}`;
  const canAutoScroll =
    !anyOverlayOpen && (mode === "sidechat" || isForegroundChatTab);
  const canAutoScrollRef = useRef(canAutoScroll);
  canAutoScrollRef.current = canAutoScroll;
  const handleSelectThread = useCallback(
    (threadKey: string) => {
      actions.clearAllFilters?.();
      actions.setSelectedThread?.(threadKey);
    },
    [actions],
  );
  const { dates: sortedDates, numChildren } = useMemo<{
    dates: string[];
    numChildren: NumChildren;
  }>(() => {
    if (combinedKeys) {
      setTimeout(() => {
        setLastVisible?.(
          combinedKeys.length === 0
            ? null
            : new Date(parseFloat(combinedKeys[combinedKeys.length - 1])),
        );
      }, 1);
      return { dates: combinedKeys, numChildren: {} };
    }
    const { dates, numChildren } = getSortedDates(
      messages,
      account_id!,
      visibleKeys,
    );
    // TODO: This is an ugly hack because I'm tired and need to finish this.
    // The right solution would be to move this filtering to the store.
    // The timeout is because you can't update a component while rendering another one.
    setTimeout(() => {
      setLastVisible?.(
        dates.length == 0
          ? null
          : new Date(parseFloat(dates[dates.length - 1])),
      );
    }, 1);
    return { dates, numChildren };
  }, [messages, account_id, singleThreadView, visibleKeys, combinedKeys]);

  useEffect(() => {
    if (!canAutoScroll) {
      return;
    }
    if (scrollToIndex == null) {
      return;
    }
    if (scrollToIndex == -1) {
      scrollToBottomRef?.current?.(true);
    } else {
      virtuosoRef.current?.scrollToIndex({ index: scrollToIndex });
    }
    actions.clearScrollRequest();
  }, [scrollToIndex, canAutoScroll]);

  useEffect(() => {
    if (!canAutoScroll) {
      return;
    }
    if (scrollToDate == null) {
      return;
    }
    // linear search, which should be fine given that this is not a tight inner loop
    const index = sortedDates.indexOf(scrollToDate);
    if (index == -1) {
      // didn't find it?
      const message = getMessageAtDate({
        messages,
        date: parseFloat(scrollToDate),
      });
      if (message == null) {
        // the message really doesn't exist.  Weird.  Give up.
        actions.clearScrollRequest();
        return;
      }
      actions.clearScrollRequest();
      return;
    }
    virtuosoRef.current?.scrollToIndex({ index });
    actions.clearScrollRequest();
  }, [scrollToDate, canAutoScroll]);

  useEffect(() => {
    if (!canAutoScroll) return;
    if (searchJumpDate == null || searchJumpDate === "") return;
    const index = sortedDates.indexOf(searchJumpDate);
    if (index < 0) return;
    if (USE_VIRTUOSO) {
      virtuosoRef.current?.scrollToIndex({ index, align: "center" });
    } else if (scrollToBottomRef?.current) {
      scrollToBottomRef.current(true);
    }
    // Intentionally do not depend on sortedDates: otherwise unrelated message
    // list updates can repeatedly re-center an old match long after the user
    // initiated the search jump.
  }, [searchJumpDate, searchJumpToken, canAutoScroll]);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const manualScrollRef = useRef<boolean>(false);
  const [manualScroll, setManualScroll] = useState(false);

  // Auto-scroll to bottom while an AI message is generating, unless the
  // user has manually scrolled away from the bottom.
  const generating = useMemo(() => {
    if (!messages) return false;
    for (const date of sortedDates) {
      const msg = getMessageAtDate({ messages, date: parseFloat(date) });
      if (field(msg, "generating") !== true) continue;
      const isAcpTurn = !!field<string>(msg, "acp_account_id");
      if (!isAcpTurn) return true;
      const msgDate = dateValue(msg);
      if (!msgDate) continue;
      const messageId = field<string>(msg, "message_id");
      const threadId = field<string>(msg, "thread_id");
      const byThread =
        threadId != null ? acpState?.get?.(`thread:${threadId}`) : undefined;
      if (
        ACP_ACTIVE_STATES.has(byThread) ||
        ACP_ACTIVE_STATES.has(
          messageId != null
            ? acpState?.get?.(`message:${messageId}`)
            : undefined,
        )
      ) {
        return true;
      }
    }
    return false;
  }, [messages, sortedDates, acpState]);

  useEffect(() => {
    if (!canAutoScroll) return;
    if (!generating) return;
    manualScrollRef.current = false;
    setManualScroll(false);
    scrollToBottomRef?.current?.(true);
  }, [generating, scrollToBottomRef, canAutoScroll]);

  useEffect(() => {
    if (scrollToBottomRef == null) return;
    scrollToBottomRef.current = (force?: boolean) => {
      if (!canAutoScrollRef.current) return;
      if (manualScrollRef.current && !force) return;
      manualScrollRef.current = false;
      setManualScroll(false);
      const doScroll = () =>
        virtuosoRef.current?.scrollToIndex({ index: Number.MAX_SAFE_INTEGER });

      doScroll();
      // sometimes scrolling to bottom is requested before last entry added,
      // so we do it again in the next render loop.  This seems needed mainly
      // for side chat when there is little vertical space.
      setTimeout(doScroll, 1);
    };
  }, [scrollToBottomRef, setManualScroll]);

  return (
    <div style={CHAT_LOG_CONTAINER_STYLE}>
      <MessageList
        {...{
          virtuosoRef,
          sortedDates,
          messages,
          account_id,
          user_map,
          project_id,
          path,
          fontSize,
          actions,
          manualScrollRef,
          manualScroll,
          setManualScroll,
          mode,
          selectedDate,
          numChildren,
          singleThreadView,
          scrollCacheId,
          scrollToBottomRef,
          acpState,
          showThreadHeaders,
          onSelectThread: showThreadHeaders ? handleSelectThread : undefined,
          composerTargetKey,
          composerFocused,
          searchQuery,
          onAtTopStateChange,
          activityJumpDate,
          activityJumpToken,
          notifyOnTurnFinish,
          onNotifyOnTurnFinishChange,
          selectedThread,
          anyOverlayOpen,
          onOpenGitBrowser,
        }}
      />
      <Composing
        actions={actions}
        projectId={project_id}
        path={path}
        accountId={account_id}
        userMap={user_map}
      />
    </div>
  );
}

function isNextMessageSender(
  index: number,
  dates: string[],
  messages: ChatMessages,
): boolean {
  if (index + 1 === dates.length) {
    return false;
  }
  const currentMessage = getMessageAtDate({
    messages,
    date: parseFloat(dates[index]),
  });
  const nextMessage = getMessageAtDate({
    messages,
    date: parseFloat(dates[index + 1]),
  });
  return (
    currentMessage != null &&
    nextMessage != null &&
    field(currentMessage, "sender_id") === field(nextMessage, "sender_id")
  );
}

function isPrevMessageSender(
  index: number,
  dates: string[],
  messages: ChatMessages,
): boolean {
  if (index === 0) {
    return false;
  }
  const currentMessage = getMessageAtDate({
    messages,
    date: parseFloat(dates[index]),
  });
  const prevMessage = getMessageAtDate({
    messages,
    date: parseFloat(dates[index - 1]),
  });
  return (
    currentMessage != null &&
    prevMessage != null &&
    field(currentMessage, "sender_id") === field(prevMessage, "sender_id")
  );
}

function isThread(message: ChatMessageTyped, numChildren: NumChildren) {
  if (parentMessageId(message) != null) {
    return true;
  }
  const d = dateValue(message)?.valueOf();
  return d != null ? (numChildren[d] ?? 0) > 0 : false;
}

// Messages are sorted using each message record's `date` value.
// We avoid relying on Map key shape, since cache internals are migrating
// away from date-keyed storage.
export function getSortedDates(
  messages: ChatMessages,
  _account_id: string,
  visibleKeys?: Set<string>,
): {
  dates: string[];
  numChildren: NumChildren;
} {
  let m = messages;
  if (m == null) {
    return {
      dates: [],
      numChildren: {},
    };
  }

  const visibleMessages: ChatMessageTyped[] = [];
  const visibleById = new Map<string, ChatMessageTyped>();
  const numChildren: NumChildren = {};
  for (const [, message] of m) {
    if (message == null) continue;
    const messageDate = dateValue(message);
    if (!messageDate) continue;
    const messageKey = `${messageDate.valueOf()}`;
    if (visibleKeys && !visibleKeys.has(messageKey)) continue;
    visibleMessages.push(message);
    const messageId = `${field<string>(message, "message_id") ?? ""}`.trim();
    if (messageId) visibleById.set(messageId, message);
  }

  for (const message of visibleMessages) {
    const parentId = parentMessageId(message);
    if (parentId) {
      const parent = visibleById.get(parentId);
      const d = dateValue(parent)?.valueOf();
      if (d != null) {
        numChildren[d] = (numChildren[d] ?? 0) + 1;
        continue;
      }
    }
  }

  const groups = new Map<string, ChatMessageTyped[]>();
  for (const message of visibleMessages) {
    const threadId = `${field<string>(message, "thread_id") ?? ""}`.trim();
    const groupKey =
      threadId ||
      `${field<string>(message, "message_id") ?? dateValue(message)?.valueOf() ?? Math.random()}`;
    const bucket = groups.get(groupKey) ?? [];
    bucket.push(message);
    groups.set(groupKey, bucket);
  }

  const orderedGroups = Array.from(groups.values())
    .map((group) => orderLinearThreadMessages(group))
    .sort((a, b) => {
      const aTime = dateValue(a[0])?.valueOf() ?? Number.POSITIVE_INFINITY;
      const bTime = dateValue(b[0])?.valueOf() ?? Number.POSITIVE_INFINITY;
      return cmp(aTime, bTime);
    });

  const dates: string[] = [];
  for (const group of orderedGroups) {
    for (const message of group) {
      const messageDate = dateValue(message);
      if (!messageDate) continue;
      const date = messageDate.valueOf();
      dates.push(`${date}`);
    }
  }
  return { dates, numChildren };
}

export function getUserName(userMap, accountId: string): string {
  if (isChatBot(accountId)) {
    return chatBotName(accountId);
  }
  if (userMap == null) return "Unknown";
  const account = userMap.get(accountId);
  if (account == null) return "Unknown";
  return account.get("first_name", "") + " " + account.get("last_name", "");
}

export function MessageList({
  messages,
  account_id,
  composerTargetKey,
  composerFocused,
  virtuosoRef,
  sortedDates,
  user_map,
  project_id,
  path,
  fontSize,
  actions,
  manualScrollRef,
  manualScroll = false,
  setManualScroll,
  mode,
  selectedDate,
  numChildren,
  singleThreadView,
  scrollCacheId,
  scrollToBottomRef,
  acpState,
  showThreadHeaders,
  onSelectThread,
  searchQuery,
  onAtTopStateChange,
  activityJumpDate,
  activityJumpToken,
  notifyOnTurnFinish,
  onNotifyOnTurnFinishChange,
  selectedThread,
  anyOverlayOpen = false,
  onOpenGitBrowser,
}: {
  messages: ChatMessages;
  account_id: string;
  composerTargetKey?: string | null;
  composerFocused?: boolean;
  user_map;
  mode;
  sortedDates;
  virtuosoRef?;
  project_id?: string;
  path?: string;
  fontSize?: number;
  actions?;
  manualScrollRef?;
  manualScroll?: boolean;
  setManualScroll?: (value: boolean) => void;
  selectedDate?: string;
  numChildren?: NumChildren;
  singleThreadView?: boolean;
  scrollCacheId?: string;
  scrollToBottomRef?: MutableRefObject<(force?: boolean) => void>;
  acpState?;
  showThreadHeaders?: boolean;
  onSelectThread?: (threadKey: string) => void;
  searchQuery?: string;
  onAtTopStateChange?: (atTop: boolean) => void;
  activityJumpDate?: string;
  activityJumpToken?: number;
  notifyOnTurnFinish?: boolean;
  onNotifyOnTurnFinishChange?: (checked: boolean) => void;
  selectedThread?: string;
  anyOverlayOpen?: boolean;
  onOpenGitBrowser?: (request: {
    threadKey: string;
    cwdOverride?: string;
    commitHash: string;
  }) => void;
}) {
  const virtuosoHeightsRef = useRef<{ [index: number]: number }>({});
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const cacheId = scrollCacheId ?? `${project_id}${path}`;
  const initialIndex = Math.max(sortedDates.length - 1, 0); // start at newest
  const endRef = useRef<HTMLDivElement | null>(null);
  const blockScrollInput = anyOverlayOpen === true;
  const canNotifyForRunningTurn =
    selectedThread != null &&
    selectedThread !== COMBINED_FEED_KEY &&
    onNotifyOnTurnFinishChange != null;

  const maybeBlockScrollEvent = (event: {
    preventDefault: () => void;
    stopPropagation: () => void;
    target?: EventTarget | null;
  }) => {
    if (!blockScrollInput) return;
    if (isEditableOrOverlayInteractionTarget(event.target ?? null)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const maybeBlockScrollKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!blockScrollInput) return;
    if (
      isEditableOrOverlayInteractionTarget(event.target) ||
      isEditableOrOverlayInteractionTarget(document.activeElement)
    ) {
      return;
    }
    const key = `${event.key ?? ""}`.toLowerCase();
    if (
      key === "arrowup" ||
      key === "arrowdown" ||
      key === "pageup" ||
      key === "pagedown" ||
      key === "home" ||
      key === "end" ||
      key === " " ||
      key === "spacebar"
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const forceScrollToBottom = useCallback(() => {
    if (manualScrollRef) {
      manualScrollRef.current = false;
    }
    setManualScroll?.(false);
    scrollToBottomRef?.current?.(true);
  }, [manualScrollRef, scrollToBottomRef, setManualScroll]);

  const renderThreadHeader = (
    message: ChatMessageTyped,
    currentThreadKey?: string,
    prevThreadKey?: string,
  ) => {
    if (
      !showThreadHeaders ||
      !currentThreadKey ||
      currentThreadKey === prevThreadKey
    ) {
      return null;
    }
    const threadKey = currentThreadKey;
    const metadata = actions?.getThreadMetadata?.(threadKey, {
      threadId: threadKey,
    });
    const rawTitle =
      `${metadata?.name ?? ""}`.trim() || newest_content(message) || "Thread";
    const threadTitle = stripHtml(rawTitle);
    return (
      <div
        style={{
          padding: "6px 8px",
          margin: 8,
          borderRadius: 6,
          background: "#dadada",
          cursor: onSelectThread ? "pointer" : "default",
          fontSize: "90%",
          color: "#333",
        }}
        onClick={onSelectThread ? () => onSelectThread(threadKey) : undefined}
      >
        {threadTitle}
      </div>
    );
  };

  const renderMessage = (index: number) => {
    const date = sortedDates[index];
    const message: ChatMessageTyped | undefined = getMessageAtDate({
      messages,
      date: parseFloat(date),
    });
    if (message == null) {
      console.warn("empty message", { date, index, sortedDates });
      return <div style={{ height: "30px" }} />;
    }
    const currentThreadKey = showThreadHeaders
      ? `${field<string>(message, "thread_id") ?? date}`
      : undefined;
    const prevThreadKey =
      showThreadHeaders && index > 0
        ? `${
            field<string>(
              getMessageAtDate({
                messages,
                date: parseFloat(sortedDates[index - 1]),
              }),
              "thread_id",
            ) ?? sortedDates[index - 1]
          }`
        : undefined;

    const is_thread = numChildren != null && isThread(message, numChildren);
    const h = virtuosoHeightsRef.current?.[index];
    const shouldDim =
      showThreadHeaders &&
      composerFocused === true &&
      composerTargetKey != null &&
      currentThreadKey != null &&
      currentThreadKey !== composerTargetKey;

    const wrapperStyle: CSSProperties = {
      overflow: "hidden",
      paddingTop: index == 0 ? "20px" : undefined,
      opacity: shouldDim ? 0.7 : 1,
    };

    return (
      <div style={wrapperStyle}>
        {renderThreadHeader(message, currentThreadKey, prevThreadKey)}
        <DivTempHeight height={h ? `${h}px` : undefined}>
          <Message
            messages={messages}
            key={date}
            index={index}
            account_id={account_id}
            user_map={user_map}
            message={message}
            selected={date == selectedDate}
            project_id={project_id}
            path={path}
            font_size={fontSize}
            actions={actions}
            is_thread={is_thread}
            is_thread_body={is_thread && parentMessageId(message) != null}
            is_prev_sender={isPrevMessageSender(index, sortedDates, messages)}
            show_avatar={!isNextMessageSender(index, sortedDates, messages)}
            mode={mode}
            get_user_name={(account_id: string | undefined) =>
              typeof account_id === "string"
                ? getUserName(user_map, account_id)
                : "Unknown name"
            }
            scroll_into_view={
              virtuosoRef
                ? () => virtuosoRef.current?.scrollIntoView({ index })
                : undefined
            }
            allowReply={
              !singleThreadView &&
              (() => {
                const next = getMessageAtDate({
                  messages,
                  date: parseFloat(sortedDates[index + 1]),
                });
                return next == null ? true : parentMessageId(next) == null;
              })()
            }
            threadViewMode={singleThreadView}
            onForceScrollToBottom={forceScrollToBottom}
            acpState={(() => {
              const messageId = field<string>(message, "message_id");
              if (!messageId) return undefined;
              return acpState?.get(`message:${messageId}`);
            })()}
            dim={shouldDim}
            searchHighlight={searchQuery}
            openActivityToken={
              activityJumpDate === date ? activityJumpToken : undefined
            }
            notifyOnTurnFinish={
              canNotifyForRunningTurn ? notifyOnTurnFinish : undefined
            }
            onNotifyOnTurnFinishChange={
              canNotifyForRunningTurn ? onNotifyOnTurnFinishChange : undefined
            }
            onOpenGitBrowser={onOpenGitBrowser}
          />
        </DivTempHeight>
      </div>
    );
  };

  useEffect(() => {
    if (!scrollToBottomRef || USE_VIRTUOSO) return;
    scrollToBottomRef.current = () => {
      endRef.current?.scrollIntoView({ block: "end" });
    };
  }, [scrollToBottomRef]);

  useEffect(() => {
    if (!USE_VIRTUOSO) return;
    if (!sortedDates.length) return;
    const id = setTimeout(() => {
      const host = listContainerRef.current;
      if (!host) return;
      const scroller = host.querySelector<HTMLElement>(
        "[data-virtuoso-scroller]",
      );
      if (!scroller) return;
      if (scroller.getBoundingClientRect().height > 0) return;
      // Defensive self-heal for intermittent layout collapse in some sessions.
      const parent = scroller.parentElement as HTMLElement | null;
      if (parent) {
        parent.style.display = "flex";
        parent.style.flex = "1 1 0";
        parent.style.minHeight = "0";
      }
      scroller.style.flex = "1 1 0";
      scroller.style.minHeight = "0";
      scroller.style.height = "100%";
    }, 0);
    return () => clearTimeout(id);
  }, [sortedDates.length]);

  if (!USE_VIRTUOSO) {
    return (
      <div
        style={MESSAGE_LIST_CONTAINER_STYLE}
        onWheelCapture={maybeBlockScrollEvent}
        onTouchMoveCapture={maybeBlockScrollEvent}
        onKeyDownCapture={maybeBlockScrollKeys}
      >
        {sortedDates.map((_, index) => renderMessage(index))}
        <div ref={endRef} style={{ height: "25px" }} />
      </div>
    );
  }

  return (
    <div
      ref={listContainerRef}
      tabIndex={-1}
      style={MESSAGE_LIST_CONTAINER_STYLE}
      onWheelCapture={maybeBlockScrollEvent}
      onTouchMoveCapture={maybeBlockScrollEvent}
      onKeyDownCapture={maybeBlockScrollKeys}
    >
      <StatefulVirtuoso
        style={{ flex: "1 1 0", minHeight: 0 }}
        ref={virtuosoRef}
        totalCount={sortedDates.length + 1}
        cacheId={cacheId}
        initialTopMostItemIndex={initialIndex}
        atTopThreshold={240}
        itemSize={(el) => {
          const h = el.getBoundingClientRect().height;
          const data = el.getAttribute("data-item-index");
          if (data != null) {
            const index = parseInt(data);
            virtuosoHeightsRef.current[index] = h;
          }
          return h;
        }}
        itemContent={(index) => {
          if (sortedDates.length == index) {
            return <div style={{ height: "25px" }} />;
          }
          return renderMessage(index);
        }}
        rangeChanged={
          manualScrollRef
            ? ({ endIndex }) => {
                if (endIndex < sortedDates.length - 1) {
                  manualScrollRef.current = true;
                  setManualScroll?.(true);
                }
              }
            : undefined
        }
        atBottomStateChange={
          manualScrollRef
            ? (atBottom: boolean) => {
                if (!atBottom) {
                  manualScrollRef.current = true;
                  setManualScroll?.(true);
                }
                setAtBottom(atBottom);
              }
            : undefined
        }
        atTopStateChange={onAtTopStateChange}
        followOutput={
          !manualScroll && atBottom && !anyOverlayOpen ? "smooth" : false
        }
      />
    </div>
  );
}
