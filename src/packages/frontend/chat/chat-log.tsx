/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Render all the messages in the chat.
*/

// cSpell:ignore: timespan

import {
  createContext,
  KeyboardEvent,
  MutableRefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Button } from "antd";
import { VirtuosoHandle } from "react-virtuoso";
import StatefulVirtuoso from "@cocalc/frontend/components/stateful-virtuoso";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { DivTempHeight } from "@cocalc/frontend/jupyter/div-temp-height";
import { cmp } from "@cocalc/util/misc";
import type { ChatActions } from "./actions";
import { type AttachedSteerMessage } from "./agent-message-status";
import Composing from "./composing";
import Message from "./message";
import type { InlineCodexActivityBlock } from "./message-state";
import type {
  ChatMessageTyped,
  ChatMessages,
  Mode,
  NumChildren,
} from "./types";
import { useAnyChatOverlayOpen } from "./drawer-overlay-state";
import type { ThreadIndexEntry } from "./message-cache";
import { getMessageAtDate, newest_content } from "./utils";
import {
  dateValue,
  field,
  isAcpAssistantMessage,
  parentMessageId,
} from "./access";
import {
  captureChatViewportAnchor,
  loadChatViewportAnchor,
  resolveChatViewportAnchorIndex,
  restoreChatViewportAnchorOffset,
  saveChatViewportAnchor,
} from "./chat-scroll-anchor";
import { getUserName } from "./user-name";
import { getSortedDates } from "./sorted-dates";

export { getSortedDates } from "./sorted-dates";

// you can use this to quickly disabled virtuoso, but rendering large chatrooms will
// become basically impossible.
const USE_VIRTUOSO = true;

function isImmediateAcpSteerMessage(message: ChatMessageTyped): boolean {
  return field<string>(message, "acp_send_mode") === "immediate";
}

function sameInlineCodexActivityBlocks(
  left?: InlineCodexActivityBlock[],
  right?: InlineCodexActivityBlock[],
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return left == null && right == null;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (
      a.kind !== b.kind ||
      a.text !== b.text ||
      a.time !== b.time ||
      a.state !== b.state
    ) {
      return false;
    }
  }
  return true;
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
    if (isAcpAssistantMessage(directParent)) {
      const assistantParentId = `${parentMessageId(directParent) ?? ""}`.trim();
      return assistantParentId || directParentId;
    }
    return directParentId;
  }
  return undefined;
}

function resolveSteerAssistantMessageId({
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
    if (directParent == null) return undefined;
    if (isImmediateAcpSteerMessage(directParent)) {
      current = directParent;
      guard += 1;
      continue;
    }
    if (!isAcpAssistantMessage(directParent)) {
      return undefined;
    }
    const assistantMessageId =
      `${field<string>(directParent, "message_id") ?? ""}`.trim();
    return assistantMessageId || undefined;
  }
  return undefined;
}

function isActiveAcpAssistantTurn({
  message,
  acpState,
}: {
  message?: ChatMessageTyped;
  acpState?: { get?: (key: string) => unknown };
}): boolean {
  if (message == null) return false;
  if (field<boolean>(message, "generating") === true) return true;
  const threadId = `${field<string>(message, "thread_id") ?? ""}`.trim();
  const states = [
    resolvedMessageAcpState({ message, acpState }),
    threadId ? acpState?.get?.(`thread:${threadId}`) : undefined,
  ];
  return states.some(
    (state) => state === "running" || state === "queue" || state === "queued",
  );
}

type SteerCollections = {
  attachedByParentMessageId: Map<string, AttachedSteerMessage[]>;
  byAssistantMessageId: Map<string, AttachedSteerMessage[]>;
  representedMessageIds: Set<string>;
};

const ActivitySteersContext = createContext<
  Map<string, AttachedSteerMessage[]> | undefined
>(undefined);

function ReactiveActivitySteersMessage({
  steerMessageId,
  activitySteers,
  ...props
}: ComponentProps<typeof Message> & { steerMessageId: string }) {
  const currentActivitySteers = useContext(ActivitySteersContext);
  return (
    <Message
      {...props}
      activitySteers={
        currentActivitySteers == null
          ? activitySteers
          : currentActivitySteers.get(steerMessageId)
      }
    />
  );
}

function collectSteers({
  messages,
  visibleKeys,
  acpState,
}: {
  messages: ChatMessages;
  visibleKeys?: Set<string>;
  acpState?: { get?: (key: string) => unknown };
}): SteerCollections {
  const attachedByParentMessageId = new Map<string, AttachedSteerMessage[]>();
  const byAssistantMessageId = new Map<string, AttachedSteerMessage[]>();
  const representedMessageIds = new Set<string>();
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
    const assistantMessageId = resolveSteerAssistantMessageId({
      message,
      byMessageId,
    });
    const state = toAttachedSteerState(
      resolvedMessageAcpState({ message, acpState }),
    );
    if (!state || !anchoredParentId) continue;
    const steer = {
      messageId,
      assistantMessageId,
      date: messageDate.valueOf(),
      text,
      state,
    };
    const activeAssistantTurn = isActiveAcpAssistantTurn({
      message: assistantMessageId
        ? byMessageId.get(assistantMessageId)
        : undefined,
      acpState,
    });
    // Hide the durable row only after an alternative visible representation exists.
    if (activeAssistantTurn && assistantMessageId) {
      const next = byAssistantMessageId.get(assistantMessageId) ?? [];
      next.push(steer);
      byAssistantMessageId.set(assistantMessageId, next);
      representedMessageIds.add(messageId);
      continue;
    }
    if (!byMessageId.has(anchoredParentId)) continue;
    if (assistantMessageId) {
      const next = byAssistantMessageId.get(assistantMessageId) ?? [];
      next.push(steer);
      byAssistantMessageId.set(assistantMessageId, next);
    }
    const next = attachedByParentMessageId.get(anchoredParentId) ?? [];
    next.push(steer);
    attachedByParentMessageId.set(anchoredParentId, next);
    representedMessageIds.add(messageId);
  }
  for (const list of attachedByParentMessageId.values()) {
    list.sort((a, b) => cmp(a.date, b.date));
  }
  for (const list of byAssistantMessageId.values()) {
    list.sort((a, b) => cmp(a.date, b.date));
  }
  return {
    attachedByParentMessageId,
    byAssistantMessageId,
    representedMessageIds,
  };
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

const CHAT_VIRTUOSO_STYLE: CSSProperties = {
  flex: "1 1 0",
  minHeight: 0,
} as const;

const NEWEST_MESSAGES_BUTTON_STYLE: CSSProperties = {
  position: "absolute",
  left: "50%",
  bottom: 14,
  transform: "translateX(-50%)",
  zIndex: 5,
} as const;

// Chat messages can contain rich static render trees. Keep a modest offscreen
// buffer for smooth scrolling without mounting a huge history window.
const CHAT_VIRTUOSO_INCREASE_VIEWPORT_BY = {
  top: 1200,
  bottom: 1600,
} as const;

const INSTANT_SCROLL_BEHAVIOR = "auto" as const;

export function measureChatVirtuosoItemHeight(element: HTMLElement): number {
  // Virtuoso compares measurements exactly. Subpixel values can alternate as
  // its spacer layout changes, so never feed fractional heights back through
  // DivTempHeight and the ResizeObserver measurement cycle.
  return Math.ceil(element.getBoundingClientRect().height);
}

function isEditableOrOverlayInteractionTarget(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('[data-chat-selectable-message="true"]')) return false;
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
  docVersion?: number;
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
  isVisible?: boolean;
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
  readOnly?: boolean;
}

export function ChatLog({
  project_id,
  path,
  messages: messagesProp,
  threadIndex,
  docVersion,
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
  isVisible = true,
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
  readOnly = false,
}: Props) {
  const singleThreadView = selectedThread != null;
  const messages = messagesProp ?? new Map();
  const visibleKeys = useMemo<Set<string> | undefined>(() => {
    if (!selectedThread || !threadIndex) return undefined;
    return threadIndex.get(selectedThread)?.messageKeys;
  }, [selectedThread, threadIndex]);
  const user_map = useTypedRedux("users", "user_map");
  const account_id = useTypedRedux("account", "account_id");
  const steerCollections = useMemo(
    () => collectSteers({ messages, visibleKeys, acpState }),
    [messages, visibleKeys, acpState, docVersion],
  );
  const anyOverlayOpen = useAnyChatOverlayOpen();
  const activeTopTab = useTypedRedux("page", "active_top_tab");
  const activeProjectTab = useTypedRedux({ project_id }, "active_project_tab");
  const isForegroundChatTab =
    activeTopTab === project_id && activeProjectTab === `editor-${path}`;
  const canAutoScroll =
    isVisible &&
    !anyOverlayOpen &&
    (mode === "sidechat" || isForegroundChatTab);
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
      steerCollections.representedMessageIds,
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
  }, [
    messages,
    account_id,
    docVersion,
    singleThreadView,
    steerCollections.representedMessageIds,
    visibleKeys,
  ]);

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
      virtuosoRef.current?.scrollToIndex({
        index: scrollToIndex,
        behavior: INSTANT_SCROLL_BEHAVIOR,
      });
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
    virtuosoRef.current?.scrollToIndex({
      index,
      behavior: INSTANT_SCROLL_BEHAVIOR,
    });
    actions.clearScrollRequest();
  }, [scrollToDate, canAutoScroll, sortedDates, messages, actions]);

  useEffect(() => {
    if (!canAutoScroll) return;
    if (searchJumpDate == null || searchJumpDate === "") return;
    const index = sortedDates.indexOf(searchJumpDate);
    if (index < 0) return;
    keepBottomAnchoredRef.current = false;
    if (USE_VIRTUOSO) {
      virtuosoRef.current?.scrollToIndex({
        index,
        align: "center",
        behavior: INSTANT_SCROLL_BEHAVIOR,
      });
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
        virtuosoRef.current?.scrollToIndex({
          index: Number.MAX_SAFE_INTEGER,
          behavior: INSTANT_SCROLL_BEHAVIOR,
        });
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
      <ActivitySteersContext.Provider
        value={steerCollections.byAssistantMessageId}
      >
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
            isVisible,
            scrollToDate,
            scrollToBottomRef,
            scrollToIndex,
            keepBottomAnchoredRef,
            acpState,
            attachedSteersByParentMessageId:
              steerCollections.attachedByParentMessageId,
            activitySteersByAssistantMessageId:
              steerCollections.byAssistantMessageId,
            searchQuery,
            searchJumpDate,
            searchJumpToken,
            onAtTopStateChange,
            activityJumpDate,
            activityJumpToken,
            notifyOnTurnFinish,
            onNotifyOnTurnFinishChange,
            selectedThread,
            anyOverlayOpen,
            onOpenGitBrowser,
            suppressInlineCodexStatusDate,
            readOnly,
          }}
        />
      </ActivitySteersContext.Provider>
      {!readOnly ? (
        <Composing
          actions={actions}
          projectId={project_id}
          path={path}
          accountId={account_id}
          userMap={user_map}
        />
      ) : null}
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

function normalizeMessageAcpState(state: unknown): string | undefined {
  if (state === "queued") return "queue";
  return typeof state === "string" && state.length > 0 ? state : undefined;
}

function resolvedMessageAcpState({
  message,
  acpState,
  hasAcpReply,
}: {
  message: ChatMessageTyped;
  acpState?: { get?: (key: string) => unknown };
  hasAcpReply?: boolean;
}): string | undefined {
  const messageId = `${field<string>(message, "message_id") ?? ""}`.trim();
  if (messageId && acpState != null) {
    const storedState = normalizeMessageAcpState(
      acpState.get?.(`message:${messageId}`),
    );
    if (storedState != null) return storedState;
  }
  const rowState = normalizeMessageAcpState(
    field<string>(message, "acp_state"),
  );
  return hasAcpReply === true && rowState === "queue" ? undefined : rowState;
}

function acpReplyParentMessageIds(messages: ChatMessages): Set<string> {
  const parentMessageIds = new Set<string>();
  for (const [, other] of messages) {
    if (other == null) continue;
    if (!isAcpAssistantMessage(other)) continue;
    const parentId = `${parentMessageId(other) ?? ""}`.trim();
    if (parentId) {
      parentMessageIds.add(parentId);
    }
  }
  return parentMessageIds;
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
  isVisible = true,
  scrollToDate,
  scrollToBottomRef,
  scrollToIndex,
  keepBottomAnchoredRef,
  acpState,
  attachedSteersByParentMessageId,
  activitySteersByAssistantMessageId,
  searchQuery,
  searchJumpDate,
  searchJumpToken,
  onAtTopStateChange,
  activityJumpDate,
  activityJumpToken,
  notifyOnTurnFinish,
  onNotifyOnTurnFinishChange,
  selectedThread,
  anyOverlayOpen = false,
  onOpenGitBrowser,
  suppressInlineCodexStatusDate,
  readOnly = false,
  virtualized = true,
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
  isVisible?: boolean;
  scrollToDate?: null | string;
  scrollToBottomRef?: MutableRefObject<(force?: boolean) => void>;
  scrollToIndex?: null | number;
  keepBottomAnchoredRef?: MutableRefObject<boolean>;
  acpState?;
  attachedSteersByParentMessageId?: Map<string, AttachedSteerMessage[]>;
  activitySteersByAssistantMessageId?: Map<string, AttachedSteerMessage[]>;
  searchQuery?: string;
  searchJumpDate?: string;
  searchJumpToken?: number;
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
  readOnly?: boolean;
  virtualized?: boolean;
}) {
  const useVirtuoso = virtualized && USE_VIRTUOSO;
  const defaultVirtuosoRef = useRef<VirtuosoHandle>(null);
  const listVirtuosoRef = virtuosoRef ?? defaultVirtuosoRef;
  const virtuosoHeightsRef = useRef<{ [index: number]: number }>({});
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const cacheId = scrollCacheId ?? `${project_id}${path}`;
  const initialAnchor = useMemo(
    () => loadChatViewportAnchor(cacheId),
    [cacheId],
  );
  const initialAnchorIndex =
    initialAnchor?.atBottom === false
      ? resolveChatViewportAnchorIndex(initialAnchor, sortedDates)
      : undefined;
  const initialIndex = Math.max(
    initialAnchorIndex ?? sortedDates.length - 1,
    0,
  ); // start at newest unless we have a saved viewport anchor
  const endRef = useRef<HTMLDivElement | null>(null);
  const blockScrollInput = anyOverlayOpen === true;
  const showNewestMessagesButton =
    sortedDates.length > 0 && (!atBottom || manualScroll);
  const canNotifyForRunningTurn =
    selectedThread != null && onNotifyOnTurnFinishChange != null;
  const [
    expandedCodexActivityByMessageId,
    setExpandedCodexActivityByMessageId,
  ] = useState<Record<string, boolean>>({});
  const [
    explicitCodexActivityByMessageId,
    setExplicitCodexActivityByMessageId,
  ] = useState<Record<string, boolean>>({});
  const [
    cachedCodexActivityBlocksByMessageId,
    setCachedCodexActivityBlocksByMessageId,
  ] = useState<Record<string, InlineCodexActivityBlock[] | undefined>>({});
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const sortedDatesRef = useRef(sortedDates);
  const anchorCaptureFrameRef = useRef<number | undefined>(undefined);
  const anchorRestoreTokenRef = useRef(0);
  const anchorRestoreTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const visibilityRestoreTokenRef = useRef(0);
  const visibilityRestoreTimersRef = useRef<ReturnType<typeof setTimeout>[]>(
    [],
  );
  const suppressAnchorCaptureUntilRef = useRef(0);
  const suppressAnchorRestoreUntilRef = useRef(0);
  const isVisibleRef = useRef(isVisible);

  sortedDatesRef.current = sortedDates;
  isVisibleRef.current = isVisible;

  const clearAnchorRestoreTimers = () => {
    anchorRestoreTokenRef.current += 1;
    for (const timer of anchorRestoreTimersRef.current) {
      clearTimeout(timer);
    }
    anchorRestoreTimersRef.current = [];
  };

  const scheduleAnchorCapture = useCallback(
    (forceAtBottom?: boolean) => {
      if (!useVirtuoso) return;
      if (!isVisibleRef.current) return;
      if (!forceAtBottom && Date.now() < suppressAnchorCaptureUntilRef.current)
        return;
      if (anchorCaptureFrameRef.current != null) return;
      const capture = () => {
        anchorCaptureFrameRef.current = undefined;
        if (
          !forceAtBottom &&
          Date.now() < suppressAnchorCaptureUntilRef.current
        )
          return;
        if (!isVisibleRef.current) return;
        const anchor = captureChatViewportAnchor({
          forceAtBottom,
          scroller: scrollerRef.current,
          sortedDates: sortedDatesRef.current,
        });
        saveChatViewportAnchor(cacheId, anchor);
      };
      if (typeof requestAnimationFrame === "function") {
        anchorCaptureFrameRef.current = requestAnimationFrame(capture);
      } else {
        anchorCaptureFrameRef.current = window.setTimeout(capture, 0);
      }
    },
    [cacheId, useVirtuoso],
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
    clearAnchorRestoreTimers();
    userScrollIntentRef.current = true;
    clearUserScrollIntentLater();
  };

  useEffect(() => {
    return () => {
      if (userScrollIntentTimerRef.current != null) {
        clearTimeout(userScrollIntentTimerRef.current);
      }
      if (anchorCaptureFrameRef.current != null) {
        if (typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(anchorCaptureFrameRef.current);
        } else {
          clearTimeout(anchorCaptureFrameRef.current);
        }
      }
      clearAnchorRestoreTimers();
      for (const timer of visibilityRestoreTimersRef.current) {
        clearTimeout(timer);
      }
      visibilityRestoreTimersRef.current = [];
    };
  }, []);

  useEffect(() => {
    const latestLiveCodexTurnIdsByThread = new Map<string, string>();
    for (const date of sortedDates) {
      const message = getMessageAtDate({
        messages,
        date: parseFloat(date),
      });
      if (
        message == null ||
        !isAcpAssistantMessage(message) ||
        !isActiveAcpAssistantTurn({ message, acpState })
      ) {
        continue;
      }
      const messageId = `${field<string>(message, "message_id") ?? ""}`.trim();
      if (!messageId) continue;
      const threadKey =
        `${field<string>(message, "thread_id") ?? ""}`.trim() || messageId;
      latestLiveCodexTurnIdsByThread.set(threadKey, messageId);
    }
    const liveCodexTurnIds = Array.from(
      latestLiveCodexTurnIdsByThread.values(),
    );
    if (liveCodexTurnIds.length === 0) return;
    setExpandedCodexActivityByMessageId((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const messageId of liveCodexTurnIds) {
        if (next[messageId] === true) continue;
        next[messageId] = true;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [sortedDates, messages, acpState]);

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
    scheduleAnchorCapture(true);
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
    scheduleAnchorCapture,
    scrollToBottomRef,
    setManualScroll,
  ]);

  const restoreSavedAnchor = useCallback(
    (anchor = loadChatViewportAnchor(cacheId)) => {
      if (!useVirtuoso || !anchor) return;
      if (!isVisibleRef.current) return;
      if (Date.now() < suppressAnchorRestoreUntilRef.current) return;
      if (scrollToDate != null || scrollToIndex != null) return;
      if (activityJumpDate != null || activityJumpToken != null) return;
      if (searchJumpDate != null || searchJumpToken != null) return;
      const dates = sortedDatesRef.current;
      if (dates.length === 0) return;

      clearAnchorRestoreTimers();
      suppressAnchorCaptureUntilRef.current = Date.now() + 1200;

      if (anchor.atBottom) {
        if (keepBottomAnchoredRef) {
          keepBottomAnchoredRef.current = true;
        }
        if (manualScrollRef) {
          manualScrollRef.current = false;
        }
        setManualScroll?.(false);
        setAtBottom(true);
        listVirtuosoRef.current?.scrollToIndex({
          index: Number.MAX_SAFE_INTEGER,
          behavior: INSTANT_SCROLL_BEHAVIOR,
        });
        scrollToBottomRef?.current?.(true);
        return;
      }

      const index = resolveChatViewportAnchorIndex(anchor, dates);
      if (index == null) return;
      if (keepBottomAnchoredRef) {
        keepBottomAnchoredRef.current = false;
      }
      if (manualScrollRef) {
        manualScrollRef.current = true;
      }
      setManualScroll?.(true);
      setAtBottom(false);
      listVirtuosoRef.current?.scrollToIndex({
        index,
        align: "start",
        behavior: INSTANT_SCROLL_BEHAVIOR,
      });

      const token = ++anchorRestoreTokenRef.current;
      for (const delayMs of [0, 16, 75, 200, 500, 1000]) {
        const timer = setTimeout(() => {
          if (anchorRestoreTokenRef.current !== token) return;
          restoreChatViewportAnchorOffset({
            anchor,
            scroller: scrollerRef.current,
            sortedDates: sortedDatesRef.current,
          });
        }, delayMs);
        anchorRestoreTimersRef.current.push(timer);
      }
    },
    [
      activityJumpDate,
      activityJumpToken,
      cacheId,
      keepBottomAnchoredRef,
      listVirtuosoRef,
      manualScrollRef,
      scrollToBottomRef,
      scrollToDate,
      scrollToIndex,
      searchJumpDate,
      searchJumpToken,
      setManualScroll,
      useVirtuoso,
    ],
  );

  useEffect(() => {
    if (
      scrollToDate == null &&
      scrollToIndex == null &&
      activityJumpDate == null &&
      activityJumpToken == null &&
      searchJumpDate == null &&
      searchJumpToken == null
    ) {
      return;
    }
    clearAnchorRestoreTimers();
    suppressAnchorRestoreUntilRef.current = Date.now() + 1500;
  }, [
    activityJumpDate,
    activityJumpToken,
    scrollToDate,
    scrollToIndex,
    searchJumpDate,
    searchJumpToken,
  ]);

  useEffect(() => {
    if (!useVirtuoso) return;
    if (!isVisible) return;
    if (!sortedDates.length) return;
    restoreSavedAnchor();
  }, [cacheId, isVisible, restoreSavedAnchor, sortedDates.length, useVirtuoso]);

  useEffect(() => {
    if (!useVirtuoso) return;
    if (!isVisible) return;
    for (const timer of visibilityRestoreTimersRef.current) {
      clearTimeout(timer);
    }
    visibilityRestoreTimersRef.current = [];
    const token = ++visibilityRestoreTokenRef.current;
    for (const delayMs of [0, 16, 75, 250]) {
      const timer = setTimeout(() => {
        if (visibilityRestoreTokenRef.current !== token) return;
        restoreSavedAnchor();
      }, delayMs);
      visibilityRestoreTimersRef.current.push(timer);
    }
  }, [isVisible, restoreSavedAnchor, useVirtuoso]);

  useEffect(() => {
    if (!useVirtuoso) return;
    const restoreIfVisible = () => {
      if (document.visibilityState === "hidden") return;
      if (!isVisibleRef.current) return;
      restoreSavedAnchor();
    };
    document.addEventListener("visibilitychange", restoreIfVisible);
    window.addEventListener("focus", restoreIfVisible);
    return () => {
      document.removeEventListener("visibilitychange", restoreIfVisible);
      window.removeEventListener("focus", restoreIfVisible);
    };
  }, [restoreSavedAnchor, useVirtuoso]);

  const scrollToNewestMessages = useCallback(() => {
    forceScrollToBottom();
    setAtBottom(true);
  }, [forceScrollToBottom]);

  const acpReplyParents = useMemo(
    () => acpReplyParentMessageIds(messages),
    [messages],
  );

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
      ? resolvedMessageAcpState({
          message,
          acpState,
          hasAcpReply: acpReplyParents.has(messageId),
        })
      : undefined;
    const activitySteers = messageId
      ? activitySteersByAssistantMessageId?.get(messageId)
      : undefined;
    const attachedSteers = messageId
      ? attachedSteersByParentMessageId
          ?.get(messageId)
          ?.filter(
            (steer) =>
              !steer.assistantMessageId ||
              expandedCodexActivityByMessageId[steer.assistantMessageId] !==
                true,
          )
      : undefined;
    const expandedCodexActivity = messageId
      ? expandedCodexActivityByMessageId[messageId] === true
      : false;
    const allowAsyncCompletedCodexActivityLoad = messageId
      ? explicitCodexActivityByMessageId[messageId] === true
      : false;
    const cachedCodexActivityBlocks = messageId
      ? cachedCodexActivityBlocksByMessageId[messageId]
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
          <ReactiveActivitySteersMessage
            steerMessageId={messageId}
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
            scroll_into_view={() =>
              listVirtuosoRef.current?.scrollIntoView({ index })
            }
            allowReply={
              !readOnly &&
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
            acpState={messageAcpState}
            attachedSteers={attachedSteers}
            activitySteers={activitySteers}
            expandedCodexActivity={expandedCodexActivity}
            allowAsyncCompletedCodexActivityLoad={
              !readOnly && allowAsyncCompletedCodexActivityLoad
            }
            cachedCodexActivityBlocks={cachedCodexActivityBlocks}
            onCachedCodexActivityBlocksChange={
              messageId
                ? (blocks) => {
                    setCachedCodexActivityBlocksByMessageId((prev) => {
                      const current = prev[messageId];
                      if (sameInlineCodexActivityBlocks(current, blocks)) {
                        return prev;
                      }
                      if (
                        blocks == null ||
                        !Array.isArray(blocks) ||
                        blocks.length === 0
                      ) {
                        if (!(messageId in prev)) return prev;
                        const next = { ...prev };
                        delete next[messageId];
                        return next;
                      }
                      return { ...prev, [messageId]: blocks };
                    });
                  }
                : undefined
            }
            onExpandedCodexActivityChange={
              messageId
                ? (visible: boolean) => {
                    setExplicitCodexActivityByMessageId((prev) => {
                      if ((prev[messageId] === true) === visible) {
                        return prev;
                      }
                      if (!visible) {
                        const next = { ...prev };
                        delete next[messageId];
                        return next;
                      }
                      return { ...prev, [messageId]: true };
                    });
                    setExpandedCodexActivityByMessageId((prev) => {
                      if ((prev[messageId] === true) === visible) {
                        return prev;
                      }
                      if (!visible) {
                        const next = { ...prev };
                        delete next[messageId];
                        return next;
                      }
                      return { ...prev, [messageId]: true };
                    });
                  }
                : undefined
            }
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
            onOpenGitBrowser={readOnly ? undefined : onOpenGitBrowser}
            suppressInlineCodexStatus={suppressInlineCodexStatusDate === date}
            read_only={readOnly}
          />
        </DivTempHeight>
      </div>
    );
  };

  // react-virtuoso republishes changed function props synchronously from a
  // layout effect. Chat messages can rerender several times per second while
  // streaming, so keep the functions stable and forward them to current state
  // through this ref instead of restarting Virtuoso's measurement graph.
  const virtuosoCallbackStateRef = useRef({
    keepBottomAnchoredRef,
    manualScrollRef,
    markManualScrollAway,
    onAtTopStateChange,
    scheduleAnchorCapture,
    setManualScroll,
    sortedDatesLength: sortedDates.length,
  });
  virtuosoCallbackStateRef.current = {
    keepBottomAnchoredRef,
    manualScrollRef,
    markManualScrollAway,
    onAtTopStateChange,
    scheduleAnchorCapture,
    setManualScroll,
    sortedDatesLength: sortedDates.length,
  };

  const handleVirtuosoScrollerRef = useCallback(
    (node: HTMLElement | Window | null) => {
      scrollerRef.current = node instanceof HTMLElement ? node : null;
    },
    [],
  );
  const measureVirtuosoItem = useCallback((element: HTMLElement) => {
    const height = measureChatVirtuosoItemHeight(element);
    const data = element.getAttribute("data-item-index");
    if (data != null) {
      const index = parseInt(data);
      virtuosoHeightsRef.current[index] = height;
    }
    return height;
  }, []);
  type ChatVirtualRow = {
    key: string;
    render: () => ReactNode;
  };
  const steerRowKey = (date: string): string => {
    const message = getMessageAtDate({
      messages,
      date: parseFloat(date),
    });
    const messageId = `${field<string>(message, "message_id") ?? ""}`.trim();
    if (!messageId) return date;
    const activitySteers =
      activitySteersByAssistantMessageId?.get(messageId) ?? [];
    const attachedSteers =
      attachedSteersByParentMessageId?.get(messageId) ?? [];
    const revision = [
      ...activitySteers.map(
        ({ messageId, state }) => `activity:${messageId}:${state}`,
      ),
      ...attachedSteers.map(
        ({ messageId, state }) => `attached:${messageId}:${state}`,
      ),
    ].join("|");
    return revision ? `${date}:${revision}` : date;
  };
  // Virtuoso memoizes mounted items. The key includes guidance revisions so an
  // existing assistant activity row remounts when guidance is added or changes
  // state, without remounting the rest of the chat history.
  const virtuosoData: ChatVirtualRow[] = Array.from(
    { length: sortedDates.length + 1 },
    (_, index) => {
      const date = sortedDates[index];
      return {
        key: date == null ? "end" : steerRowKey(date),
        render:
          index === sortedDates.length
            ? () => <div style={{ height: "25px" }} />
            : () => renderMessage(index),
      };
    },
  );
  const renderVirtuosoItem = useCallback(
    (_index: number, row: ChatVirtualRow) => row.render(),
    [],
  );
  const computeVirtuosoItemKey = useCallback(
    (_index: number, row: ChatVirtualRow) => row.key,
    [],
  );
  const handleVirtuosoRangeChanged = useCallback(
    ({ endIndex }: { endIndex: number }) => {
      const {
        manualScrollRef,
        markManualScrollAway,
        scheduleAnchorCapture,
        sortedDatesLength,
      } = virtuosoCallbackStateRef.current;
      if (!manualScrollRef) return;
      scheduleAnchorCapture();
      if (endIndex < sortedDatesLength - 1 && userScrollIntentRef.current) {
        markManualScrollAway();
      }
    },
    [],
  );
  const handleVirtuosoAtBottomStateChange = useCallback((atBottom: boolean) => {
    const {
      keepBottomAnchoredRef,
      manualScrollRef,
      markManualScrollAway,
      scheduleAnchorCapture,
      setManualScroll,
    } = virtuosoCallbackStateRef.current;
    if (!manualScrollRef) return;
    if (atBottom) {
      scheduleAnchorCapture(true);
      if (keepBottomAnchoredRef) {
        keepBottomAnchoredRef.current = true;
      }
      manualScrollRef.current = false;
      setManualScroll?.(false);
    } else if (userScrollIntentRef.current) {
      markManualScrollAway();
      scheduleAnchorCapture();
    }
    setAtBottom(atBottom);
  }, []);
  const handleVirtuosoAtTopStateChange = useCallback((atTop: boolean) => {
    virtuosoCallbackStateRef.current.onAtTopStateChange?.(atTop);
  }, []);
  const handleVirtuosoScroll = useCallback(() => {
    virtuosoCallbackStateRef.current.scheduleAnchorCapture();
  }, []);

  useEffect(() => {
    if (!scrollToBottomRef || useVirtuoso) return;
    scrollToBottomRef.current = () => {
      endRef.current?.scrollIntoView({ block: "end" });
    };
  }, [scrollToBottomRef, useVirtuoso]);

  useEffect(() => {
    if (!useVirtuoso) return;
    const host = listContainerRef.current;
    if (!host || !scrollToBottomRef || !keepBottomAnchoredRef) return;
    let frameId: number | undefined;
    const scheduleLayoutRestore = () => {
      const anchor = loadChatViewportAnchor(cacheId);
      if (!isVisibleRef.current) return;
      if (anchor && !anchor.atBottom) {
        restoreSavedAnchor(anchor);
        return;
      }
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
      scheduleLayoutRestore();
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver((entries) => {
            for (const entry of entries) {
              const target = entry.target as HTMLElement | undefined;
              if (target?.dataset?.itemIndex == null) continue;
              scheduleLayoutRestore();
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
    cacheId,
    keepBottomAnchoredRef,
    manualScrollRef,
    restoreSavedAnchor,
    scrollToBottomRef,
    useVirtuoso,
  ]);

  useEffect(() => {
    if (!useVirtuoso) return;
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
  }, [sortedDates.length, useVirtuoso]);

  if (!useVirtuoso) {
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
        style={CHAT_VIRTUOSO_STYLE}
        ref={listVirtuosoRef}
        scrollerRef={handleVirtuosoScrollerRef}
        totalCount={sortedDates.length + 1}
        data={virtuosoData}
        context={virtuosoCallbackStateRef.current}
        cacheId={cacheId}
        persistState={false}
        increaseViewportBy={CHAT_VIRTUOSO_INCREASE_VIEWPORT_BY}
        initialTopMostItemIndex={initialIndex}
        atTopThreshold={240}
        itemSize={measureVirtuosoItem}
        itemContent={renderVirtuosoItem}
        computeItemKey={computeVirtuosoItemKey}
        rangeChanged={manualScrollRef ? handleVirtuosoRangeChanged : undefined}
        atBottomStateChange={
          manualScrollRef ? handleVirtuosoAtBottomStateChange : undefined
        }
        atTopStateChange={
          onAtTopStateChange ? handleVirtuosoAtTopStateChange : undefined
        }
        onScroll={handleVirtuosoScroll}
        followOutput={isVisible && !manualScroll && atBottom && !anyOverlayOpen}
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
