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
import { Button } from "antd";
import { VirtuosoHandle } from "react-virtuoso";
import StatefulVirtuoso from "@cocalc/frontend/components/stateful-virtuoso";
import { chatBotName, isChatBot } from "@cocalc/frontend/account/chatbot";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { DivTempHeight } from "@cocalc/frontend/jupyter/div-temp-height";
import { cmp } from "@cocalc/util/misc";
import type { ChatActions } from "./actions";
import type { AttachedSteerMessage } from "./agent-message-status";
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

// you can use this to quickly disabled virtuoso, but rendering large chatrooms will
// become basically impossible.
const USE_VIRTUOSO = true;

function isImmediateAcpSteerMessage(message: ChatMessageTyped): boolean {
  return field<string>(message, "acp_send_mode") === "immediate";
}

function toAttachedSteerState(
  state: unknown,
): AttachedSteerMessage["state"] | undefined {
  switch (state) {
    case "sending":
      return "sending";
    case "sent":
    case "running":
      return "sent";
    case "queue":
      return "queued";
    case "not-sent":
      return "not-sent";
    default:
      return undefined;
  }
}

function resolveSteerAnchorMessageId({
  message,
  byMessageId,
}: {
  message: ChatMessageTyped;
  byMessageId: Map<string, ChatMessageTyped>;
}): string | undefined {
  let current: ChatMessageTyped | undefined = message;
  let guard = 0;
  while (current != null && guard < 1000) {
    const directParentId = `${parentMessageId(current) ?? ""}`.trim();
    if (!directParentId) return undefined;
    const directParent = byMessageId.get(directParentId);
    if (directParent == null) return directParentId;
    if (isImmediateAcpSteerMessage(directParent)) {
      current = directParent;
      guard += 1;
      continue;
    }
    if (field<string>(directParent, "acp_account_id")) {
      const assistantParentId = `${parentMessageId(directParent) ?? ""}`.trim();
      return assistantParentId || directParentId;
    }
    return directParentId;
  }
  return undefined;
}

function collectAttachedSteers({
  messages,
  visibleKeys,
  acpState,
}: {
  messages: ChatMessages;
  visibleKeys?: Set<string>;
  acpState?: { get?: (key: string) => unknown };
}): Map<string, AttachedSteerMessage[]> {
  const attached = new Map<string, AttachedSteerMessage[]>();
  const byMessageId = new Map<string, ChatMessageTyped>();
  for (const [, message] of messages) {
    if (message == null) continue;
    const messageId = `${field<string>(message, "message_id") ?? ""}`.trim();
    if (messageId) {
      byMessageId.set(messageId, message);
    }
  }
  for (const [, message] of messages) {
    if (message == null || !isImmediateAcpSteerMessage(message)) continue;
    const messageDate = dateValue(message);
    if (!messageDate) continue;
    const messageKey = `${messageDate.valueOf()}`;
    if (visibleKeys && !visibleKeys.has(messageKey)) continue;
    const messageId = `${field<string>(message, "message_id") ?? ""}`.trim();
    const text = newest_content(message)?.trim();
    if (!messageId || !text) continue;
    const anchoredParentId = resolveSteerAnchorMessageId({
      message,
      byMessageId,
    });
    const state =
      toAttachedSteerState(acpState?.get?.(`message:${messageId}`)) ??
      toAttachedSteerState(field<string>(message, "acp_state"));
    if (!state || !anchoredParentId) continue;
    const next = attached.get(anchoredParentId) ?? [];
    next.push({
      messageId,
      date: messageDate.valueOf(),
      text,
      state,
    });
    attached.set(anchoredParentId, next);
  }
  for (const list of attached.values()) {
    list.sort((a, b) => cmp(a.date, b.date));
  }
  return attached;
}

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
  position: "relative",
} as const;

const NEWEST_MESSAGES_BUTTON_STYLE: CSSProperties = {
  position: "absolute",
  left: "50%",
  bottom: 14,
  transform: "translateX(-50%)",
  zIndex: 5,
} as const;

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
  suppressInlineCodexStatusDate?: string;
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
  searchJumpDate,
  searchJumpToken,
  searchQuery,
  onAtTopStateChange,
  activityJumpDate,
  activityJumpToken,
  notifyOnTurnFinish = false,
  onNotifyOnTurnFinishChange,
  onOpenGitBrowser,
  suppressInlineCodexStatusDate,
}: Props) {
  const singleThreadView = selectedThread != null;
  const messages = messagesProp ?? new Map();
  const visibleKeys = useMemo<Set<string> | undefined>(() => {
    if (!selectedThread || !threadIndex) return undefined;
    return threadIndex.get(selectedThread)?.messageKeys;
  }, [selectedThread, threadIndex]);
  const user_map = useTypedRedux("users", "user_map");
  const account_id = useTypedRedux("account", "account_id");
  const attachedSteersByParentMessageId = useMemo(
    () => collectAttachedSteers({ messages, visibleKeys, acpState }),
    [messages, visibleKeys, acpState],
  );
  const anyOverlayOpen = useAnyChatOverlayOpen();
  const activeTopTab = useTypedRedux("page", "active_top_tab");
  const activeProjectTab = useTypedRedux({ project_id }, "active_project_tab");
  const isForegroundChatTab =
    activeTopTab === project_id && activeProjectTab === `editor-${path}`;
  const canAutoScroll =
    !anyOverlayOpen && (mode === "sidechat" || isForegroundChatTab);
  const canAutoScrollRef = useRef(canAutoScroll);
  canAutoScrollRef.current = canAutoScroll;
  const keepBottomAnchoredRef = useRef(false);
  const { dates: sortedDates, numChildren } = useMemo<{
    dates: string[];
    numChildren: NumChildren;
  }>(() => {
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
  }, [messages, account_id, singleThreadView, visibleKeys]);

  useEffect(() => {
    if (!canAutoScroll) {
      return;
    }
    if (scrollToIndex == null) {
      return;
    }
    if (scrollToIndex == -1) {
      keepBottomAnchoredRef.current = true;
      scrollToBottomRef?.current?.(true);
    } else {
      keepBottomAnchoredRef.current = false;
      virtuosoRef.current?.scrollToIndex({ index: scrollToIndex });
    }
    actions.clearScrollRequest();
  }, [scrollToIndex, canAutoScroll, actions]);

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
    keepBottomAnchoredRef.current = false;
    virtuosoRef.current?.scrollToIndex({ index });
    actions.clearScrollRequest();
  }, [scrollToDate, canAutoScroll, sortedDates, messages, actions]);

  useEffect(() => {
    if (!canAutoScroll) return;
    if (searchJumpDate == null || searchJumpDate === "") return;
    const index = sortedDates.indexOf(searchJumpDate);
    if (index < 0) return;
    keepBottomAnchoredRef.current = false;
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
  const bottomScrollTokenRef = useRef(0);
  const bottomScrollTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    return () => {
      for (const timer of bottomScrollTimersRef.current) {
        clearTimeout(timer);
      }
      bottomScrollTimersRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (scrollToBottomRef == null) return;
    scrollToBottomRef.current = (force?: boolean) => {
      if (!canAutoScrollRef.current) return;
      if (manualScrollRef.current && !force) return;
      manualScrollRef.current = false;
      setManualScroll(false);
      keepBottomAnchoredRef.current = true;
      const token = ++bottomScrollTokenRef.current;
      const doScroll = () =>
        virtuosoRef.current?.scrollToIndex({ index: Number.MAX_SAFE_INTEGER });
      const doScrollIfStillAnchored = () => {
        if (bottomScrollTokenRef.current !== token) return;
        if (!canAutoScrollRef.current) return;
        if (manualScrollRef.current) return;
        if (!keepBottomAnchoredRef.current) return;
        doScroll();
      };

      doScroll();
      // sometimes scrolling to bottom is requested before last entry added,
      // so we do it again in the next render loop.  This seems needed mainly
      // for side chat when there is little vertical space.
      bottomScrollTimersRef.current.push(
        setTimeout(doScrollIfStillAnchored, 1),
      );
      // Images and other late-layout content can still increase message height
      // after the immediate scrolls above, so do one delayed follow-up as well.
      bottomScrollTimersRef.current.push(
        setTimeout(doScrollIfStillAnchored, 500),
      );
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
          keepBottomAnchoredRef,
          acpState,
          attachedSteersByParentMessageId,
          searchQuery,
          onAtTopStateChange,
          activityJumpDate,
          activityJumpToken,
          notifyOnTurnFinish,
          onNotifyOnTurnFinishChange,
          selectedThread,
          anyOverlayOpen,
          onOpenGitBrowser,
          suppressInlineCodexStatusDate,
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
    if (isImmediateAcpSteerMessage(message)) continue;
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
  keepBottomAnchoredRef,
  acpState,
  attachedSteersByParentMessageId,
  searchQuery,
  onAtTopStateChange,
  activityJumpDate,
  activityJumpToken,
  notifyOnTurnFinish,
  onNotifyOnTurnFinishChange,
  selectedThread,
  anyOverlayOpen = false,
  onOpenGitBrowser,
  suppressInlineCodexStatusDate,
}: {
  messages: ChatMessages;
  account_id: string;
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
  keepBottomAnchoredRef?: MutableRefObject<boolean>;
  acpState?;
  attachedSteersByParentMessageId?: Map<string, AttachedSteerMessage[]>;
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
  suppressInlineCodexStatusDate?: string;
}) {
  const virtuosoHeightsRef = useRef<{ [index: number]: number }>({});
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const cacheId = scrollCacheId ?? `${project_id}${path}`;
  const initialIndex = Math.max(sortedDates.length - 1, 0); // start at newest
  const endRef = useRef<HTMLDivElement | null>(null);
  const blockScrollInput = anyOverlayOpen === true;
  const showNewestMessagesButton =
    sortedDates.length > 0 && (!atBottom || manualScroll);
  const canNotifyForRunningTurn =
    selectedThread != null && onNotifyOnTurnFinishChange != null;
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const clearUserScrollIntentLater = () => {
    if (userScrollIntentTimerRef.current != null) {
      clearTimeout(userScrollIntentTimerRef.current);
    }
    userScrollIntentTimerRef.current = setTimeout(() => {
      userScrollIntentRef.current = false;
    }, 1000);
  };

  const markManualScrollAway = () => {
    if (keepBottomAnchoredRef) {
      keepBottomAnchoredRef.current = false;
    }
    if (manualScrollRef) {
      manualScrollRef.current = true;
    }
    setManualScroll?.(true);
  };

  const markUserScrollIntent = () => {
    userScrollIntentRef.current = true;
    clearUserScrollIntentLater();
  };

  useEffect(() => {
    return () => {
      if (userScrollIntentTimerRef.current != null) {
        clearTimeout(userScrollIntentTimerRef.current);
      }
    };
  }, []);

  const maybeBlockScrollEvent = (event: {
    preventDefault: () => void;
    stopPropagation: () => void;
    target?: EventTarget | null;
    deltaY?: number;
  }) => {
    const editableTarget = isEditableOrOverlayInteractionTarget(
      event.target ?? null,
    );
    if (!editableTarget && (event.deltaY == null || event.deltaY < 0)) {
      markUserScrollIntent();
      markManualScrollAway();
    }
    if (!blockScrollInput) return;
    if (editableTarget) return;
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
      key === "pageup" ||
      key === "home" ||
      key === " " ||
      key === "spacebar"
    ) {
      markUserScrollIntent();
      markManualScrollAway();
    }
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
    if (keepBottomAnchoredRef) {
      keepBottomAnchoredRef.current = true;
    }
    if (manualScrollRef) {
      manualScrollRef.current = false;
    }
    setManualScroll?.(false);
    scrollToBottomRef?.current?.(true);
  }, [
    keepBottomAnchoredRef,
    manualScrollRef,
    scrollToBottomRef,
    setManualScroll,
  ]);

  const scrollToNewestMessages = useCallback(() => {
    forceScrollToBottom();
    setAtBottom(true);
  }, [forceScrollToBottom]);

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
    const messageId = `${field<string>(message, "message_id") ?? ""}`.trim();
    const messageAcpState = messageId
      ? acpState?.get?.(`message:${messageId}`)
      : undefined;
    const attachedSteers = messageId
      ? attachedSteersByParentMessageId?.get(messageId)
      : undefined;

    const is_thread = numChildren != null && isThread(message, numChildren);
    const h = virtuosoHeightsRef.current?.[index];
    const shouldDim = false;

    const wrapperStyle: CSSProperties = {
      overflow: "hidden",
      paddingTop: index == 0 ? "20px" : undefined,
      opacity: shouldDim ? 0.7 : 1,
    };

    return (
      <div style={wrapperStyle}>
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
            acpState={messageAcpState}
            attachedSteers={attachedSteers}
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
            suppressInlineCodexStatus={suppressInlineCodexStatusDate === date}
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
    const host = listContainerRef.current;
    if (!host || !scrollToBottomRef || !keepBottomAnchoredRef) return;
    let frameId: number | undefined;
    const scheduleBottomRestore = () => {
      if (manualScrollRef?.current) return;
      if (!keepBottomAnchoredRef.current) return;
      if (anyOverlayOpen) return;
      if (frameId != null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(() => {
        frameId = undefined;
        if (manualScrollRef?.current) return;
        if (!keepBottomAnchoredRef.current) return;
        if (anyOverlayOpen) return;
        scrollToBottomRef.current?.(true);
      });
    };
    const onLoad = (event: Event) => {
      if (!(event.target instanceof HTMLImageElement)) return;
      scheduleBottomRestore();
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver((entries) => {
            for (const entry of entries) {
              const target = entry.target as HTMLElement | undefined;
              if (target?.dataset?.itemIndex == null) continue;
              scheduleBottomRestore();
              break;
            }
          });
    const observed = new Set<HTMLElement>();
    const observeVisibleItems = () => {
      if (!resizeObserver) return;
      const items = host.querySelectorAll<HTMLElement>("[data-item-index]");
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (observed.has(item)) continue;
        observed.add(item);
        resizeObserver.observe(item);
      }
    };
    const mutationObserver = new MutationObserver(() => {
      observeVisibleItems();
    });
    observeVisibleItems();
    mutationObserver.observe(host, { childList: true, subtree: true });
    host.addEventListener("load", onLoad, true);
    return () => {
      host.removeEventListener("load", onLoad, true);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      if (frameId != null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [
    anyOverlayOpen,
    keepBottomAnchoredRef,
    manualScrollRef,
    scrollToBottomRef,
  ]);

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
        onPointerDownCapture={markUserScrollIntent}
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
      onPointerDownCapture={markUserScrollIntent}
    >
      <StatefulVirtuoso
        style={{ flex: "1 1 0", minHeight: 0 }}
        ref={virtuosoRef}
        totalCount={sortedDates.length + 1}
        cacheId={cacheId}
        persistState={false}
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
                if (
                  endIndex < sortedDates.length - 1 &&
                  userScrollIntentRef.current
                ) {
                  markManualScrollAway();
                }
              }
            : undefined
        }
        atBottomStateChange={
          manualScrollRef
            ? (atBottom: boolean) => {
                if (atBottom) {
                  if (keepBottomAnchoredRef) {
                    keepBottomAnchoredRef.current = true;
                  }
                  manualScrollRef.current = false;
                  setManualScroll?.(false);
                } else if (!atBottom && userScrollIntentRef.current) {
                  markManualScrollAway();
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
      {showNewestMessagesButton ? (
        <Button
          aria-label="Scroll to newest messages"
          size="small"
          type="primary"
          style={NEWEST_MESSAGES_BUTTON_STYLE}
          onClick={scrollToNewestMessages}
        >
          Newest messages
        </Button>
      ) : null}
    </div>
  );
}
