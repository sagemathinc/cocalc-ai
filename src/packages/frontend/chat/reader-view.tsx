/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The reader view: one thread as an inbox. A list of items (each incoming
// message with the agent replies that follow it), unread ones in bold, and a
// reading pane. Opening an item marks it read; y archives it, m marks it
// unread again; j and k move, u goes to the next unread one. The list never
// scrolls by itself: new items wait behind an "N new" button.

import {
  Badge,
  Button,
  Checkbox,
  Empty,
  Modal,
  Popconfirm,
  Segmented,
  Space,
} from "antd";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, TimeAgo } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { dateValue, field, isAcpAssistantMessage } from "./access";
import type { ChatActions } from "./actions";
import CopyButton from "@cocalc/frontend/components/copy-button";
import StaticMarkdown from "./bounded-static-markdown";
import ContextualReply from "./contextual-reply";
import { presentedMessageMarkdown } from "./message-presentation";
import {
  archiveAll,
  findItem,
  isItemArchived,
  isItemRead,
  markAllRead,
  markItemRead,
  markItemUnread,
  readerItems,
  readerMessageId,
  setItemArchived,
  type ReaderChange,
  type ReaderItem,
  type ReaderState,
} from "./reader-model";
import type { ChatMessageTyped } from "./types";
import { getUserName } from "./user-name";
import { newest_content } from "./utils";

const READER_MODE_KEY = "cocalc-chat-reader-mode";
const READER_VIEW_KEY = "cocalc-chat-reader-view";

/**
 * for-you: what is for the person (high and normal); all; filed: low, FYI.
 * One choice for every chat, kept in this browser.
 */
export type ReaderListView = "for-you" | "all" | "filed";

function useReaderListView(): [ReaderListView, (view: ReaderListView) => void] {
  const [view, setView] = useState<ReaderListView>(() => {
    try {
      const stored = localStorage.getItem(READER_VIEW_KEY);
      return stored === "all" || stored === "filed" ? stored : "for-you";
    } catch {
      return "for-you";
    }
  });
  const choose = useCallback((next: ReaderListView) => {
    setView(next);
    try {
      localStorage.setItem(READER_VIEW_KEY, next);
    } catch {
      // Kept for this session only.
    }
  }, []);
  return [view, choose];
}

function readReaderMode(key: string): boolean {
  try {
    return !!JSON.parse(localStorage.getItem(READER_MODE_KEY) ?? "{}")[key];
  } catch {
    return false;
  }
}

/** Whether this chat shows the reader instead of the log; kept per chat. */
export function useChatReaderMode(
  project_id?: string,
  path?: string,
): [boolean, (on: boolean) => void] {
  const key = `${project_id ?? ""}:${path ?? ""}`;
  // Read for the current chat in the same render: a panel reused for
  // another chat must not act on the previous chat's setting even once.
  const [stored, setStored] = useState(() => ({
    key,
    on: readReaderMode(key),
  }));
  const on = stored.key === key ? stored.on : readReaderMode(key);
  const set = useCallback(
    (next: boolean) => {
      setStored({ key, on: next });
      try {
        const all = JSON.parse(localStorage.getItem(READER_MODE_KEY) ?? "{}");
        if (next) all[key] = true;
        else delete all[key];
        localStorage.setItem(READER_MODE_KEY, JSON.stringify(all));
      } catch {
        // Private mode: it lasts until the page is reloaded.
      }
    },
    [key],
  );
  return [on, set];
}

const toJS = (value: any) =>
  typeof value?.toJS === "function" ? value.toJS() : value;

export interface ReaderItemInfo {
  subject: string;
  /** high: for the person; low: FYI, for the record. */
  priority: "high" | "normal" | "low";
}

export function readerSender(message: ChatMessageTyped, userMap: any): string {
  const rpc = toJS(field<any>(message, "agent_rpc"));
  if (rpc?.source?.agent_id) {
    return typeof rpc.source_label === "string" && rpc.source_label.trim()
      ? rpc.source_label.trim()
      : "Agent";
  }
  const sensor = toJS(field<any>(message, "sensor_wake"));
  if (typeof sensor?.sensor_id === "string" && sensor.sensor_id) {
    const title =
      typeof sensor.title === "string" && sensor.title.trim()
        ? sensor.title.trim().slice(0, 100)
        : "sensor";
    return `Sensor: ${title}`;
  }
  if (isAcpAssistantMessage(message)) return "Agent";
  const sender = field<string>(message, "sender_id");
  return sender ? getUserName(userMap, sender) : "Unknown";
}

const optionId = (id: string) => `chat-reader-item-${id}`;

function snippet(message: ChatMessageTyped): string {
  return `${newest_content(message) ?? ""}`
    .replace(/[#*_`>[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** Whether the browser shows this page (not a background tab). */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

export function ChatReaderView({
  actions,
  threadId,
  messages,
  accountId,
  readStateVersion,
  projectId,
  path,
  readOnly,
  isVisible = true,
  fontSize,
  narrow,
  autoFocus,
  renderItem,
  itemBadges,
  acpState,
  itemInfo,
}: {
  actions: ChatActions;
  threadId: string;
  /** The thread's messages, in order. */
  messages: ChatMessageTyped[];
  accountId?: string;
  /** Changes whenever any read state does (here or on another device). */
  readStateVersion?: number;
  projectId?: string;
  path?: string;
  /** A read-only chat: no Reply or Quote, as in the log. */
  readOnly?: boolean;
  /** Whether the chat is on screen (its tab and the browser's). */
  isVisible?: boolean;
  fontSize?: number;
  /** Show the list or the open item, not both side by side. */
  narrow?: boolean;
  /** Move the keyboard focus into the list when it appears. */
  autoFocus?: boolean;
  /**
   * Shows the open item as the chat log shows its messages (activity, live
   * output, questions); without it, each message is shown as Markdown.
   */
  renderItem?: (item: ReaderItem) => ReactNode;
  /** What the list says about an item besides its sender: e.g. a question. */
  itemBadges?: (item: ReaderItem) => ReactNode;
  /** The live state of agent turns: which are running. */
  acpState?: { get?: (key: string) => unknown };
  /** Each item's subject and priority (what its agent said, or defaults). */
  itemInfo?: (item: ReaderItem) => ReaderItemInfo;
}) {
  const userMap = useTypedRedux("users", "user_map");
  // On screen: the chat (its tab) and the page (the browser's tab).
  const pageVisible = usePageVisible();
  const shown = isVisible && pageVisible;
  const items = useMemo(
    () => readerItems(messages, { acpState }),
    [messages, acpState],
  );
  const watermark = useMemo(
    () => (accountId ? actions.getThreadReadCount(threadId, accountId) : 0) - 1,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actions, threadId, accountId, messages, readStateVersion],
  );
  const state: ReaderState = useMemo(
    () => actions.getReaderState(threadId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actions, threadId, readStateVersion],
  );
  const [showArchived, setShowArchived] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  // Without priorities (no itemInfo) there is one view: all.
  const [chosenView, setView] = useReaderListView();
  const view: ReaderListView = itemInfo ? chosenView : "all";
  // Keyed by its contents: itemInfo is a new function every render.
  const filedKey = itemInfo
    ? items
        .filter((item) => itemInfo(item).priority === "low")
        .map((item) => item.id)
        .join("\0")
    : "";
  const filed = useMemo(
    () => new Set(filedKey ? filedKey.split("\0") : []),
    [filedKey],
  );
  const inView = (item: ReaderItem, which: ReaderListView = view) =>
    which === "all" ||
    (which === "filed" ? filed.has(item.id) : !filed.has(item.id));
  // Newest first, as in an inbox: j goes down the list, to older items.
  const visible = useMemo(
    () =>
      items
        .filter(
          (item) =>
            (showArchived || !isItemArchived(item, state)) && inView(item),
        )
        .reverse(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, state, showArchived, view, filed],
  );
  // Counted over every item that is for the person (filed ones are FYI and
  // never counted), as Mark all read reads every item; archived ones are
  // named apart while hidden.
  const unreadIn = (which: ReaderListView, archived?: boolean) =>
    items.filter(
      (item) =>
        inView(item, which) &&
        (archived == null || isItemArchived(item, state) === archived) &&
        !isItemRead(item, watermark, state),
    ).length;
  const unread = useMemo(
    () => unreadIn("for-you"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, watermark, state, filed],
  );
  const hiddenUnread = useMemo(
    () => (showArchived ? 0 : unreadIn("for-you", true)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, watermark, state, showArchived, filed],
  );
  // As the Filed list shows them: archived ones too while they are shown.
  const filedUnread = useMemo(
    () => unreadIn("filed", showArchived ? undefined : false),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, watermark, state, filed, showArchived],
  );
  // In the inbox: not archived, in every view.
  const inboxCount = useMemo(
    () => items.filter((item) => !isItemArchived(item, state)).length,
    [items, state],
  );
  const [selectedId, setSelectedId] = useState<string>();
  const selectedIndex = visible.findIndex((item) => item.id === selectedId);
  const selected: ReaderItem | undefined = visible[selectedIndex];

  // A change is applied to the stored state, which may differ from what is
  // shown here (another device, or not loaded yet).
  const save = useCallback(
    (change: ReaderChange) => actions.updateReaderState(threadId, change),
    [actions, threadId],
  );

  // Narrow: start on a message, not the list (the first unread one from the
  // top, else the newest); once per thread.
  const startedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    // Only once it is shown: a chat restored in a background tab reads nothing.
    if (!shown || !narrow || startedRef.current === threadId || !visible.length)
      return;
    // Not before the read state loads: until then every message looks unread
    // and archived ones look like they are in the inbox.
    if (!(actions.isProjectReadStateReady?.() ?? true)) return;
    startedRef.current = threadId;
    // Kept only if it is in this thread (not one left from the last thread).
    if (selectedId && visible.some((item) => item.id === selectedId)) return;
    const first =
      visible.find((item) => !isItemRead(item, watermark, state)) ?? visible[0];
    setSelectedId(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, narrow, threadId, visible.length, readStateVersion]);

  // Opening an item, or a new reply arriving while it is open, reads it.
  // Not while the chat is hidden: then once it is shown.
  useEffect(() => {
    if (!shown || !selected || isItemRead(selected, watermark, state)) return;
    save((current, watermark) =>
      markItemRead(items, selected, watermark, current),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, selected?.id, selected?.lastId]);

  const open = (index: number | undefined) => {
    if (index == null) return;
    setSelectedId(visible[index]?.id);
    // What had the focus may go (the list when narrow, or the pane's button
    // with its item): keep the keys working.
    focusKeys();
    listRef.current
      ?.querySelector(`[data-reader-item="${visible[index]?.id}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  };
  const archive = (item: ReaderItem) => {
    const archived = !isItemArchived(item, state);
    save((current) => ({
      state: setItemArchived(item, archived, current),
    }));
    if (archived && !showArchived && item.id === selectedId) {
      const next =
        findItem(visible, selectedIndex, 1) ??
        findItem(visible, selectedIndex, -1);
      setSelectedId(next == null ? undefined : visible[next].id);
      // The pane (and its Archive button) is replaced: keep the keys working.
      focusKeys();
    }
  };
  const markUnread = (item: ReaderItem) =>
    save((current) => ({ state: markItemUnread(item, current) }));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest?.("input, textarea, [contenteditable=true]")) return;
    const handled = (() => {
      switch (event.key) {
        case "j":
        case "ArrowDown":
          open(findItem(visible, selectedIndex, 1));
          return true;
        case "k":
        case "ArrowUp":
          open(
            findItem(
              visible,
              selectedIndex < 0 ? visible.length : selectedIndex,
              -1,
            ),
          );
          return true;
        case "u": {
          // The next unread one down the list, then from the top.
          const unreadItem = (item: ReaderItem) =>
            !isItemRead(item, watermark, state);
          open(
            findItem(visible, selectedIndex, 1, unreadItem) ??
              findItem(visible, -1, 1, unreadItem),
          );
          return true;
        }
        case "y":
          if (selected) archive(selected);
          return !!selected;
        case "m":
          if (selected) markUnread(selected);
          return !!selected;
        case "?":
          setShowKeys(true);
          return true;
      }
      return false;
    })();
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  // New items (at the top) wait behind a button instead of moving the list.
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Back to the list (narrow): the keys stay with it once it is shown again.
  const focusListRef = useRef(false);
  useEffect(() => {
    if (!focusListRef.current || !listRef.current) return;
    focusListRef.current = false;
    listRef.current.focus({ preventScroll: true });
  }, [selected?.id]);
  // Narrow, the open item replaces the list: the whole reader takes the keys.
  const focusKeys = () =>
    (narrow ? rootRef : listRef).current?.focus({ preventScroll: true });
  useEffect(() => {
    if (autoFocus) focusKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [seenCount, setSeenCount] = useState(visible.length);
  // Another thread, archived shown or hidden, or another view: nothing there
  // is new.
  const context = `${threadId}\0${showArchived}\0${view}`;
  const contextRef = useRef(context);
  useEffect(() => {
    if (contextRef.current !== context) {
      contextRef.current = context;
      setSeenCount(visible.length);
      return;
    }
    // New items arrive at the top: seen if the list is scrolled to it.
    const list = listRef.current;
    if (list && list.scrollTop < 8) setSeenCount(visible.length);
    else if (visible.length < seenCount) setSeenCount(visible.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length, context]);
  const newCount = Math.max(0, visible.length - seenCount);
  const onListScroll = () => {
    const list = listRef.current;
    if (list && list.scrollTop < 8) setSeenCount(visible.length);
  };

  const list = (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        ...(narrow
          ? { flex: 1 }
          : { width: 340, borderRight: `1px solid ${UI_COLORS.border}` }),
      }}
    >
      <div
        ref={listRef}
        role="listbox"
        aria-label="Messages"
        tabIndex={0}
        aria-activedescendant={selected ? optionId(selected.id) : undefined}
        onScroll={onListScroll}
        style={{ overflowY: "auto", flex: 1, minHeight: 0 }}
      >
        {visible.length === 0 ? (
          <Empty
            style={{ marginTop: 40 }}
            description={
              !items.length
                ? "No messages yet"
                : items.some((item) => inView(item))
                  ? // This view has items: all archived.
                    "Everything here is archived"
                  : view === "for-you"
                    ? "Nothing for you here: the rest is filed"
                    : "Nothing filed"
            }
          />
        ) : null}
        {visible.map((item) => {
          const read = isItemRead(item, watermark, state);
          const first = item.messages[0];
          const date = dateValue(item.messages[item.messages.length - 1]);
          const replies = item.messages.length - 1;
          const info = itemInfo?.(item);
          return (
            <div
              key={item.id}
              data-reader-item={item.id}
              id={optionId(item.id)}
              role="option"
              aria-selected={item.id === selectedId}
              onClick={() => {
                setSelectedId(item.id);
                // The keys work from here on.
                focusKeys();
              }}
              style={{
                padding: narrow ? "12px 12px" : "8px 12px",
                cursor: "pointer",
                borderBottom: `1px solid ${UI_COLORS.border}`,
                background:
                  item.id === selectedId ? UI_COLORS.selected : undefined,
                fontWeight: read ? undefined : 600,
                opacity: isItemArchived(item, state) ? 0.6 : undefined,
                // High: a mark down its side; low: quieter.
                borderLeft: `3px solid ${info?.priority === "high" ? UI_COLORS.warning : "transparent"}`,
                color: info?.priority === "low" ? UI_COLORS.muted : undefined,
              }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                {!read ? (
                  <span
                    aria-label="unread"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      background: UI_COLORS.primary,
                      flex: "none",
                    }}
                  />
                ) : null}
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {readerSender(first, userMap)}
                </span>
                {info?.priority === "high" ? (
                  <span
                    aria-label="For you"
                    style={{
                      color: UI_COLORS.warning,
                      fontSize: 11,
                      flex: "none",
                    }}
                  >
                    for you
                  </span>
                ) : info?.priority === "low" ? (
                  // Not by color alone: low is named too.
                  <span
                    aria-label="Low priority"
                    style={{
                      color: UI_COLORS.muted,
                      fontSize: 11,
                      flex: "none",
                    }}
                  >
                    fyi
                  </span>
                ) : null}
                {itemBadges?.(item)}
                {date ? (
                  <span style={{ color: UI_COLORS.muted, fontSize: 12 }}>
                    <TimeAgo date={date} />
                  </span>
                ) : null}
              </div>
              <div
                style={{
                  color: UI_COLORS.muted,
                  fontSize: 13,
                  fontWeight: 400,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {info ? (
                  info.subject || snippet(first)
                ) : (
                  <>
                    {replies > 0
                      ? `(${replies} ${replies === 1 ? "reply" : "replies"}) `
                      : ""}
                    {snippet(first)}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {/* Always present, so screen readers announce what appears in it. */}
      <div
        role="status"
        aria-live="polite"
        aria-label="New messages"
        style={{
          position: "absolute",
          top: 8,
          left: "50%",
          transform: "translateX(-50%)",
        }}
      >
        {newCount > 0 ? (
          <Button
            size="small"
            shape="round"
            type="primary"
            onClick={() => {
              const list = listRef.current;
              list?.scrollTo?.({ top: 0 });
              setSeenCount(visible.length);
            }}
          >
            {newCount} new
          </Button>
        ) : null}
      </div>
    </div>
  );

  // Narrow (a phone): the message takes the screen; this one row moves
  // between items and acts on the open one.
  const navBar = selected ? (
    <div
      role="toolbar"
      aria-label="Message navigation"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "2px 4px",
        borderBottom: `1px solid ${UI_COLORS.border}`,
        background: UI_COLORS.surface,
      }}
    >
      <Badge count={unread} size="small" offset={[-4, 4]}>
        <Button
          type="text"
          aria-label="All messages"
          icon={<Icon name="bars" />}
          onClick={() => {
            focusListRef.current = true;
            setSelectedId(undefined);
          }}
        />
      </Badge>
      <Button
        type="text"
        aria-label="Newer"
        icon={<Icon name="chevron-up" />}
        disabled={findItem(visible, selectedIndex, -1) == null}
        onClick={() => open(findItem(visible, selectedIndex, -1))}
      />
      <Button
        type="text"
        aria-label="Older"
        icon={<Icon name="chevron-down" />}
        disabled={findItem(visible, selectedIndex, 1) == null}
        onClick={() => open(findItem(visible, selectedIndex, 1))}
      />
      <span
        style={{ color: UI_COLORS.muted, fontSize: 12, flex: 1, marginLeft: 4 }}
      >
        {selectedIndex + 1} of {visible.length}
      </span>
      <Button
        type="text"
        aria-label={
          isItemArchived(selected, state) ? "Move to inbox" : "Archive"
        }
        icon={
          <Icon name={isItemArchived(selected, state) ? "undo" : "container"} />
        }
        onClick={() => archive(selected)}
      />
      <Button
        type="text"
        aria-label="Mark unread"
        icon={<Icon name="mail" />}
        onClick={() => markUnread(selected)}
      />
    </div>
  ) : null;

  const pane = selected ? (
    <div
      key={selected.id}
      role="article"
      aria-label="Message"
      style={{
        flex: 1,
        minWidth: 0,
        ...(renderItem
          ? // The log scrolls itself.
            { display: "flex", flexDirection: "column", minHeight: 0 }
          : {
              overflowY: "auto",
              padding: narrow ? "8px 12px 24px" : "8px 16px 24px",
            }),
      }}
    >
      {narrow ? null : (
        <Space
          wrap
          style={
            renderItem
              ? { padding: "8px 16px 0", flex: "none" }
              : { marginBottom: 8 }
          }
        >
          <Button
            size="small"
            disabled={findItem(visible, selectedIndex, -1) == null}
            onClick={() => open(findItem(visible, selectedIndex, -1))}
          >
            Newer
          </Button>
          <Button
            size="small"
            disabled={findItem(visible, selectedIndex, 1) == null}
            onClick={() => open(findItem(visible, selectedIndex, 1))}
          >
            Older
          </Button>
          <Button size="small" onClick={() => archive(selected)}>
            {isItemArchived(selected, state) ? "Move to inbox" : "Archive"}
          </Button>
          <Button size="small" onClick={() => markUnread(selected)}>
            Mark unread
          </Button>
        </Space>
      )}
      {itemInfo?.(selected).subject ? (
        <div
          role="heading"
          aria-level={2}
          style={{
            flex: "none",
            fontWeight: 600,
            fontSize: (fontSize ?? 14) + 2,
            padding: renderItem ? "6px 16px 0" : "0 0 8px",
          }}
        >
          {itemInfo(selected).subject}
        </div>
      ) : null}
      {renderItem ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {renderItem(selected)}
        </div>
      ) : null}
      {renderItem
        ? null
        : selected.messages.map((message) => {
            const date = dateValue(message);
            const sender = readerSender(message, userMap);
            const value = `${newest_content(message) ?? ""}`;
            // As the log shows it: e.g. an agent message as its "From" card.
            const shown = presentedMessageMarkdown(message, value);
            return (
              <div key={`${date?.valueOf()}`} style={{ marginBottom: 20 }}>
                <div
                  style={{
                    color: UI_COLORS.muted,
                    marginBottom: 4,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <b style={{ color: UI_COLORS.text }}>{sender}</b>
                  {date ? <TimeAgo date={date} /> : null}
                  <CopyButton
                    markdown
                    value={value}
                    size="small"
                    noText
                    style={{ fontSize: "12px" }}
                  />
                </div>
                {/* The log's selection actions: Reply, Quote and Copy. */}
                <ContextualReply
                  actions={actions}
                  projectId={projectId ?? ""}
                  path={path ?? ""}
                  disabled={readOnly || !projectId || !path || !value.trim()}
                  source={{
                    kind: "message",
                    id: readerMessageId(message),
                    thread_id: threadId,
                    title: isAcpAssistantMessage(message)
                      ? "Assistant response"
                      : `Message from ${sender}`,
                  }}
                >
                  <StaticMarkdown
                    value={shown}
                    style={{ fontSize: `${fontSize ?? 14}px` }}
                  />
                </ContextualReply>
              </div>
            );
          })}
    </div>
  ) : narrow ? null : (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: UI_COLORS.muted,
      }}
    >
      Select a message, or press j
    </div>
  );

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label="Reader"
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        outline: "none",
      }}
    >
      {narrow && selected ? (
        navBar
      ) : (
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            padding: "6px 12px",
            borderBottom: `1px solid ${UI_COLORS.border}`,
            flexWrap: "wrap",
          }}
        >
          {/* Status, not a control: how much is left to read. */}
          <span
            style={
              unread
                ? { fontWeight: 600 }
                : { color: UI_COLORS.muted, fontSize: 13 }
            }
          >
            {unread
              ? `${unread} unread${hiddenUnread ? ` (${hiddenUnread} archived)` : ""}`
              : "No unread messages"}
          </span>
          <Button
            size="small"
            disabled={!unread}
            onClick={() => save((current) => markAllRead(items, current))}
          >
            Mark all read
          </Button>
          <Popconfirm
            title={`Archive all ${inboxCount} message${inboxCount === 1 ? "" : "s"}?`}
            description="Everything in this thread is archived and read: a clean slate. A new reply brings a message back."
            okText="Archive all"
            onConfirm={() => {
              save((current) => archiveAll(items, current));
              if (!showArchived) setSelectedId(undefined);
            }}
          >
            <Button size="small" disabled={!inboxCount}>
              Archive all
            </Button>
          </Popconfirm>
          {itemInfo ? (
            <Segmented
              size="small"
              aria-label="Which messages"
              value={view}
              onChange={(value) => setView(value as ReaderListView)}
              options={[
                {
                  value: "for-you",
                  label: unread ? `For you (${unread})` : "For you",
                },
                { value: "all", label: "All" },
                {
                  value: "filed",
                  label: filedUnread ? `Filed (${filedUnread})` : "Filed",
                },
              ]}
            />
          ) : null}
          <Checkbox
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          >
            Show archived
          </Checkbox>
          {narrow ? null : (
            <Button
              size="small"
              type="text"
              icon={<Icon name="keyboard" />}
              onClick={() => setShowKeys(true)}
            >
              Keys
            </Button>
          )}
        </div>
      )}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {narrow && selected ? null : list}
        {pane}
      </div>
      <Modal
        title="Reader keyboard shortcuts"
        open={showKeys}
        footer={null}
        onCancel={() => {
          setShowKeys(false);
          focusKeys();
        }}
      >
        <table aria-label="Keyboard shortcuts">
          <tbody>
            {READER_KEYS.map(([keys, what]) => (
              <tr key={keys}>
                <td style={{ padding: "4px 16px 4px 0", whiteSpace: "nowrap" }}>
                  <kbd>{keys}</kbd>
                </td>
                <td style={{ padding: "4px 0" }}>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ color: UI_COLORS.muted, marginTop: 12, marginBottom: 0 }}>
          Click a message in the list first, so the keys go to the reader.
        </p>
      </Modal>
    </div>
  );
}

const READER_KEYS: [string, string][] = [
  ["j or \u2193", "Older message (down the list)"],
  ["k or \u2191", "Newer message (up the list)"],
  ["u", "Next unread message"],
  ["y", "Archive the open message (again: back to the inbox)"],
  ["m", "Mark the open message unread"],
  ["?", "Show these shortcuts"],
];
