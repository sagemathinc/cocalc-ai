export interface ChatIntegrityCounters {
  orphan_messages: number;
  duplicate_root_messages: number;
  missing_thread_config: number;
  invalid_reply_targets: number;
}

export interface ChatIntegrityExamples {
  orphan_message_ids: string[];
  duplicate_root_thread_ids: string[];
  missing_thread_config_thread_ids: string[];
  invalid_reply_message_ids: string[];
}

export interface ChatIntegrityReport {
  total_messages: number;
  total_threads: number;
  total_thread_configs: number;
  counters: ChatIntegrityCounters;
  examples: ChatIntegrityExamples;
}

interface NormalizedMessage {
  message_id: string;
  thread_id: string;
  date_iso?: string;
  sender_id?: string;
  reply_to?: string;
  reply_to_message_id?: string;
  acp_config?: any;
  is_root: boolean;
}

function normalizeDate(value: unknown): string | undefined {
  if (value == null) return undefined;
  const d = value instanceof Date ? value : new Date(value as any);
  if (!Number.isFinite(d.valueOf())) return undefined;
  return d.toISOString();
}

function toJs(value: any): any {
  return value && typeof value.toJS === "function" ? value.toJS() : value;
}

function threadIdFromDates(replyTo?: string, dateIso?: string): string | undefined {
  if (replyTo) {
    const ms = new Date(replyTo).valueOf();
    if (Number.isFinite(ms)) return `legacy-thread-${ms}`;
  }
  if (dateIso) {
    const ms = new Date(dateIso).valueOf();
    if (Number.isFinite(ms)) return `legacy-thread-${ms}`;
  }
  return undefined;
}

function isCodexConfig(config: any): boolean {
  const cfg = toJs(config);
  if (!cfg || typeof cfg !== "object") return false;
  const model = cfg.model;
  if (typeof model === "string" && model.toLowerCase().includes("codex")) {
    return true;
  }
  const sessionId = cfg.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0;
}

function pushExample(target: string[], value: string, maxExamples = 8): void {
  if (!value || target.length >= maxExamples || target.includes(value)) return;
  target.push(value);
}

export function computeChatIntegrityReport(
  rows: any[] | undefined,
): ChatIntegrityReport {
  const counters: ChatIntegrityCounters = {
    orphan_messages: 0,
    duplicate_root_messages: 0,
    missing_thread_config: 0,
    invalid_reply_targets: 0,
  };
  const examples: ChatIntegrityExamples = {
    orphan_message_ids: [],
    duplicate_root_thread_ids: [],
    missing_thread_config_thread_ids: [],
    invalid_reply_message_ids: [],
  };
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      total_messages: 0,
      total_threads: 0,
      total_thread_configs: 0,
      counters,
      examples,
    };
  }

  const messages: NormalizedMessage[] = [];
  const messageById = new Map<string, NormalizedMessage>();
  const messageByDateIso = new Map<string, NormalizedMessage>();
  const threadConfigByThreadId = new Set<string>();
  const threadConfigByDateIso = new Set<string>();

  for (const row of rows) {
    const event = row?.event;
    if (event === "chat-thread-config") {
      const threadId = row?.thread_id;
      if (typeof threadId === "string" && threadId.length > 0) {
        threadConfigByThreadId.add(threadId);
      }
      const dateIso = normalizeDate(row?.date);
      if (dateIso) {
        threadConfigByDateIso.add(dateIso);
      }
      continue;
    }
    if (event !== "chat") continue;

    const dateIso = normalizeDate(row?.date);
    const replyTo = normalizeDate(row?.reply_to);
    const fallbackThreadId = threadIdFromDates(replyTo, dateIso);
    const messageId =
      (typeof row?.message_id === "string" && row.message_id.length > 0
        ? row.message_id
        : undefined) ??
      (dateIso
        ? `legacy-message-${new Date(dateIso).valueOf()}-${row?.sender_id ?? "unknown"}`
        : undefined);
    const threadId =
      (typeof row?.thread_id === "string" && row.thread_id.length > 0
        ? row.thread_id
        : undefined) ?? fallbackThreadId;
    if (!messageId || !threadId) continue;

    const message: NormalizedMessage = {
      message_id: messageId,
      thread_id: threadId,
      date_iso: dateIso,
      sender_id: row?.sender_id,
      reply_to: replyTo,
      reply_to_message_id:
        typeof row?.reply_to_message_id === "string"
          ? row.reply_to_message_id
          : undefined,
      acp_config: toJs(row?.acp_config),
      is_root: !replyTo && !row?.reply_to_message_id,
    };
    messages.push(message);
    messageById.set(message.message_id, message);
    if (dateIso) {
      messageByDateIso.set(dateIso, message);
    }
  }

  const rootCountByThread = new Map<string, number>();
  const rootByThread = new Map<string, NormalizedMessage>();
  for (const message of messages) {
    if (!message.is_root) continue;
    const next = (rootCountByThread.get(message.thread_id) ?? 0) + 1;
    rootCountByThread.set(message.thread_id, next);
    if (!rootByThread.has(message.thread_id)) {
      rootByThread.set(message.thread_id, message);
    }
  }

  for (const [threadId, count] of rootCountByThread.entries()) {
    if (count > 1) {
      counters.duplicate_root_messages += count - 1;
      pushExample(examples.duplicate_root_thread_ids, threadId);
    }
  }

  for (const message of messages) {
    if (message.reply_to_message_id) {
      if (!messageById.has(message.reply_to_message_id)) {
        counters.invalid_reply_targets += 1;
        pushExample(examples.invalid_reply_message_ids, message.message_id);
      }
    } else if (message.reply_to) {
      if (!messageByDateIso.has(message.reply_to)) {
        counters.invalid_reply_targets += 1;
        pushExample(examples.invalid_reply_message_ids, message.message_id);
      }
    }
    if (!message.is_root && !rootByThread.has(message.thread_id)) {
      counters.orphan_messages += 1;
      pushExample(examples.orphan_message_ids, message.message_id);
    }
  }

  for (const [threadId, root] of rootByThread.entries()) {
    if (!isCodexConfig(root.acp_config)) continue;
    const hasThreadConfigById = threadConfigByThreadId.has(threadId);
    const hasThreadConfigByDate =
      root.date_iso != null && threadConfigByDateIso.has(root.date_iso);
    if (!hasThreadConfigById && !hasThreadConfigByDate) {
      counters.missing_thread_config += 1;
      pushExample(examples.missing_thread_config_thread_ids, threadId);
    }
  }

  return {
    total_messages: messages.length,
    total_threads: rootCountByThread.size,
    total_thread_configs: threadConfigByThreadId.size + threadConfigByDateIso.size,
    counters,
    examples,
  };
}
