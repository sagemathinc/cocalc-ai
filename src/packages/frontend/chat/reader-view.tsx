/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The reader view: one thread as an inbox. A list of items (each incoming
// message with the agent replies that follow it), unread ones in bold, and a
// reading pane. Opening an item marks it read; y archives it, m marks it
// unread again; j and k move, u goes to the next unread one. The list never
// scrolls by itself: new items wait behind an "N new" button.

import { Badge, Button, Checkbox, Empty, Modal, Space } from "antd";
import type { KeyboardEvent } from "react";
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

export function ChatReaderView({
  actions,
  threadId,
  messages,
  accountId,
  readStateVersion,
  projectId,
  path,
  fontSize,
  narrow,
  autoFocus,
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
  fontSize?: number;
  /** Show the list or the open item, not both side by side. */
  narrow?: boolean;
  /** Move the keyboard focus into the list when it appears. */
  autoFocus?: boolean;
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
  const [showKeys, setShowKeys] = useState(false);
  // Newest first, as in an inbox: j goes down the list, to older items.
  const visible = useMemo(
    () =>
      (showArchived
        ? items
        : items.filter((item) => !isItemArchived(item, state))
      )
        .slice()
        .reverse(),
    [items, state, showArchived],
  );
  // Counted over every item, as Mark all read reads every item; archived
  // ones are named apart while hidden.
  const unread = useMemo(
    () => items.filter((item) => !isItemRead(item, watermark, state)).length,
    [items, watermark, state],
  );
  const hiddenUnread = useMemo(
    () =>
      showArchived
        ? 0
        : items.filter(
            (item) =>
              isItemArchived(item, state) &&
              !isItemRead(item, watermark, state),
          ).length,
    [items, watermark, state, showArchived],
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
    if (!narrow || startedRef.current === threadId || !visible.length) return;
    startedRef.current = threadId;
    if (selectedId) return;
    const first =
      visible.find((item) => !isItemRead(item, watermark, state)) ?? visible[0];
    setSelectedId(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow, threadId, visible.length]);

  // Opening an item, or a new reply arriving while it is open, reads it.
  useEffect(() => {
    if (!selected || isItemRead(selected, watermark, state)) return;
    save((current, watermark) =>
      markItemRead(items, selected, watermark, current),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.lastId]);

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
  // Another thread, or archived shown or hidden: nothing there is new.
  const context = `${threadId}\0${showArchived}`;
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
        overflowY: "auto",
        padding: narrow ? "8px 12px 24px" : "8px 16px 24px",
      }}
    >
      {narrow ? null : (
        <Space wrap style={{ marginBottom: 8 }}>
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
      {selected.messages.map((message) => {
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
              disabled={!projectId || !path || !value.trim()}
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
