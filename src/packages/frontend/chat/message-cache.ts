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

  private getThreadKey(message: PlainChatMessage): string | undefined {
    const root = replyTo(message);
    if (root) {
      const d = new Date(root);
      return Number.isFinite(d.valueOf()) ? `${d.valueOf()}` : undefined;
    }
    const d = dateValue(message);
    return d ? `${d.valueOf()}` : undefined;
  }

  private getMessageId(
    message?: PlainChatMessage,
    dateKey?: string,
  ): string | undefined {
    const id = (message as any)?.message_id;
    if (typeof id === "string" && id.length > 0) return id;
    if (!message || !dateKey) return undefined;
    const sender = `${(message as any)?.sender_id ?? "unknown"}`;
    return `legacy-message:${sender}:${dateKey}`;
  }

  private addToThreadIndex(
    draft: Map<string, ThreadIndexEntry>,
    message: PlainChatMessage,
    messageKey: string,
  ) {
    const threadKey = this.getThreadKey(message);
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
    }
  }

  private removeFromThreadIndex(
    draft: Map<string, ThreadIndexEntry>,
    message: PlainChatMessage,
    messageKey: string,
    messageMap: Map<string, PlainChatMessage>,
  ) {
    const threadKey = this.getThreadKey(message);
    if (!threadKey) return;
    const thread = draft.get(threadKey);
    if (!thread) return;
    thread.messageKeys.delete(messageKey);
    thread.messageCount = thread.messageKeys.size;
    if (!replyTo(message) && thread.rootMessage?.date === message.date) {
      thread.rootMessage = undefined;
    }
    if (thread.messageCount === 0) {
      draft.delete(threadKey);
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
    const mapById = new Map<string, PlainChatMessage>();
    const mapByDate = new Map<string, PlainChatMessage>();
    const messageIdIndex = new Map<string, string>();
    const dateIndex = new Map<string, string>();
    const threadIndex = new Map<string, ThreadIndexEntry>();
    const rows = this.syncdb.get() ?? [];
    log("rebuildFromDoc: got rows", rows);

    for (const row0 of rows ?? []) {
      if (row0?.event !== "chat") continue;
      const key = this.getDateKey(row0);
      if (!key) continue;
      const message = row0 as PlainChatMessage;
      const messageId = this.getMessageId(message, key);
      if (messageId) {
        mapById.set(messageId, message);
        mapByDate.set(key, message);
        messageIdIndex.set(messageId, key);
        dateIndex.set(key, messageId);
      }
      this.addToThreadIndex(threadIndex, message, key);
    }
    // Freeze rebuilt Maps for consistency with produce() updates.
    this.messagesById = produce(mapById, () => {});
    this.messagesByDate = produce(mapByDate, () => {});
    this.messageIdIndex = produce(messageIdIndex, () => {});
    this.dateIndex = produce(dateIndex, () => {});
    this.threadIndex = produce(threadIndex, () => {});
    this.bumpVersion();
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
                    dateIndexDraft.get(key) ?? this.getMessageId(prev, key);
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
                const nextId = this.getMessageId(nextMessage, key);
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
