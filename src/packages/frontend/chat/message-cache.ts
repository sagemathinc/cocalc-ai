import { EventEmitter } from "events";
import { enableMapSet, produce } from "immer";
import type { ImmerDB } from "@cocalc/sync/editor/immer-db";
import type { PlainChatMessage } from "./types";
import { dateValue, replyTo } from "./access";
import { once } from "@cocalc/util/async-utils";

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

  private getThreadKeyForMap(
    message: PlainChatMessage,
  ): string | undefined {
    const threadId = this.getThreadId(message);
    return threadId;
  }

  private getMessageId(
    message?: PlainChatMessage,
  ): string | undefined {
    const id = (message as any)?.message_id;
    if (typeof id === "string" && id.length > 0) return id;
    return undefined;
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
    if (!replyTo(message)) {
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
    if (!replyTo(message) && thread.rootMessage?.date === message.date) {
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

  private applySnapshot(snapshot: ChatCacheSnapshot): void {
    this.messagesById = produce(snapshot.mapById, () => {});
    this.messagesByDate = produce(snapshot.mapByDate, () => {});
    this.messageIdIndex = produce(snapshot.messageIdIndex, () => {});
    this.dateIndex = produce(snapshot.dateIndex, () => {});
    this.threadIndex = produce(snapshot.threadIndex, () => {});
    // Keep this mutable; incremental change handling updates this map in-place.
    this.threadKeyByThreadId = new Map(snapshot.threadKeyByThreadId);
    this.bumpVersion();
  }

  private buildSnapshotFromRows(rows: unknown[]): ChatCacheSnapshot {
    const mapById = new Map<string, PlainChatMessage>();
    const mapByDate = new Map<string, PlainChatMessage>();
    const messageIdIndex = new Map<string, string>();
    const dateIndex = new Map<string, string>();
    const threadIndex = new Map<string, ThreadIndexEntry>();
    const threadKeyByThreadId = new Map<string, string>();
    const list = Array.isArray(rows) ? rows : [];
    let chatRows = 0;

    // Build thread_id -> root-date-key mapping for opening root messages from
    // thread metadata (used by a few date-keyed helpers).
    for (const row0 of list) {
      if ((row0 as any)?.event !== "chat") continue;
      const message = row0 as PlainChatMessage;
      if (replyTo(message)) continue;
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
  chatRows: number;
}
