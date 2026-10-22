/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The reader view: one thread as an inbox. A list of items (each incoming
// message with the agent replies that follow it), unread ones in bold, and a
// reading pane. Opening an item marks it read; y archives it, m marks it
// unread again; j and k move, u goes to the next unread one. The list never
// scrolls by itself: new items wait behind an "N new" button.

import { Button, Checkbox, Empty, Space, Tooltip } from "antd";
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, TimeAgo } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { dateValue, field, isAcpAssistantMessage } from "./access";
import type { ChatActions } from "./actions";
import StaticMarkdown from "./bounded-static-markdown";
import {
  findItem,
  isItemArchived,
  isItemRead,
  markAllRead,
  markItemRead,
  markItemUnread,
  readerItems,
  setItemArchived,
  type ReaderItem,
  type ReaderState,
} from "./reader-model";
import type { ChatMessageTyped } from "./types";
import { getUserName } from "./user-name";
import { newest_content } from "./utils";

const READER_MODE_KEY = "cocalc-chat-reader-mode";

/** Whether this chat shows the reader instead of the log; kept per chat. */
export function useChatReaderMode(
  project_id?: string,
  path?: string,
): [boolean, (on: boolean) => void] {
  const key = `${project_id ?? ""}:${path ?? ""}`;
  const read = () => {
    try {
      return !!JSON.parse(localStorage.getItem(READER_MODE_KEY) ?? "{}")[key];
    } catch {
      return false;
    }
  };
  const [on, setOn] = useState(read);
  useEffect(() => setOn(read()), [key]);
  const set = useCallback(
    (next: boolean) => {
      setOn(next);
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

function snippet(message: ChatMessageTyped): string {
  return `${newest_content(message) ?? ""}`
    .replace(/[#*_`>[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function ChatReaderView({
  actions,
  threadId,
  messages,
  accountId,
  readStateVersion,
  fontSize,
  narrow,
  onShowInChat,
}: {
  actions: ChatActions;
  threadId: string;
  /** The thread's messages, in order. */
  messages: ChatMessageTyped[];
  accountId?: string;
  /** Changes whenever any read state does (here or on another device). */
  readStateVersion?: number;
  fontSize?: number;
  /** Show the list or the open item, not both side by side. */
  narrow?: boolean;
  onShowInChat?: (date: Date) => void;
}) {
  const userMap = useTypedRedux("users", "user_map");
  const items = useMemo(() => readerItems(messages), [messages]);
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
  const visible = useMemo(
    () =>
      showArchived
        ? items
        : items.filter((item) => !isItemArchived(item, state)),
    [items, state, showArchived],
  );
  const unread = useMemo(
    () => visible.filter((item) => !isItemRead(item, watermark, state)).length,
    [visible, watermark, state],
  );
  const [selectedId, setSelectedId] = useState<string>();
  const selectedIndex = visible.findIndex((item) => item.id === selectedId);
  const selected: ReaderItem | undefined = visible[selectedIndex];

  const save = useCallback(
    (next: { state: ReaderState; watermarkCount?: number }) => {
      actions.setReaderState(threadId, next.state);
      if (next.watermarkCount != null && next.watermarkCount > watermark + 1)
        actions.markThreadRead(threadId, next.watermarkCount);
    },
    [actions, threadId, watermark],
  );

  // Opening an item, or a new reply arriving while it is open, reads it.
  useEffect(() => {
    if (!selected || isItemRead(selected, watermark, state)) return;
    save(markItemRead(items, selected, watermark, state));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.lastId]);

  const open = (index: number | undefined) => {
    if (index == null) return;
    setSelectedId(visible[index]?.id);
    listRef.current
      ?.querySelector(`[data-reader-item="${visible[index]?.id}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  };
  const archive = (item: ReaderItem) => {
    const archived = !isItemArchived(item, state);
    save({ state: setItemArchived(item, archived, state) });
    if (archived && !showArchived && item.id === selectedId) {
      const next =
        findItem(visible, selectedIndex, 1) ??
        findItem(visible, selectedIndex, -1);
      setSelectedId(next == null ? undefined : visible[next].id);
    }
  };
  const markUnread = (item: ReaderItem) =>
    save({ state: markItemUnread(item, state) });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest?.("input, textarea, [contenteditable=true]")) return;
    const handled = (() => {
      switch (event.key) {
        case "j":
          open(findItem(visible, selectedIndex, 1));
          return true;
        case "k":
          open(
            findItem(
              visible,
              selectedIndex < 0 ? visible.length : selectedIndex,
              -1,
            ),
          );
          return true;
        case "u":
          open(
            findItem(
              visible,
              selectedIndex,
              1,
              (item) => !isItemRead(item, watermark, state),
            ),
          );
          return true;
        case "y":
          if (selected) archive(selected);
          return !!selected;
        case "m":
          if (selected) markUnread(selected);
          return !!selected;
      }
      return false;
    })();
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  // New items wait behind a button instead of moving the list.
  const listRef = useRef<HTMLDivElement>(null);
  const [seenCount, setSeenCount] = useState(visible.length);
  useEffect(() => {
    const list = listRef.current;
    if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 8)
      setSeenCount(visible.length);
    else if (visible.length < seenCount) setSeenCount(visible.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length]);
  const newCount = Math.max(0, visible.length - seenCount);
  const onListScroll = () => {
    const list = listRef.current;
    if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 8)
      setSeenCount(visible.length);
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
        onScroll={onListScroll}
        style={{ overflowY: "auto", flex: 1, minHeight: 0 }}
      >
        {visible.length === 0 ? (
          <Empty
            style={{ marginTop: 40 }}
            description={
              items.length ? "Everything here is archived" : "No messages yet"
            }
          />
        ) : null}
        {visible.map((item) => {
          const read = isItemRead(item, watermark, state);
          const first = item.messages[0];
          const date = dateValue(item.messages[item.messages.length - 1]);
          const replies = item.messages.length - 1;
          return (
            <div
              key={item.id}
              data-reader-item={item.id}
              role="option"
              aria-selected={item.id === selectedId}
              onClick={() => setSelectedId(item.id)}
              style={{
                padding: "8px 12px",
                cursor: "pointer",
                borderBottom: `1px solid ${UI_COLORS.border}`,
                background:
                  item.id === selectedId ? UI_COLORS.selected : undefined,
                fontWeight: read ? undefined : 600,
                opacity: isItemArchived(item, state) ? 0.6 : undefined,
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
                {replies > 0
                  ? `(${replies} ${replies === 1 ? "reply" : "replies"}) `
                  : ""}
                {snippet(first)}
              </div>
            </div>
          );
        })}
      </div>
      {newCount > 0 ? (
        <Button
          size="small"
          shape="round"
          type="primary"
          style={{
            position: "absolute",
            bottom: 12,
            left: "50%",
            transform: "translateX(-50%)",
          }}
          onClick={() => {
            const list = listRef.current;
            list?.scrollTo?.({ top: list.scrollHeight });
            setSeenCount(visible.length);
          }}
        >
          {newCount} new
        </Button>
      ) : null}
    </div>
  );

  const pane = selected ? (
    <div
      role="article"
      aria-label="Message"
      style={{
        flex: 1,
        minWidth: 0,
        overflowY: "auto",
        padding: "8px 16px 24px",
      }}
    >
      <Space wrap style={{ marginBottom: 8 }}>
        {narrow ? (
          <Button size="small" onClick={() => setSelectedId(undefined)}>
            <Icon name="arrow-left" /> All messages
          </Button>
        ) : null}
        <Button
          size="small"
          disabled={findItem(visible, selectedIndex, -1) == null}
          onClick={() => open(findItem(visible, selectedIndex, -1))}
        >
          Previous
        </Button>
        <Button
          size="small"
          disabled={findItem(visible, selectedIndex, 1) == null}
          onClick={() => open(findItem(visible, selectedIndex, 1))}
        >
          Next
        </Button>
        <Button size="small" onClick={() => archive(selected)}>
          {isItemArchived(selected, state) ? "Move to inbox" : "Archive"}
        </Button>
        <Button size="small" onClick={() => markUnread(selected)}>
          Mark unread
        </Button>
        {onShowInChat ? (
          <Button
            size="small"
            type="link"
            onClick={() => {
              const date = dateValue(selected.messages[0]);
              if (date) onShowInChat(date);
            }}
          >
            Show in chat
          </Button>
        ) : null}
      </Space>
      {selected.messages.map((message) => {
        const date = dateValue(message);
        return (
          <div key={`${date?.valueOf()}`} style={{ marginBottom: 20 }}>
            <div style={{ color: UI_COLORS.muted, marginBottom: 4 }}>
              <b style={{ color: UI_COLORS.text }}>
                {readerSender(message, userMap)}
              </b>
              {date ? (
                <>
                  {" · "}
                  <TimeAgo date={date} />
                </>
              ) : null}
            </div>
            <StaticMarkdown
              value={`${newest_content(message) ?? ""}`}
              style={{ fontSize: `${fontSize ?? 14}px` }}
            />
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
      tabIndex={0}
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
        <span>{unread ? `${unread} unread` : "All read"}</span>
        <Button
          size="small"
          disabled={!unread}
          onClick={() => save(markAllRead(items, state))}
        >
          Mark all read
        </Button>
        <Checkbox
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        >
          Show archived
        </Checkbox>
        <Tooltip title="j/k: next and previous · u: next unread · y: archive · m: mark unread">
          <span style={{ color: UI_COLORS.muted, fontSize: 12 }}>
            <Icon name="keyboard" /> Keys
          </span>
        </Tooltip>
      </div>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {narrow && selected ? null : list}
        {pane}
      </div>
    </div>
  );
}
