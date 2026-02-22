import { CHAT_SCHEMA_V2, computeChatIntegrityReport } from ".";

type AnyRow = Record<string, any>;

const THREAD_EVENT = "chat-thread";
const THREAD_CONFIG_EVENT = "chat-thread-config";
const THREAD_STATE_EVENT = "chat-thread-state";
const THREAD_SENDER = "__thread__";
const THREAD_CONFIG_SENDER = "__thread_config__";
const THREAD_STATE_SENDER = "__thread_state__";

export interface MigrationOptions {
  keepLegacyThreadFields?: boolean;
  nowIso?: string;
}

export interface MigrationReport {
  input_rows: number;
  output_rows: number;
  chat_rows_migrated: number;
  thread_records_created: number;
  thread_config_records_created: number;
  thread_state_records_created: number;
  generated_message_ids: number;
  generated_thread_ids: number;
  fixed_reply_to_message_ids: number;
  duplicate_message_ids_resolved: number;
  synthetic_roots_created: number;
  invalid_chat_rows_skipped: number;
  integrity_after: ReturnType<typeof computeChatIntegrityReport>["counters"];
}

interface MigratedMessage {
  row: AnyRow;
  dateIso: string;
  dateMs: number;
  rootIso: string;
  senderId: string;
  messageId: string;
  threadId: string;
  explicitRoot: boolean;
}

function toIso(value: unknown): string | undefined {
  if (value == null) return undefined;
  const d = value instanceof Date ? value : new Date(value as any);
  const ms = d.valueOf();
  if (!Number.isFinite(ms)) return undefined;
  return d.toISOString();
}

function toMs(iso: string): number {
  return new Date(iso).valueOf();
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function makeUniqueId(base: string, used: Set<string>): { id: string; bumped: boolean } {
  if (!used.has(base)) {
    used.add(base);
    return { id: base, bumped: false };
  }
  let n = 2;
  while (used.has(`${base}-dup${n}`)) {
    n += 1;
  }
  const id = `${base}-dup${n}`;
  used.add(id);
  return { id, bumped: true };
}

function normalizePin(value: unknown): boolean | undefined {
  if (value == null) return undefined;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return undefined;
}

function dedupeByPrimaryKey(rows: AnyRow[]): AnyRow[] {
  const keyToRow = new Map<string, AnyRow>();
  const order: string[] = [];
  for (const row of rows) {
    const event = `${row?.event ?? ""}`;
    const sender = `${row?.sender_id ?? ""}`;
    const date = `${toIso(row?.date) ?? row?.date ?? ""}`;
    const key = `${event}\u0000${sender}\u0000${date}`;
    if (!keyToRow.has(key)) {
      order.push(key);
    }
    keyToRow.set(key, row);
  }
  return order.map((key) => keyToRow.get(key)!);
}

function normalizeRows(
  rows: AnyRow[],
  report: Omit<MigrationReport, "input_rows" | "output_rows" | "integrity_after">,
): {
  messages: MigratedMessage[];
  passthroughRows: AnyRow[];
} {
  const rootIsoToThreadId = new Map<string, string>();
  const usedMessageIds = new Set<string>();
  const msgCounterByDateSender = new Map<string, number>();
  const messages: MigratedMessage[] = [];
  const passthroughRows: AnyRow[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const event = row.event;
    if (event === THREAD_EVENT || event === THREAD_CONFIG_EVENT || event === THREAD_STATE_EVENT) {
      // Rebuild these records from canonical migrated messages.
      continue;
    }
    if (event !== "chat") {
      passthroughRows.push(row);
      continue;
    }
    const dateIso = toIso(row.date);
    if (!dateIso) {
      report.invalid_chat_rows_skipped += 1;
      continue;
    }
    const dateMs = toMs(dateIso);
    const senderId =
      typeof row.sender_id === "string" && row.sender_id.length > 0
        ? row.sender_id
        : "__unknown__";
    const replyToIso = toIso(row.reply_to);
    const rootIso = replyToIso ?? dateIso;
    const rootMs = toMs(rootIso);

    let threadId =
      typeof row.thread_id === "string" && row.thread_id.length > 0
        ? row.thread_id
        : undefined;
    if (!threadId) {
      threadId = rootIsoToThreadId.get(rootIso) ?? `legacy-thread-${rootMs}`;
      report.generated_thread_ids += 1;
    }
    if (!rootIsoToThreadId.has(rootIso)) {
      rootIsoToThreadId.set(rootIso, threadId);
    } else {
      threadId = rootIsoToThreadId.get(rootIso)!;
    }

    let messageId =
      typeof row.message_id === "string" && row.message_id.length > 0
        ? row.message_id
        : undefined;
    if (!messageId) {
      const key = `${dateIso}\u0000${senderId}`;
      const occurrence = msgCounterByDateSender.get(key) ?? 0;
      msgCounterByDateSender.set(key, occurrence + 1);
      const suffix = occurrence === 0 ? "" : `-${occurrence}`;
      messageId = `legacy-message-${dateMs}-${sanitizeIdPart(senderId)}${suffix}`;
      report.generated_message_ids += 1;
    }
    const unique = makeUniqueId(messageId, usedMessageIds);
    if (unique.bumped) {
      report.duplicate_message_ids_resolved += 1;
    }
    messageId = unique.id;

    const normalized: AnyRow = {
      ...row,
      event: "chat",
      sender_id: senderId,
      date: dateIso,
      reply_to: replyToIso ?? undefined,
      message_id: messageId,
      thread_id: threadId,
      schema_version: CHAT_SCHEMA_V2,
    };
    if (!Array.isArray(normalized.history)) {
      normalized.history = [];
    }
    messages.push({
      row: normalized,
      dateIso,
      dateMs,
      rootIso,
      senderId,
      messageId,
      threadId,
      explicitRoot: replyToIso == null,
    });
  }

  return { messages, passthroughRows };
}

export function migrateChatRows(
  rows: AnyRow[],
  options: MigrationOptions = {},
): { rows: AnyRow[]; report: MigrationReport } {
  const reportBase = {
    chat_rows_migrated: 0,
    thread_records_created: 0,
    thread_config_records_created: 0,
    thread_state_records_created: 0,
    generated_message_ids: 0,
    generated_thread_ids: 0,
    fixed_reply_to_message_ids: 0,
    duplicate_message_ids_resolved: 0,
    synthetic_roots_created: 0,
    invalid_chat_rows_skipped: 0,
  };
  const { messages, passthroughRows } = normalizeRows(rows, reportBase);
  reportBase.chat_rows_migrated = messages.length;

  const keepLegacyThreadFields = options.keepLegacyThreadFields !== false;

  const byThread = new Map<string, MigratedMessage[]>();
  const byMessageId = new Map<string, MigratedMessage>();
  for (const msg of messages) {
    if (!byThread.has(msg.threadId)) byThread.set(msg.threadId, []);
    byThread.get(msg.threadId)!.push(msg);
    byMessageId.set(msg.messageId, msg);
  }

  for (const list of byThread.values()) {
    list.sort((a, b) => a.dateMs - b.dateMs || a.messageId.localeCompare(b.messageId));
  }

  const threadRows: AnyRow[] = [];
  const threadConfigRows: AnyRow[] = [];
  const threadStateRows: AnyRow[] = [];

  for (const [threadId, threadMessages] of byThread.entries()) {
    const explicitRoots = threadMessages.filter((m) => m.explicitRoot);
    const root = explicitRoots[0] ?? threadMessages[0];
    if (!explicitRoots.length) {
      reportBase.synthetic_roots_created += 1;
    }

    for (const msg of threadMessages) {
      if (msg.messageId === root.messageId) {
        if (msg.row.reply_to_message_id != null) {
          delete msg.row.reply_to_message_id;
          reportBase.fixed_reply_to_message_ids += 1;
        }
        continue;
      }
      const current = msg.row.reply_to_message_id;
      if (current !== root.messageId) {
        msg.row.reply_to_message_id = root.messageId;
        reportBase.fixed_reply_to_message_ids += 1;
      }
    }

    threadRows.push({
      event: THREAD_EVENT,
      sender_id: THREAD_SENDER,
      date: root.dateIso,
      thread_id: threadId,
      root_message_id: root.messageId,
      created_at: root.dateIso,
      created_by: root.senderId,
      schema_version: CHAT_SCHEMA_V2,
    });
    reportBase.thread_records_created += 1;

    const source = root.row;
    const pin = normalizePin(source.pin);
    const threadCfg: AnyRow = {
      event: THREAD_CONFIG_EVENT,
      sender_id: THREAD_CONFIG_SENDER,
      date: root.dateIso,
      thread_id: threadId,
      updated_at: options.nowIso ?? root.dateIso,
      updated_by: root.senderId,
      schema_version: CHAT_SCHEMA_V2,
    };
    if (typeof source.name === "string" && source.name.trim()) threadCfg.name = source.name.trim();
    if (typeof source.thread_color === "string" && source.thread_color.trim()) {
      threadCfg.thread_color = source.thread_color.trim();
    }
    if (typeof source.thread_icon === "string" && source.thread_icon.trim()) {
      threadCfg.thread_icon = source.thread_icon.trim();
    }
    if (typeof source.thread_image === "string" && source.thread_image.trim()) {
      threadCfg.thread_image = source.thread_image.trim();
    }
    if (pin != null) threadCfg.pin = pin;
    if (source.acp_config != null) threadCfg.acp_config = source.acp_config;
    if (typeof source.agent_kind === "string" && source.agent_kind.trim()) {
      threadCfg.agent_kind = source.agent_kind.trim();
    }
    if (typeof source.agent_model === "string" && source.agent_model.trim()) {
      threadCfg.agent_model = source.agent_model.trim();
    }
    if (typeof source.agent_mode === "string" && source.agent_mode.trim()) {
      threadCfg.agent_mode = source.agent_mode.trim();
    }
    if (
      source.acp_config != null &&
      typeof source.acp_config?.model === "string" &&
      !threadCfg.agent_model
    ) {
      threadCfg.agent_kind = "acp";
      threadCfg.agent_model = source.acp_config.model;
      threadCfg.agent_mode = "interactive";
    }
    threadConfigRows.push(threadCfg);
    reportBase.thread_config_records_created += 1;

    const latest = threadMessages[threadMessages.length - 1];
    const hasGenerating = threadMessages.some((m) => m.row.generating === true);
    const state = hasGenerating
      ? "running"
      : latest.row?.acp_interrupted
        ? "interrupted"
        : "complete";
    threadStateRows.push({
      event: THREAD_STATE_EVENT,
      sender_id: THREAD_STATE_SENDER,
      date: root.dateIso,
      thread_id: threadId,
      state,
      active_message_id: hasGenerating ? latest.messageId : latest.messageId,
      updated_at: latest.dateIso,
      schema_version: CHAT_SCHEMA_V2,
    });
    reportBase.thread_state_records_created += 1;

    if (!keepLegacyThreadFields) {
      for (const key of [
        "name",
        "thread_color",
        "thread_icon",
        "thread_image",
        "pin",
        "agent_kind",
        "agent_model",
        "agent_mode",
        "acp_config",
      ]) {
        delete root.row[key];
      }
    }
  }

  const migratedChatRows = messages.map((m) => m.row);
  const deduped = dedupeByPrimaryKey([
    ...passthroughRows,
    ...migratedChatRows,
    ...threadRows,
    ...threadConfigRows,
    ...threadStateRows,
  ]);
  const integrityAfter = computeChatIntegrityReport(deduped).counters;
  const report: MigrationReport = {
    input_rows: rows.length,
    output_rows: deduped.length,
    ...reportBase,
    integrity_after: integrityAfter,
  };
  return { rows: deduped, report };
}

export function parseJsonLines(content: string): AnyRow[] {
  const rows: AnyRow[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(JSON.parse(trimmed));
  }
  return rows;
}

export function toJsonLines(rows: AnyRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}
