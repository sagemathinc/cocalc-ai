/*
Used for viewing a list of messages, e.g., in timetravel.
*/

import { useEffect, useMemo, useState } from "react";

import type { Document } from "@cocalc/sync/editor/generic/types";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { COLORS } from "@cocalc/util/theme";
import { MessageList, getSortedDates } from "./chat-log";
import type { ChatMessageTyped, ChatMessages } from "./types";
import { firstHistory, historyArray, parentMessageId } from "./access";

interface ChatViewerThread {
  key: string;
  label: string;
  newestTime: number;
  messageCount: number;
}

interface ChatViewerModel {
  messages: ChatMessages;
  threads: ChatViewerThread[];
}

function rowValue(row: any, field: string) {
  return row?.[field] ?? row?.get?.(field);
}

function normalizeRow(row: any): Record<string, any> {
  return typeof row?.toJS === "function" ? row.toJS() : row;
}

function messageThreadId(message: ChatMessageTyped): string {
  return `${message.thread_id ?? ""}`.trim();
}

function messageLabel(message?: ChatMessageTyped): string {
  const content = firstHistory(message)?.content?.replace(/\s+/g, " ").trim();
  if (!content) return "Untitled Thread";
  const words = content.split(" ");
  const short = words.slice(0, 8).join(" ");
  return words.length > 8 ? `${short}…` : short;
}

export function createChatViewerModel(
  doc: Document | undefined,
): ChatViewerModel {
  const messages = new Map<string, any>();
  const threadConfigNames = new Map<string, string>();
  if (doc == null) {
    return { messages: messages as unknown as ChatMessages, threads: [] };
  }
  for (const v of doc.get()) {
    const row = normalizeRow(v);
    const event = rowValue(row, "event");
    if (event === "chat-thread-config") {
      const threadId = `${rowValue(row, "thread_id") ?? ""}`.trim();
      const name = `${rowValue(row, "name") ?? ""}`.trim();
      if (threadId && name) {
        threadConfigNames.set(threadId, name);
      }
      continue;
    }
    if (event !== "chat") continue;
    const rawDate = rowValue(row, "date");
    const date = rawDate instanceof Date ? rawDate : new Date(rawDate);
    if (Number.isNaN(date.valueOf())) continue;
    const rawHistory = rowValue(row, "history");
    const msg = {
      ...row,
      date,
      history: historyArray({ history: rawHistory }),
    };
    messages.set(`${date.valueOf()}`, msg);
  }

  const threadMap = new Map<
    string,
    {
      key: string;
      newestTime: number;
      messageCount: number;
      rootMessage?: ChatMessageTyped;
    }
  >();
  for (const message of messages.values()) {
    const threadId = messageThreadId(message);
    if (!threadId) continue;
    let thread = threadMap.get(threadId);
    if (thread == null) {
      thread = {
        key: threadId,
        newestTime: 0,
        messageCount: 0,
      };
      threadMap.set(threadId, thread);
    }
    thread.messageCount += 1;
    const time = message.date.valueOf();
    if (time > thread.newestTime) {
      thread.newestTime = time;
    }
    if (!parentMessageId(message)) {
      thread.rootMessage = message;
    }
  }
  for (const [threadId] of threadConfigNames) {
    if (!threadMap.has(threadId)) {
      threadMap.set(threadId, {
        key: threadId,
        newestTime: 0,
        messageCount: 0,
      });
    }
  }
  const threads = Array.from(threadMap.values())
    .map((thread) => ({
      ...thread,
      label:
        threadConfigNames.get(thread.key) ?? messageLabel(thread.rootMessage),
    }))
    .sort((a, b) => b.newestTime - a.newestTime);

  return { messages: messages as unknown as ChatMessages, threads };
}

function messagesInThread(
  messages: ChatMessages,
  selectedThreadKey?: string,
): ChatMessages {
  if (!selectedThreadKey) return messages;
  const selected = new Map<string, ChatMessageTyped>();
  for (const [key, message] of messages.entries()) {
    if (messageThreadId(message) === selectedThreadKey) {
      selected.set(key, message);
    }
  }
  return selected as unknown as ChatMessages;
}

export default function Viewer({
  doc,
  font_size,
  readOnly = false,
  virtualized = true,
  showThreadList = false,
}: {
  doc: () => Document | undefined;
  font_size?: number;
  readOnly?: boolean;
  virtualized?: boolean;
  showThreadList?: boolean;
}) {
  const { messages, threads } = useMemo(() => {
    return createChatViewerModel(doc());
  }, [doc]);
  const [selectedThreadKey, setSelectedThreadKey] = useState<
    string | undefined
  >();
  useEffect(() => {
    if (!showThreadList || threads.length === 0) {
      setSelectedThreadKey(undefined);
      return;
    }
    if (selectedThreadKey && threads.some((x) => x.key === selectedThreadKey)) {
      return;
    }
    setSelectedThreadKey(threads[0].key);
  }, [showThreadList, selectedThreadKey, threads]);

  const user_map = useTypedRedux("users", "user_map");
  const account_id = useTypedRedux("account", "account_id");
  const visibleMessages =
    showThreadList && threads.length > 1
      ? messagesInThread(messages, selectedThreadKey ?? threads[0]?.key)
      : messages;
  const { dates: sortedDates, numChildren } = useMemo(() => {
    return getSortedDates(visibleMessages, account_id);
  }, [visibleMessages, account_id]);

  const messageList = (
    <MessageList
      messages={visibleMessages}
      user_map={user_map}
      account_id={account_id}
      fontSize={font_size}
      mode="standalone"
      sortedDates={sortedDates}
      numChildren={numChildren}
      readOnly={readOnly}
      virtualized={virtualized}
    />
  );

  if (!showThreadList || threads.length <= 1) {
    return messageList;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: "1 1 auto",
        minHeight: 0,
        height: "100%",
      }}
    >
      <div
        style={{
          alignItems: "center",
          background: COLORS.GRAY_LLL,
          borderBottom: `1px solid ${COLORS.GRAY_L}`,
          display: "flex",
          flex: "0 0 auto",
          gap: "8px",
          padding: "8px 12px",
        }}
      >
        <div
          style={{
            color: COLORS.GRAY_D,
            fontSize: "12px",
            fontWeight: 600,
            flex: "0 0 auto",
            textTransform: "uppercase",
          }}
        >
          Threads
        </div>
        <select
          value={selectedThreadKey ?? threads[0].key}
          onChange={(event) => setSelectedThreadKey(event.target.value)}
          style={{
            border: `1px solid ${COLORS.GRAY_L}`,
            borderRadius: "6px",
            color: COLORS.GRAY_DD,
            flex: "1 1 auto",
            maxWidth: "520px",
            minWidth: 0,
            padding: "4px 8px",
          }}
        >
          {threads.map((thread) => (
            <option key={thread.key} value={thread.key}>
              {thread.label} ({thread.messageCount})
            </option>
          ))}
        </select>
      </div>
      <div style={{ flex: "1 1 0", minWidth: 0, minHeight: 0 }}>
        {messageList}
      </div>
    </div>
  );
}
