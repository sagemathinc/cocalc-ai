/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type {
  ChatMessage,
  ChatThreadConfigRecord,
  ChatThreadRecord,
  ChatThreadRuntimeState,
  ChatThreadStateRecord,
} from "@cocalc/chat";

import type { ProjectedChatMessage, ProjectedChatThread } from "./types";

function isoDate(value: unknown): string | undefined {
  const date = value instanceof Date ? value : new Date(`${value ?? ""}`);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}

function id(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

function messageRole(row: ChatMessage): ProjectedChatMessage["role"] {
  if (
    id(row.acp_account_id) ||
    id(row.acp_thread_id) ||
    id(row.acp_log_key) ||
    id(row.acp_log_subject)
  ) {
    return "agent";
  }
  return row.sender_id.startsWith("__") ? "system" : "human";
}

function messageState(
  row: Omit<ChatMessage, "acp_state"> & {
    acp_state?: unknown;
    acp_interrupted?: unknown;
  },
): ProjectedChatMessage["state"] {
  if (row.acp_interrupted === true) return "interrupted";
  if (row.acp_state === "queued" || row.acp_state === "queue") return "queued";
  if (row.acp_state === "running" || row.generating) return "running";
  if (row.acp_state === "not-sent") return "error";
  if (row.acp_state === "sending" || row.acp_state === "sent") {
    return "queued";
  }
  return row.generating === false ? "complete" : undefined;
}

function projectMessage(row: ChatMessage): ProjectedChatMessage | undefined {
  if (row.event !== "chat") return;
  const date = isoDate(row.date);
  if (!date) return;
  const message_id =
    id(row.message_id) ?? `legacy-message-${Date.parse(date)}-${row.sender_id}`;
  const thread_id = id(row.thread_id) ?? `legacy-thread-${Date.parse(date)}`;
  const history = Array.isArray(row.history) ? row.history : [];
  const latest = history[0];
  return {
    message_id,
    thread_id,
    parent_message_id: id(row.parent_message_id),
    sender_id: row.sender_id,
    role: messageRole(row),
    content: `${latest?.content ?? ""}`,
    date,
    revision_date: isoDate(latest?.date),
    generating: row.generating === true,
    state: messageState(row),
    acp_events: Array.isArray(row.acp_events) ? row.acp_events : undefined,
    acp_log_store: id(row.acp_log_store),
    acp_log_key: id(row.acp_log_key),
    acp_live_log_stream: id(row.acp_live_log_stream),
    acp_live_preview_stream: id(row.acp_live_preview_stream),
  };
}

export function projectChatRows(
  rows: readonly Record<string, any>[],
  selectedThreadId?: string,
): { threads: ProjectedChatThread[]; messages: ProjectedChatMessage[] } {
  const threadRows = new Map<string, ChatThreadRecord>();
  const configs = new Map<string, ChatThreadConfigRecord>();
  const states = new Map<string, ChatThreadStateRecord>();
  const messages = new Map<string, ProjectedChatMessage>();

  for (const row of rows) {
    const threadId = id(row.thread_id);
    if (row.event === "chat-thread" && threadId) {
      threadRows.set(threadId, row as ChatThreadRecord);
    } else if (row.event === "chat-thread-config" && threadId) {
      configs.set(threadId, row as ChatThreadConfigRecord);
    } else if (row.event === "chat-thread-state" && threadId) {
      states.set(threadId, row as ChatThreadStateRecord);
    } else if (row.event === "chat") {
      const message = projectMessage(row as ChatMessage);
      if (message) messages.set(message.message_id, message);
    }
  }

  const threadIds = new Set<string>([
    ...threadRows.keys(),
    ...configs.keys(),
    ...states.keys(),
    ...[...messages.values()].map((message) => message.thread_id),
  ]);
  const threads = [...threadIds].map((thread_id): ProjectedChatThread => {
    const thread = threadRows.get(thread_id);
    const config = configs.get(thread_id);
    const state = states.get(thread_id);
    return {
      thread_id,
      root_message_id: id(thread?.root_message_id),
      name: id(config?.name),
      agent_kind: config?.agent_kind,
      agent_model: id(config?.agent_model),
      acp_config: config?.acp_config,
      state: (state?.state ?? "idle") as ChatThreadRuntimeState,
      active_message_id: id(state?.active_message_id),
      updated_at: isoDate(state?.updated_at ?? config?.updated_at),
    };
  });
  threads.sort((a, b) =>
    `${b.updated_at ?? ""}`.localeCompare(`${a.updated_at ?? ""}`),
  );

  const selectedMessages = [...messages.values()].filter(
    (message) => !selectedThreadId || message.thread_id === selectedThreadId,
  );
  selectedMessages.sort((a, b) => {
    const dateOrder = a.date.localeCompare(b.date);
    return dateOrder || a.message_id.localeCompare(b.message_id);
  });
  return { threads, messages: selectedMessages };
}
