import { EventEmitter } from "events";
import { enableMapSet, produce } from "immer";
import { threadConfigRecordKey } from "@cocalc/chat";
import type { ImmerDB } from "@cocalc/sync/editor/immer-db";
import type { PlainChatMessage } from "./types";
import { dateValue, parentMessageId } from "./access";
import { once } from "@cocalc/util/async-utils";
import { normalizeChatMessage } from "./normalize";

/**
 * ChatMessageCache
 *
 * - Maintains a primary Map of chat messages keyed by message_id.
 * - Maintains a secondary Map of chat messages keyed by ms timestamp (as string)
 *   for compatibility while date-keyed callsites are migrated.
 * - Listens to syncdb "change" events to update incrementally; one cache per syncdoc.
 * - Emits a monotonically increasing version so React and Actions can subscribe
 *   without recomputing the whole document.
 * - Stored records are the same frozen objects that ImmerDB holds internally,
 *   so unchanged rows are structurally shared (no duplicate deep copies).
 *
 * This is the single source of truth for processed messages across both the
 * React components (via ChatDocProvider) and ChatActions; it avoids rebuilding
 * on every call and keeps O(1) updates relative to syncdb changes.
 */

// Enable Map mutation in immer drafts for efficient, immutable Map updates.
enableMapSet();

//const log = (...args) => console.log("message-cache", ...args);
const log = (..._args) => {};

export class ChatMessageCache extends EventEmitter {
  private syncdb: ImmerDB;
  private messagesById: Map<string, PlainChatMessage> = new Map();
  private messagesByDate: Map<string, PlainChatMessage> = new Map();
  private messageIdIndex: Map<string, string> = new Map();
  private dateIndex: Map<string, string> = new Map();
  private threadIndex: Map<string, ThreadIndexEntry> = new Map();
  private threadKeyByThreadId: Map<string, string> = new Map();
  private threadConfigByThreadId: Map<string, Record<string, unknown>> =
    new Map();
  private version = 0;

  constructor(syncdb: ImmerDB) {
    super();
    this.syncdb = syncdb;
    log("constructor");
    // Normalize initial Maps through produce so they are frozen consistently.
    this.messagesById = produce(this.messagesById, () => {});
    this.messagesByDate = produce(this.messagesByDate, () => {});
    this.syncdb.on("change", this.handleChange);
    if (
      this.syncdb.opts.ignoreInitialChanges ||
      this.syncdb.get_state() === "ready"
    ) {
      // If already ready (should never happen) *or* ignoreInitialChanges is set (should ALWAYS happen),
      // build immediately, which is vastly faster than churning through all changes.
      this.rebuildFromDoc();
    }
  }

  getSyncdb(): ImmerDB | undefined {
    return this.syncdb;
  }

  getMessages(): Map<string, PlainChatMessage> {
    return this.messagesByDate;
  }

  getMessagesById(): Map<string, PlainChatMessage> {
    return this.messagesById;
  }

  getThreadIndex(): Map<string, ThreadIndexEntry> {
    return this.threadIndex;
  }

  getMessageIdIndex(): Map<string, string> {
    return this.messageIdIndex;
  }

  getDateIndex(): Map<string, string> {
    return this.dateIndex;
  }

  getThreadKeyByThreadId(threadId?: string): string | undefined {
    if (!threadId) return;
    const trimmed = threadId.trim();
    if (!trimmed) return;
    return this.threadKeyByThreadId.get(trimmed);
  }

  getThreadConfigPreviewById(
    threadId?: string,
  ): Record<string, unknown> | undefined {
    if (!threadId) return;
    const trimmed = threadId.trim();
    if (!trimmed) return;
    return this.threadConfigByThreadId.get(trimmed);
  }

  listThreadConfigPreviewRows(): Record<string, unknown>[] {
    return Array.from(this.threadConfigByThreadId.values());
  }

  getByMessageId(messageId?: string): PlainChatMessage | undefined {
    if (!messageId) return;
    return this.messagesById.get(messageId);
  }

  getByDateKey(dateKey?: string): PlainChatMessage | undefined {
    if (!dateKey) return;
    return this.messagesByDate.get(dateKey);
  }

  getVersion(): number {
    return this.version;
  }

  dispose() {
    this.syncdb.off("change", this.handleChange);
    this.messagesById = new Map();
    this.messagesByDate = new Map();
    this.messageIdIndex = new Map();
    this.dateIndex = new Map();
    this.threadKeyByThreadId = new Map();
    this.threadConfigByThreadId = new Map();
    this.removeAllListeners();
  }

  private bumpVersion() {
    this.version += 1;
    this.emit("version", this.version);
  }

  private getDateKey(row?: { date?: unknown }): string | undefined {
    if (!row?.date) return;
    const raw = row.date;
    const date =
      raw instanceof Date ? raw : new Date(raw as string | number | Date);
    if (!Number.isFinite(date.valueOf())) return;
    return `${date.valueOf()}`;
  }

  private getThreadId(message: PlainChatMessage): string | undefined {
    const id = (message as any)?.thread_id;
    if (typeof id !== "string") return undefined;
    const trimmed = id.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private getThreadKeyForMap(message: PlainChatMessage): string | undefined {
    const threadId = this.getThreadId(message);
    return threadId;
  }

  private getMessageId(message?: PlainChatMessage): string | undefined {
    const id = (message as any)?.message_id;
    if (typeof id === "string" && id.length > 0) return id;
    return undefined;
  }

  private toArray<T>(value: T[] | { toJS?: () => T[] } | undefined): T[] {
    if (Array.isArray(value)) return value;
    if (typeof (value as any)?.toJS === "function") {
      return (value as any).toJS();
    }
    return [];
  }

  private threadConfigRank(row: Record<string, unknown>, threadId: string) {
    const canonical = threadConfigRecordKey(threadId);
    const isCanonical =
      row.sender_id === canonical.sender_id && row.date === canonical.date;
    const updatedAt = Date.parse(`${row.updated_at ?? ""}`);
    const rowDate = Date.parse(`${row.date ?? ""}`);
    return (
      (isCanonical ? 1_000_000_000_000_000 : 0) +
      (Number.isFinite(updatedAt) ? updatedAt : 0) +
      (Number.isFinite(rowDate) ? rowDate : 0)
    );
  }

  private pickPreferredThreadConfigRow(
    rows: unknown[],
    threadId: string,
  ): Record<string, unknown> | undefined {
    const normalized = `${threadId ?? ""}`.trim();
    if (!normalized) return undefined;
    let best: Record<string, unknown> | undefined;
    let bestRank = Number.NEGATIVE_INFINITY;
    for (const row0 of rows) {
      if ((row0 as any)?.event !== "chat-thread-config") continue;
      const row = row0 as Record<string, unknown>;
      const rank = this.threadConfigRank(row, normalized);
      if (best == null || rank > bestRank) {
        best = row;
        bestRank = rank;
      }
    }
    return best;
  }

  private getPreferredThreadConfigRowFromSyncdb(
    threadId: string,
  ): Record<string, unknown> | undefined {
    const normalized = `${threadId ?? ""}`.trim();
    if (!normalized || typeof this.syncdb?.get !== "function") return undefined;
    return this.pickPreferredThreadConfigRow(
      this.toArray(
        this.syncdb.get({
          event: "chat-thread-config",
          thread_id: normalized,
        }),
      ),
      normalized,
    );
  }

  private addToThreadIndex(
    draft: Map<string, ThreadIndexEntry>,
    message: PlainChatMessage,
    messageKey: string,
    threadKeyByThreadId: Map<string, string> = this.threadKeyByThreadId,
  ) {
    const threadKey = this.getThreadKeyForMap(message);
    if (!threadKey) return;
    let thread = draft.get(threadKey);
    if (!thread) {
      thread = {
        key: threadKey,
        newestTime: 0,
        messageCount: 0,
        messageKeys: new Set(),
        rootMessage: undefined,
      };
      draft.set(threadKey, thread);
    }
    thread.messageKeys.add(messageKey);
    thread.messageCount = thread.messageKeys.size;
    const d = dateValue(message);
    if (d && d.valueOf() > thread.newestTime) {
      thread.newestTime = d.valueOf();
    }
    if (!parentMessageId(message)) {
      thread.rootMessage = message;
      threadKeyByThreadId.set(threadKey, messageKey);
    }
  }

  private removeFromThreadIndex(
    draft: Map<string, ThreadIndexEntry>,
    message: PlainChatMessage,
    messageKey: string,
    messageMap: Map<string, PlainChatMessage>,
    threadKeyByThreadId: Map<string, string> = this.threadKeyByThreadId,
  ) {
    const threadKey = this.getThreadKeyForMap(message);
    if (!threadKey) return;
    const thread = draft.get(threadKey);
    if (!thread) return;
    thread.messageKeys.delete(messageKey);
    thread.messageCount = thread.messageKeys.size;
    if (
      !parentMessageId(message) &&
      thread.rootMessage?.date === message.date
    ) {
      thread.rootMessage = undefined;
      const threadId = this.getThreadId(message);
      if (threadId && threadKeyByThreadId.get(threadId) === messageKey) {
        threadKeyByThreadId.delete(threadId);
      }
    }
    if (thread.messageCount === 0) {
      draft.delete(threadKey);
      const threadId = this.getThreadId(message);
      if (threadId && threadKeyByThreadId.get(threadId) === threadKey) {
        threadKeyByThreadId.delete(threadId);
      }
      return;
    }
    const msgDate = dateValue(message);
    if (msgDate && msgDate.valueOf() === thread.newestTime) {
      let newest = 0;
      for (const key of thread.messageKeys) {
        const candidate = messageMap.get(key);
        const candDate = candidate ? dateValue(candidate) : undefined;
        if (candDate && candDate.valueOf() > newest) {
          newest = candDate.valueOf();
        }
      }
      thread.newestTime = newest;
    }
  }

  applyPreviewRows(rows: unknown[]): { applied: boolean; chatRows: number } {
    if (this.syncdb.get_state() === "ready") {
      return { applied: false, chatRows: 0 };
    }
    const snapshot = this.buildSnapshotFromRows(rows);
    this.applySnapshot(snapshot);
    return { applied: true, chatRows: snapshot.chatRows };
  }

  hydrateArchivedRows(rows: unknown[]): {
    applied: number;
    skipped: number;
  } {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) {
      return { applied: 0, skipped: 0 };
    }
    let applied = 0;
    let skipped = 0;
    const nextByDate = produce(this.messagesByDate, (dateDraft) => {
      this.messagesById = produce(this.messagesById, (idMapDraft) => {
        this.threadIndex = produce(this.threadIndex, (threadDraft) => {
          this.messageIdIndex = produce(this.messageIdIndex, (idDraft) => {
            this.dateIndex = produce(this.dateIndex, (dateIndexDraft) => {
              for (const row0 of list) {
                const normalized = normalizeChatMessage(row0);
                const nextMessage = normalized.message as
                  | PlainChatMessage
                  | undefined;
                if (!nextMessage || nextMessage.event !== "chat") {
                  skipped += 1;
                  continue;
                }
                const threadId = this.getThreadId(nextMessage);
                const key = this.getDateKey(nextMessage);
                const messageId = this.getMessageId(nextMessage);
                if (!threadId || !key || !messageId) {
                  skipped += 1;
                  continue;
                }

                const existingKeyForId = idDraft.get(messageId);
                if (existingKeyForId && existingKeyForId !== key) {
                  const prevById = dateDraft.get(existingKeyForId);
                  if (prevById) {
                    this.removeFromThreadIndex(
                      threadDraft,
                      prevById,
                      existingKeyForId,
                      dateDraft,
                    );
                  }
                  dateDraft.delete(existingKeyForId);
                  dateIndexDraft.delete(existingKeyForId);
                }

                const prev = dateDraft.get(key);
                if (prev) {
                  this.removeFromThreadIndex(threadDraft, prev, key, dateDraft);
                  const prevId =
                    dateIndexDraft.get(key) ?? this.getMessageId(prev);
                  if (prevId) {
                    idDraft.delete(prevId);
                    idMapDraft.delete(prevId);
                  }
                  dateIndexDraft.delete(key);
                }

                dateDraft.set(key, nextMessage);
                idMapDraft.set(messageId, nextMessage);
                idDraft.set(messageId, key);
                dateIndexDraft.set(key, messageId);
                this.addToThreadIndex(threadDraft, nextMessage, key);
                applied += 1;
              }
            });
          });
        });
      });
    });
    this.messagesByDate = nextByDate;
    if (applied > 0) {
      this.bumpVersion();
    }
    return { applied, skipped };
  }

  private applySnapshot(snapshot: ChatCacheSnapshot): void {
    this.messagesById = produce(snapshot.mapById, () => {});
    this.messagesByDate = produce(snapshot.mapByDate, () => {});
    this.messageIdIndex = produce(snapshot.messageIdIndex, () => {});
    this.dateIndex = produce(snapshot.dateIndex, () => {});
    this.threadIndex = produce(snapshot.threadIndex, () => {});
    // Keep this mutable; incremental change handling updates this map in-place.
    this.threadKeyByThreadId = new Map(snapshot.threadKeyByThreadId);
    this.threadConfigByThreadId = new Map(snapshot.threadConfigByThreadId);
    this.bumpVersion();
  }

  private buildSnapshotFromRows(rows: unknown[]): ChatCacheSnapshot {
    const mapById = new Map<string, PlainChatMessage>();
    const mapByDate = new Map<string, PlainChatMessage>();
    const messageIdIndex = new Map<string, string>();
    const dateIndex = new Map<string, string>();
    const threadIndex = new Map<string, ThreadIndexEntry>();
    const threadKeyByThreadId = new Map<string, string>();
    const threadConfigByThreadId = new Map<string, Record<string, unknown>>();
    const threadConfigRowsByThreadId = new Map<
      string,
      Record<string, unknown>[]
    >();
    const list = Array.isArray(rows) ? rows : [];
    let chatRows = 0;

    for (const row0 of list) {
      if ((row0 as any)?.event !== "chat-thread-config") continue;
      const threadId = `${(row0 as any)?.thread_id ?? ""}`.trim();
      if (!threadId) continue;
      const existing = threadConfigRowsByThreadId.get(threadId) ?? [];
      existing.push(row0 as Record<string, unknown>);
      threadConfigRowsByThreadId.set(threadId, existing);
    }
    for (const [threadId, configRows] of threadConfigRowsByThreadId) {
      const preferred = this.pickPreferredThreadConfigRow(configRows, threadId);
      if (preferred) {
        threadConfigByThreadId.set(threadId, preferred);
      }
    }

    // Build thread_id -> root-date-key mapping for compatibility helpers that
    // still need to open a thread's root message by date key.
    for (const row0 of list) {
      if ((row0 as any)?.event !== "chat") continue;
      const message = row0 as PlainChatMessage;
      if (parentMessageId(message)) continue;
      const threadId = this.getThreadId(message);
      const dateKey = this.getDateKey(message);
      if (!threadId || !dateKey) continue;
      threadKeyByThreadId.set(threadId, dateKey);
    }

    for (const row0 of list) {
      if ((row0 as any)?.event !== "chat") continue;
      const message = row0 as PlainChatMessage;
      const threadId = this.getThreadId(message);
      if (!threadId) continue;
      const key = this.getDateKey(message);
      if (!key) continue;
      const messageId = this.getMessageId(message);
      if (!messageId) continue;
      chatRows += 1;
      mapById.set(messageId, message);
      mapByDate.set(key, message);
      messageIdIndex.set(messageId, key);
      dateIndex.set(key, messageId);
      this.addToThreadIndex(threadIndex, message, key, threadKeyByThreadId);
    }

    return {
      mapById,
      mapByDate,
      messageIdIndex,
      dateIndex,
      threadIndex,
      threadKeyByThreadId,
      threadConfigByThreadId,
      chatRows,
    };
  }

  private async rebuildFromDoc() {
    log("rebuildFromDoc");
    if (this.syncdb.get_state() !== "ready") {
      log("rebuildFromDoc: waiting until ready");
      try {
        await once(this.syncdb, "ready");
      } catch (err) {
        log("rebuildFromDoc: never ready", err);
        return;
      }
    }
    const rows = this.syncdb.get() ?? [];
    log("rebuildFromDoc: got rows", rows);
    this.applySnapshot(this.buildSnapshotFromRows(rows));
  }

  // assumed is an => function (so bound)
  private handleChange = (
    changes: Set<Record<string, unknown>> | undefined,
  ) => {
    if (changes == null || changes.size === 0) {
      return;
    }
    log("handleChange", changes);
    if (this.syncdb.get_state() !== "ready") return;
    const rows: Record<string, unknown>[] = Array.from(changes);
    const changedThreadConfigIds = new Set<string>();
    for (const row0 of rows) {
      if (row0?.event !== "chat-thread-config") continue;
      const threadId = `${row0?.thread_id ?? ""}`.trim();
      if (threadId) {
        changedThreadConfigIds.add(threadId);
      }
    }
    for (const threadId of changedThreadConfigIds) {
      const next = this.getPreferredThreadConfigRowFromSyncdb(threadId);
      if (next) {
        this.threadConfigByThreadId.set(threadId, next);
      } else {
        this.threadConfigByThreadId.delete(threadId);
      }
    }
    const nextByDate = produce(this.messagesByDate, (dateDraft) => {
      this.messagesById = produce(this.messagesById, (idMapDraft) => {
        this.threadIndex = produce(this.threadIndex, (threadDraft) => {
          this.messageIdIndex = produce(this.messageIdIndex, (idDraft) => {
            this.dateIndex = produce(this.dateIndex, (dateIndexDraft) => {
              for (const row0 of rows) {
                if (row0?.event !== "chat") continue;
                if (!row0?.date) continue;
                // SyncDoc.get_one requires only primary key fields so we make an object
                // where that ONLY has those fields and no others.
                const where: Record<string, unknown> = {};
                if (row0?.event != null) where.event = row0.event;
                if (row0?.sender_id != null) where.sender_id = row0.sender_id;
                if (row0?.date != null) where.date = row0.date;
                if (row0?.message_id != null)
                  where.message_id = row0.message_id;
                if (row0?.thread_id != null) where.thread_id = row0.thread_id;
                const rec = this.syncdb.get_one(where);
                const key = this.getDateKey(rec ?? row0);
                if (!key) continue;

                const prev = dateDraft.get(key);
                if (prev) {
                  this.removeFromThreadIndex(threadDraft, prev, key, dateDraft);
                  const prevId =
                    dateIndexDraft.get(key) ?? this.getMessageId(prev);
                  if (prevId) {
                    idDraft.delete(prevId);
                    idMapDraft.delete(prevId);
                  }
                  dateIndexDraft.delete(key);
                }

                if (rec?.event !== "chat") {
                  dateDraft.delete(key);
                  continue;
                }

                const nextMessage = rec as PlainChatMessage;
                const nextId = this.getMessageId(nextMessage);
                if (!nextId) continue;
                dateDraft.set(key, nextMessage);
                idMapDraft.set(nextId, nextMessage);
                idDraft.set(nextId, key);
                dateIndexDraft.set(key, nextId);
                this.addToThreadIndex(threadDraft, nextMessage, key);
              }
            });
          });
        });
      });
    });
    this.messagesByDate = nextByDate;
    this.bumpVersion();
  };
}

export interface ThreadIndexEntry {
  key: string;
  newestTime: number;
  messageCount: number;
  messageKeys: Set<string>;
  orderedKeys?: string[];
  rootMessage?: PlainChatMessage;
}

interface ChatCacheSnapshot {
  mapById: Map<string, PlainChatMessage>;
  mapByDate: Map<string, PlainChatMessage>;
  messageIdIndex: Map<string, string>;
  dateIndex: Map<string, string>;
  threadIndex: Map<string, ThreadIndexEntry>;
  threadKeyByThreadId: Map<string, string>;
  threadConfigByThreadId: Map<string, Record<string, unknown>>;
  chatRows: number;
}
