import type { CodexThreadConfig } from "./acp";

export const CHAT_SCHEMA_V2 = 2;

export interface MessageHistory {
  author_id: string;
  content: string;
  date: string;
}

export interface ChatMessage {
  event: "chat";
  sender_id: string;
  history: MessageHistory[];
  date: Date | string;
  schema_version?: number;
  reply_to?: string;
  generating?: boolean;
  editing?: string[];
  folding?: string[];
  feedback?: Record<string, unknown>;
  acp_events?: any[];
  acp_log_store?: string | null;
  acp_log_key?: string | null;
  acp_log_thread?: string | null;
  acp_log_turn?: string | null;
  acp_log_subject?: string | null;
  acp_thread_id?: string | null;
  acp_usage?: any;
  acp_config?: CodexThreadConfig;
  acp_account_id?: string;
  // schema-v2 fields (optional while migrating)
  message_id?: string;
  thread_id?: string;
  reply_to_message_id?: string;
}

export interface HistoryEntryInput {
  author_id: string;
  content: string;
  date?: string;
}

export function addToHistory(
  history: MessageHistory[] = [],
  entry: HistoryEntryInput,
): MessageHistory[] {
  const timestamp = entry.date ?? new Date().toISOString();
  const next: MessageHistory = {
    author_id: entry.author_id,
    content: entry.content,
    date: timestamp,
  };
  return [next, ...(history ?? [])];
}

export interface BuildChatMessageOptions {
  sender_id: string;
  date: Date | string;
  prevHistory: MessageHistory[] | undefined;
  content: string;
  generating: boolean;
  schema_version?: number;
  reply_to?: string;
  acp_events?: any[];
  acp_thread_id?: string | null;
  acp_usage?: any;
  historyAuthorId?: string;
  historyEntryDate?: string;
  acp_account_id?: string;
  message_id?: string;
  thread_id?: string;
  reply_to_message_id?: string;
}

export function buildChatMessage(
  options: BuildChatMessageOptions,
): ChatMessage {
  const history = addToHistory(options.prevHistory ?? [], {
    author_id: options.historyAuthorId ?? options.sender_id,
    content: options.content,
    date: options.historyEntryDate,
  });

  const messageDate =
    options.date instanceof Date ? options.date : new Date(options.date);

  return {
    event: "chat",
    sender_id: options.sender_id,
    date: messageDate.toISOString(),
    history,
    generating: options.generating,
    reply_to: options.reply_to,
    schema_version: options.schema_version,
    acp_events: options.acp_events,
    acp_thread_id: options.acp_thread_id,
    acp_usage: options.acp_usage,
    acp_account_id: options.acp_account_id,
    message_id: options.message_id,
    thread_id: options.thread_id,
    reply_to_message_id: options.reply_to_message_id,
  };
}

function toISOStringDate(value?: Date | string): string {
  if (value == null) {
    return new Date().toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  return value.toISOString();
}

export interface ChatThreadRecord {
  event: "chat-thread";
  thread_id: string;
  root_message_id: string;
  created_at: string;
  created_by: string;
  schema_version: number;
}

export interface BuildThreadRecordOptions {
  thread_id: string;
  root_message_id: string;
  created_by: string;
  created_at?: Date | string;
  schema_version?: number;
}

export function buildThreadRecord(
  options: BuildThreadRecordOptions,
): ChatThreadRecord {
  return {
    event: "chat-thread",
    thread_id: options.thread_id,
    root_message_id: options.root_message_id,
    created_by: options.created_by,
    created_at: toISOStringDate(options.created_at),
    schema_version: options.schema_version ?? CHAT_SCHEMA_V2,
  };
}

export interface ChatThreadConfigRecord {
  event: "chat-thread-config";
  thread_id: string;
  name?: string;
  thread_color?: string;
  thread_icon?: string;
  thread_image?: string;
  pin?: boolean;
  acp_config?: CodexThreadConfig;
  updated_at: string;
  updated_by: string;
  schema_version: number;
}

export interface BuildThreadConfigRecordOptions {
  thread_id: string;
  updated_by: string;
  updated_at?: Date | string;
  name?: string;
  thread_color?: string;
  thread_icon?: string;
  thread_image?: string;
  pin?: boolean;
  acp_config?: CodexThreadConfig;
  schema_version?: number;
}

export function buildThreadConfigRecord(
  options: BuildThreadConfigRecordOptions,
): ChatThreadConfigRecord {
  return {
    event: "chat-thread-config",
    thread_id: options.thread_id,
    name: options.name,
    thread_color: options.thread_color,
    thread_icon: options.thread_icon,
    thread_image: options.thread_image,
    pin: options.pin,
    acp_config: options.acp_config,
    updated_at: toISOStringDate(options.updated_at),
    updated_by: options.updated_by,
    schema_version: options.schema_version ?? CHAT_SCHEMA_V2,
  };
}

export interface ChatMessageRecordV2 extends ChatMessage {
  event: "chat";
  message_id: string;
  thread_id: string;
  schema_version: number;
}

export interface BuildChatMessageRecordV2Options
  extends Omit<BuildChatMessageOptions, "schema_version"> {
  message_id: string;
  thread_id: string;
  schema_version?: number;
}

export function buildChatMessageRecordV2(
  options: BuildChatMessageRecordV2Options,
): ChatMessageRecordV2 {
  return buildChatMessage({
    ...options,
    schema_version: options.schema_version ?? CHAT_SCHEMA_V2,
  }) as ChatMessageRecordV2;
}

export type ChatThreadRuntimeState =
  | "idle"
  | "queued"
  | "running"
  | "interrupted"
  | "error"
  | "complete";

export interface ChatThreadStateRecord {
  event: "chat-thread-state";
  thread_id: string;
  state: ChatThreadRuntimeState;
  active_message_id?: string;
  updated_at: string;
  schema_version: number;
}

export interface BuildThreadStateRecordOptions {
  thread_id: string;
  state: ChatThreadRuntimeState;
  active_message_id?: string;
  updated_at?: Date | string;
  schema_version?: number;
}

export function buildThreadStateRecord(
  options: BuildThreadStateRecordOptions,
): ChatThreadStateRecord {
  return {
    event: "chat-thread-state",
    thread_id: options.thread_id,
    state: options.state,
    active_message_id: options.active_message_id,
    updated_at: toISOStringDate(options.updated_at),
    schema_version: options.schema_version ?? CHAT_SCHEMA_V2,
  };
}

export * from "./acp";
export * from "./acp-log";
export * from "./integrity";
