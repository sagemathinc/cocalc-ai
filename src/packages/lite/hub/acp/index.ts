import path from "node:path";
import { URL } from "node:url";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import getLogger from "@cocalc/backend/logger";
import { data } from "@cocalc/backend/data";
import {
  CodexExecAgent,
  EchoAgent,
  type AcpAgent,
  forkSession,
  getSessionsRoot,
} from "@cocalc/ai/acp";
import { AgentTimeTravelRecorder } from "@cocalc/ai/sync";
import { init as initConatAcp } from "@cocalc/conat/ai/acp/server";
import type {
  AcpRequest,
  AcpStreamPayload,
  AcpStreamMessage,
  AcpStreamEvent,
  AcpChatContext,
  AcpForkSessionRequest,
  AcpInterruptRequest,
} from "@cocalc/conat/ai/acp/types";
import { resolveCodexSessionMode } from "@cocalc/util/ai/codex";
import { isValidUUID } from "@cocalc/util/misc";
import { type Client as ConatClient } from "@cocalc/conat/core/client";
import type {
  FileAdapter,
  TerminalAdapter,
  TerminalStartOptions,
} from "@cocalc/ai/acp/adapters";
import { type AcpExecutor, ContainerExecutor, LocalExecutor } from "./executor";
import {
  preferContainerExecutor,
  resolveWorkspaceRoot,
} from "./workspace-root";
import { getBlobstore } from "../blobs/download";
import {
  buildChatMessage,
  deriveAcpLogRefs,
  type MessageHistory,
} from "@cocalc/chat";
import { acquireChatSyncDB, releaseChatSyncDB } from "@cocalc/chat/server";
import { appendStreamMessage, extractEventText } from "@cocalc/chat";
import type { SyncDB } from "@cocalc/conat/sync-doc/syncdb";
import type { AcpStreamUsage } from "@cocalc/ai/acp";
import { once } from "@cocalc/util/async-utils";
import {
  enqueueAcpPayload,
  listAcpPayloads,
  clearAcpPayloads,
} from "../sqlite/acp-queue";
import { initDatabase } from "../sqlite/database";
import {
  finalizeAcpTurnLease,
  heartbeatAcpTurnLease,
  listRunningAcpTurnLeases,
  startAcpTurnLease,
  updateAcpTurnLeaseSessionId,
} from "../sqlite/acp-turns";
import { throttle } from "lodash";
import { akv, type AKV } from "@cocalc/conat/sync/akv";

// how many ms between saving output during a running turn
// so that everybody sees it.
const COMMIT_INTERVAL = 2_000;
const LEASE_HEARTBEAT_INTERVAL = 2_000;

const logger = getLogger("lite:hub:acp");
const ACP_INSTANCE_ID = randomUUID();

let blobStore: AKV | null = null;
const agents = new Map<string, AcpAgent>();
let conatClient: ConatClient | null = null;

const INTERRUPT_STATUS_TEXT = "Conversation interrupted.";
const RESTART_INTERRUPTED_NOTICE =
  "**Conversation interrupted because the backend server restarted.**";

const chatWritersByChatKey = new Map<string, ChatStreamWriter>();
const chatWritersByThreadId = new Map<string, ChatStreamWriter>();

export function getAcpWatchdogStats({ topN = 5 }: { topN?: number } = {}) {
  const top = Math.max(1, topN);
  const snapshots = Array.from(chatWritersByChatKey.values()).map((writer) =>
    writer.watchdogSnapshot(),
  );
  const activeWriters = snapshots.filter((x) => !x.closed).length;
  const finishedWriters = snapshots.filter((x) => x.finished).length;
  const disposeScheduled = snapshots.filter((x) => x.disposeScheduled).length;
  const syncdbErrors = snapshots.filter((x) => x.hasSyncdbError).length;
  const totalBufferedEvents = snapshots.reduce((sum, x) => sum + x.events, 0);
  const topWritersByEvents = [...snapshots]
    .sort((a, b) => b.events - a.events)
    .slice(0, top)
    .map((x) => ({
      chatKey: x.chatKey,
      path: x.path,
      messageDate: x.messageDate,
      events: x.events,
      finished: x.finished,
      disposeScheduled: x.disposeScheduled,
      threadIds: x.threadIds,
    }));
  return {
    writersByChatKey: chatWritersByChatKey.size,
    writersByThreadId: chatWritersByThreadId.size,
    activeWriters,
    finishedWriters,
    disposeScheduled,
    syncdbErrors,
    totalBufferedEvents,
    topWritersByEvents,
  };
}

function logWriterCounts(
  reason: string,
  extra?: Record<string, unknown>,
): void {
  logger.debug("chat writers map size", {
    reason,
    byChatKey: chatWritersByChatKey.size,
    byThreadId: chatWritersByThreadId.size,
    ...extra,
  });
}

function chatKey(metadata: AcpChatContext): string {
  return `${metadata.project_id}:${metadata.path}:${metadata.message_date}`;
}

function findChatWriter({
  threadId,
  chat,
}: {
  threadId?: string;
  chat?: AcpChatContext;
}): ChatStreamWriter | undefined {
  if (threadId) {
    const writer = chatWritersByThreadId.get(threadId);
    if (writer != null) {
      return writer;
    }
  }
  if (chat != null) {
    return chatWritersByChatKey.get(chatKey(chat));
  }
  return undefined;
}

export class ChatStreamWriter {
  public syncdbError?: unknown;
  private syncdb?: SyncDB;
  private syncdbPromise: Promise<SyncDB>;
  private usePool: boolean;
  private metadata: AcpChatContext;
  private readonly chatKey: string;
  private threadKeys = new Set<string>();
  private prevHistory: MessageHistory[] = [];
  private ready: Promise<void>;
  private closed = false;
  private events: AcpStreamMessage[] = [];
  private usage: AcpStreamUsage | null = null;
  private content = "";
  private lastErrorText: string | null = null;
  private threadId: string | null = null;
  private seq = 0;
  private finished = false;
  private finishedBy?: "summary" | "error";
  private approverAccountId: string;
  private interruptedMessage?: string;
  private interruptNotified = false;
  private disposeTimer?: NodeJS.Timeout;
  private sessionKey?: string;
  private logStore?: AKV<AcpStreamMessage[]>;
  private logStoreName: string;
  private logKey: string;
  private logSubject: string;
  private client: ConatClient;
  private timeTravel?: AgentTimeTravelRecorder;
  private leaseFinalized = false;
  private heartbeatLease = throttle(
    () => {
      this.touchLease();
    },
    LEASE_HEARTBEAT_INTERVAL,
    { leading: true, trailing: true },
  );
  private persistLogProgress = throttle(
    async () => {
      try {
        const store = this.getLogStore();
        await store.set(this.logKey, this.events);
      } catch (err) {
        logger.debug("failed to persist acp log incrementally", err);
      }
    },
    1000,
    { leading: true, trailing: true },
  );

  // Read a field from a syncdb record that may be either an Immutable.js map
  // (legacy) or a plain JS object (immer). This keeps the ACP hub compatible
  // with both modes while we migrate fully to immer.
  private recordField<T = unknown>(record: any, key: string): T | undefined {
    if (record == null) return undefined;
    if (typeof record.get === "function") return record.get(key) as T;
    return (record as any)[key] as T;
  }

  private leaseKey() {
    return {
      project_id: this.metadata.project_id,
      path: this.metadata.path,
      message_date: this.metadata.message_date,
    };
  }

  private startLease(): void {
    try {
      startAcpTurnLease({
        context: this.metadata,
        owner_instance_id: ACP_INSTANCE_ID,
        pid: process.pid,
        session_id: this.sessionKey ?? undefined,
      });
    } catch (err) {
      logger.warn("failed to start acp turn lease", {
        chatKey: this.chatKey,
        err,
      });
    }
  }

  private touchLease(): void {
    if (this.leaseFinalized) return;
    try {
      heartbeatAcpTurnLease({
        key: this.leaseKey(),
        owner_instance_id: ACP_INSTANCE_ID,
        pid: process.pid,
        session_id: this.threadId ?? this.sessionKey ?? undefined,
      });
    } catch (err) {
      logger.debug("failed to heartbeat acp turn lease", {
        chatKey: this.chatKey,
        err,
      });
    }
  }

  private finalizeLease(
    state: "completed" | "error" | "aborted",
    reason?: string,
  ): void {
    if (this.leaseFinalized) return;
    this.leaseFinalized = true;
    try {
      this.heartbeatLease.flush();
    } catch {
      // ignore
    }
    this.heartbeatLease.cancel();
    try {
      finalizeAcpTurnLease({
        key: this.leaseKey(),
        state,
        reason,
        owner_instance_id: ACP_INSTANCE_ID,
      });
    } catch (err) {
      logger.warn("failed to finalize acp turn lease", {
        chatKey: this.chatKey,
        state,
        reason,
        err,
      });
    }
  }

  constructor({
    metadata,
    client,
    approverAccountId,
    sessionKey,
    workspaceRoot,
    syncdbOverride,
    logStoreFactory,
  }: {
    metadata: AcpChatContext;
    client: ConatClient;
    approverAccountId: string;
    sessionKey?: string;
    workspaceRoot?: string;
    syncdbOverride?: any;
    logStoreFactory?: () => AKV<AcpStreamMessage[]>;
  }) {
    this.metadata = metadata;
    this.approverAccountId = approverAccountId;
    this.client = client;
    this.chatKey = chatKey(metadata);
    this.usePool = syncdbOverride == null;
    this.syncdbPromise =
      syncdbOverride != null
        ? Promise.resolve(syncdbOverride)
        : acquireChatSyncDB({
            client,
            project_id: metadata.project_id,
            path: metadata.path,
          });
    if (syncdbOverride != null) {
      this.syncdb = syncdbOverride as any;
    }
    // Ensure rejections are observed and mark the writer closed on failure.
    this.syncdbPromise.catch((err) => {
      logger.warn("chat syncdb failed to initialize", err);
      this.syncdbError = err;
      this.closed = true;
    });
    chatWritersByChatKey.set(this.chatKey, this);
    logWriterCounts("create", { chatKey: this.chatKey });
    this.sessionKey = sessionKey;
    this.startLease();
    if (sessionKey) {
      this.registerThreadKey(sessionKey);
    }
    const thread_root_date = metadata.reply_to ?? metadata.message_date;
    // Use the assistant reply date as a unique turn identifier so each turn gets
    // an isolated log key; avoid reusing the session key which can span turns.
    const turn_date = metadata.message_date ?? randomUUID();
    const refs = deriveAcpLogRefs({
      project_id: metadata.project_id,
      path: metadata.path,
      thread_root_date,
      turn_date,
    });
    this.logStoreName = refs.store;
    this.logKey = refs.key;
    this.logSubject = refs.subject;
    // ensure initialization rejections are observed immediately
    this.ready = this.initialize();
    this.waitUntilReady();
    if (logStoreFactory) {
      this.logStore = logStoreFactory();
    }
    if (workspaceRoot) {
      this.timeTravel = new AgentTimeTravelRecorder({
        project_id: metadata.project_id,
        chat_path: metadata.path,
        thread_root_date: thread_root_date,
        turn_date: turn_date,
        log_store: refs.store,
        log_key: refs.key,
        log_subject: refs.subject,
        client,
        workspaceRoot,
        sessionId: sessionKey,
      });
      logger.debug("agent-tt enabled", {
        chatKey: this.chatKey,
        project_id: metadata.project_id,
        chat_path: metadata.path,
        workspaceRoot,
      });
    } else {
      logger.debug("agent-tt disabled (no workspaceRoot)", {
        chatKey: this.chatKey,
        project_id: metadata.project_id,
        chat_path: metadata.path,
      });
    }
  }

  waitUntilReady = async () => {
    try {
      await this.ready;
    } catch (err) {
      logger.warn("chat stream writer failed to initialize", err);
      this.syncdbError = err;
      this.closed = true;
    }
  };

  isClosed = () => this.closed;

  private async initialize(): Promise<void> {
    const db = await this.syncdbPromise;
    this.syncdb = db;
    if (!db.isReady()) {
      try {
        await once(db, "ready");
      } catch (err) {
        logger.warn("chat syncdb failed to become ready", err);
        throw err;
      }
    }
    let current = db.get_one({
      event: "chat",
      date: this.metadata.message_date,
    });
    if (current == null) {
      // Create a placeholder chat row so backend-owned updates don’t race with a missing record.
      const placeholder = buildChatMessage({
        sender_id: this.metadata.sender_id,
        date: this.metadata.message_date,
        prevHistory: [],
        content: ":robot: Thinking...",
        generating: true,
        reply_to: this.metadata.reply_to,
      } as any);
      db.set(placeholder);
      db.commit();
      try {
        await db.save();
      } catch (err) {
        logger.warn("chat syncdb save failed during init", err);
      }
      current = db.get_one({
        event: "chat",
        date: this.metadata.message_date,
      });
    }
    const history = this.recordField(current, "history");
    const arr = this.historyToArray(history);
    if (arr.length > 0) {
      this.prevHistory = arr.slice(1);
    }
    const queued = listAcpPayloads(this.metadata);
    for (const payload of queued) {
      this.processPayload(payload, { persist: false });
    }
  }

  private historyToArray(value: any): MessageHistory[] {
    if (value == null) return [];
    if (Array.isArray(value)) return value;
    if (typeof value.toJS === "function") {
      return value.toJS();
    }
    return [];
  }

  async handle(payload?: AcpStreamPayload | null): Promise<void> {
    await this.ready;
    if (this.closed) return;
    if (payload == null) {
      this.dispose();
      return;
    }
    const message: AcpStreamMessage = {
      ...(payload as AcpStreamMessage),
      seq: this.seq++,
    };
    this.processPayload(message, { persist: true });
    const isLastMessage =
      message.type === "summary" || message.type === "error" || this.finished;
    this.commit(!isLastMessage);
    if (isLastMessage) {
      // Ensure the final "generating: false" state hits SyncDB immediately,
      // even if the throttle window is large.
      this.commit.flush();
    }
  }

  private processPayload(
    payload: AcpStreamMessage,
    { persist }: { persist: boolean },
  ): void {
    if (this.closed) return;
    this.heartbeatLease();
    if ((payload.seq ?? -1) >= this.seq) {
      this.seq = (payload.seq ?? -1) + 1;
    }
    if (persist) {
      try {
        enqueueAcpPayload(this.metadata, payload);
      } catch (err) {
        logger.warn("failed to enqueue acp payload", err);
      }
    }
    if ((payload as any).type === "usage") {
      // Live usage updates from Codex; stash for commit and don't treat as a user-visible event.
      this.usage = (payload as any).usage ?? null;
      return;
    }
    this.events = appendStreamMessage(this.events, payload);
    this.publishLog(payload);
    this.persistLogProgress();
    if (payload.type === "event") {
      this.handleAgentEvent(payload.event);
      const text = extractEventText(payload.event);
      if (text) {
        const last = this.events[this.events.length - 1];
        const mergedText =
          last?.type === "event" ? extractEventText(last.event) : undefined;
        // Use the merged text so we preserve the full streamed body.
        this.content = mergedText ?? text;
      }
      return;
    }
    if (payload.type === "summary") {
      const finishedFromError = this.finishedBy === "error";
      const latestMessage = getLatestMessageText(this.events);
      const hasStreamedMessage =
        typeof latestMessage === "string" && latestMessage.trim().length > 0;
      const candidate =
        (hasStreamedMessage
          ? latestMessage
          : payload.finalResponse) ??
        this.interruptedMessage ??
        this.content;
      const shouldApplySummary =
        !finishedFromError ||
        (hasStreamedMessage &&
          typeof candidate === "string" &&
          candidate.trim().length > 0 &&
          !looksLikeErrorEcho(candidate, this.lastErrorText));
      if (candidate != null && shouldApplySummary) {
        if (
          this.content &&
          this.content.length > 0 &&
          candidate.length > 0 &&
          candidate !== this.content &&
          !candidate.startsWith(this.content) &&
          this.finishedBy !== "error"
        ) {
          // Multiple summaries can arrive; append new text if it doesn't already
          // include the existing accumulated content.
          this.content = `${this.content}${candidate}`;
        } else {
          this.content = candidate;
        }
        this.finishedBy = "summary";
      }
      if (payload.usage) {
        this.usage = payload.usage;
      }
      if (payload.threadId != null) {
        this.threadId = payload.threadId;
        this.registerThreadKey(payload.threadId);
        this.timeTravel?.setThreadId(payload.threadId);
      }
      clearAcpPayloads(this.metadata);
      this.finished = true;
      this.finalizeLease("completed");
      void this.timeTravel?.finalizeTurn(this.metadata.message_date);
      void this.persistLog();
      return;
    }
    if (payload.type === "error") {
      this.content = `\n\n<span style='color:#b71c1c'>${payload.error}</span>\n\n`;
      this.lastErrorText = payload.error;
      clearAcpPayloads(this.metadata);
      this.finished = true;
      this.finishedBy = "error";
      this.finalizeLease("error", payload.error);
      void this.timeTravel?.finalizeTurn(this.metadata.message_date);
      void this.persistLog();
    }
  }

  private commit = throttle((generating: boolean): void => {
    this.heartbeatLease();
    logger.debug("commit", {
      generating,
      closed: this.closed,
      content: this.content,
      events: this.events.length,
      metadata: this.metadata,
    });
    if (this.closed || this.syncdbError) return;
    if (!this.syncdb) {
      logger.warn("chat stream writer commit skipped: syncdb not ready");
      return;
    }
    const message = buildChatMessage({
      sender_id: this.metadata.sender_id,
      date: this.metadata.message_date,
      prevHistory: this.prevHistory,
      content: this.content,
      generating,
      reply_to: this.metadata.reply_to,
      acp_thread_id: this.threadId,
      acp_usage: this.usage,
      acp_account_id: this.approverAccountId,
    });
    this.syncdb!.set({ ...message, reply_to2: this.metadata.reply_to });
    this.syncdb!.commit();
    (async () => {
      try {
        await this.syncdb!.save();
      } catch (err) {
        logger.warn("chat syncdb save failed", err);
      }
    })();
  }, COMMIT_INTERVAL);

  dispose(forceImmediate: boolean = false): void {
    if (this.closed) return;

    // If we've already finished the turn, delay dispose slightly to let
    // the final generating=false write propagate unless explicitly forced.
    // This works around a known race in @cocalc/sync (src/packages/sync)
    // where very fast true→false toggles can be dropped; the delay gives
    // the final state a chance to land. Remove once the sync bug is fixed.
    if (!forceImmediate && this.finished) {
      if (this.disposeTimer) return;
      this.disposeTimer = setTimeout(() => this.dispose(true), 1500);
      return;
    }

    if (this.disposeTimer) {
      clearTimeout(this.disposeTimer);
      this.disposeTimer = undefined;
    }

    if (!this.leaseFinalized) {
      const reason = this.finished
        ? "disposed after finished turn"
        : this.interruptNotified
          ? INTERRUPT_STATUS_TEXT
          : "writer disposed before terminal payload";
      this.finalizeLease("aborted", reason);
    }

    this.commit(false);
    this.commit.flush();
    this.closed = true;
    void this.timeTravel?.dispose();
    chatWritersByChatKey.delete(this.chatKey);
    logWriterCounts("dispose", { chatKey: this.chatKey });
    for (const key of this.threadKeys) {
      const writer = chatWritersByThreadId.get(key);
      if (writer === this) {
        chatWritersByThreadId.delete(key);
        logWriterCounts("dispose-thread", { threadId: key });
      }
    }
    this.threadKeys.clear();
    if (!this.finished) {
      clearAcpPayloads(this.metadata);
    }
    try {
      this.persistLogProgress.flush();
    } catch {
      // ignore
    }
    void this.persistLog();
    (async () => {
      try {
        await this.syncdbPromise;
        await this.syncdb!.save();
      } catch (err) {
        logger.warn("failed to save chat syncdb", err);
      }
      try {
        if (this.usePool) {
          await releaseChatSyncDB(this.metadata.project_id, this.metadata.path);
        } else {
          await this.syncdb!.close();
        }
      } catch (err) {
        logger.warn("failed to close chat syncdb", err);
      }
    })();
  }

  addLocalEvent(event: AcpStreamEvent): void {
    if (this.closed) return;
    void (async () => {
      await this.ready;
      if (this.closed || this.syncdbError) return;
      const message: AcpStreamMessage = {
        type: "event",
        event,
        seq: this.seq++,
      };
      this.processPayload(message, { persist: true });
      this.commit(true);
    })();
  }

  private handleAgentEvent(event: AcpStreamEvent): void {
    if (!this.timeTravel) return;
    const turnId = this.metadata.message_date;
    if (event.type === "file") {
      if (event.operation === "read") {
        void this.timeTravel.recordRead(event.path, turnId);
      } else {
        void this.timeTravel.recordWrite(event.path, turnId);
      }
      return;
    }
    if (event.type === "diff") {
      void this.timeTravel.recordWrite(event.path, turnId);
    }
  }

  notifyInterrupted(text: string): void {
    if (this.interruptNotified) return;
    this.interruptNotified = true;
    this.interruptedMessage = text;
    this.addLocalEvent({
      type: "message",
      text,
    });
  }

  getKnownThreadIds(): string[] {
    const ids: string[] = [];
    if (this.threadId) ids.push(this.threadId);
    if (this.sessionKey) ids.push(this.sessionKey);
    return Array.from(new Set(ids));
  }

  watchdogSnapshot() {
    return {
      chatKey: this.chatKey,
      path: this.metadata.path,
      messageDate: this.metadata.message_date,
      events: this.events.length,
      finished: this.finished,
      closed: this.closed,
      disposeScheduled: this.disposeTimer != null,
      hasSyncdbError: this.syncdbError != null,
      threadIds: this.getKnownThreadIds(),
    };
  }

  private registerThreadKey(key: string): void {
    if (!key) return;
    this.threadKeys.add(key);
    chatWritersByThreadId.set(key, this);
    logWriterCounts("register-thread", { threadId: key });
    try {
      updateAcpTurnLeaseSessionId({
        key: this.leaseKey(),
        session_id: key,
      });
    } catch (err) {
      logger.debug("failed to persist acp turn session id", {
        chatKey: this.chatKey,
        key,
        err,
      });
    }
    this.heartbeatLease();
    void this.persistSessionId(key);
  }

  private getLogStore(): AKV<AcpStreamMessage[]> {
    if (this.logStore) return this.logStore;
    this.logStore = akv<AcpStreamMessage[]>({
      project_id: this.metadata.project_id,
      name: this.logStoreName,
      client: this.client,
    });
    return this.logStore;
  }

  private publishLog(event: AcpStreamMessage): void {
    if (this.closed) return;
    void this.client
      .publish(this.logSubject, event)
      .catch((err) => logger.debug("publish log failed", err));
  }

  private async persistLog(): Promise<void> {
    if (this.events.length === 0) return;
    try {
      const store = this.getLogStore();
      await store.set(this.logKey, this.events);
    } catch (err) {
      logger.warn("failed to persist acp log", err);
    }
  }

  // Persist the session/thread id into the thread root's acp_config so
  // the frontend can display and reuse it across turns/refreshes.
  private async persistSessionId(sessionId: string): Promise<void> {
    await this.ready;
    if (this.closed || !this.syncdb) return;
    const threadRoot = this.metadata.reply_to ?? this.metadata.message_date;
    try {
      const current = this.syncdb.get_one({
        event: "chat",
        date: threadRoot,
      });
      const prevCfg = this.recordField<any>(current, "acp_config");
      const cfg = prevCfg ?? {};
      if (cfg.sessionId === sessionId) return;
      this.syncdb.set({
        event: "chat",
        date: threadRoot,
        acp_config: { ...cfg, sessionId },
      });
      this.syncdb.commit();
      await this.syncdb.save();
    } catch (err) {
      logger.debug("persistSessionId failed", err);
    }
  }
}

function getLatestMessageText(events: AcpStreamMessage[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt?.type === "event" && evt.event?.type === "message") {
      const text = evt.event.text;
      if (typeof text === "string") {
        return text;
      }
    }
  }
  return undefined;
}

function normalizeSummaryText(text: string | null | undefined): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function looksLikeErrorEcho(
  summaryText: string,
  errorText: string | null | undefined,
): boolean {
  const summary = normalizeSummaryText(summaryText);
  const error = normalizeSummaryText(errorText);
  if (!summary || !error) return false;
  if (summary === error) return true;
  return summary.includes(error) || error.includes(summary);
}

function syncdbField<T = unknown>(record: any, key: string): T | undefined {
  if (record == null) return undefined;
  if (typeof record.get === "function") return record.get(key) as T;
  return (record as any)[key] as T;
}

function historyToArray(value: any): MessageHistory[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value as MessageHistory[];
  if (typeof value.toJS === "function") return value.toJS() as MessageHistory[];
  return [];
}

function appendRestartNotice(historyValue: any): MessageHistory[] {
  const history = historyToArray(historyValue);
  if (history.length === 0) {
    return [];
  }
  const first = history[0] as MessageHistory;
  const content =
    typeof first?.content === "string"
      ? first.content
      : `${(first as any)?.content ?? ""}`;
  if (/conversation interrupted/i.test(content)) {
    return history;
  }
  const sep = content.trim().length > 0 ? "\n\n" : "";
  return [
    {
      ...first,
      content: `${content}${sep}${RESTART_INTERRUPTED_NOTICE}`,
    },
    ...history.slice(1),
  ];
}

export async function recoverOrphanedAcpTurns(
  client: ConatClient,
): Promise<number> {
  let running;
  try {
    running = listRunningAcpTurnLeases({
      exclude_owner_instance_id: ACP_INSTANCE_ID,
    });
  } catch (err) {
    logger.warn("failed to list running acp turn leases", err);
    return 0;
  }
  if (!running.length) return 0;
  logger.warn("recovering orphaned acp turns", {
    instance: ACP_INSTANCE_ID,
    count: running.length,
  });
  let recovered = 0;
  for (const turn of running) {
    const context: AcpChatContext = {
      project_id: turn.project_id,
      path: turn.path,
      message_date: turn.message_date,
      sender_id: turn.sender_id ?? "openai-codex-agent",
      reply_to: turn.reply_to ?? undefined,
    };
    try {
      clearAcpPayloads(context);
    } catch (err) {
      logger.debug("failed clearing acp queue during recovery", {
        context,
        err,
      });
    }
    try {
      const syncdb = await acquireChatSyncDB({
        client,
        project_id: turn.project_id,
        path: turn.path,
      });
      try {
        if (!syncdb.isReady()) {
          await once(syncdb, "ready");
        }
        const current = syncdb.get_one({
          event: "chat",
          date: turn.message_date,
        });
        const generating = syncdbField<boolean>(current, "generating");
        if (current != null && generating === true) {
          const history = appendRestartNotice(syncdbField(current, "history"));
          const update: any = {
            event: "chat",
            date: turn.message_date,
            generating: false,
          };
          if (history.length > 0) {
            update.history = history;
          }
          syncdb.set(update);
          syncdb.commit();
          await syncdb.save();
        }
      } finally {
        await releaseChatSyncDB(turn.project_id, turn.path);
      }
    } catch (err) {
      logger.warn("failed to recover orphaned acp chat row", {
        turn,
        err,
      });
    }
    try {
      finalizeAcpTurnLease({
        key: {
          project_id: turn.project_id,
          path: turn.path,
          message_date: turn.message_date,
        },
        state: "aborted",
        reason: "server restart recovery",
        owner_instance_id: ACP_INSTANCE_ID,
      });
      recovered += 1;
    } catch (err) {
      logger.warn("failed to finalize orphaned acp lease", {
        turn,
        err,
      });
    }
  }
  logger.warn("finished orphaned acp turn recovery", {
    instance: ACP_INSTANCE_ID,
    recovered,
    total: running.length,
  });
  return recovered;
}

type ExecutorAdapters = {
  workspaceRoot: string;
  fileAdapter: FileAdapter;
  terminalAdapter: TerminalAdapter;
  commandHandlers?: Record<string, any>;
};

function buildExecutorAdapters(
  executor: AcpExecutor,
  workspaceRoot: string,
  hostRoot: string,
): ExecutorAdapters {
  // In container mode we expect:
  // - container paths to live under /root (workspaceRoot is the container path)
  // - host paths to point to the bind mount on the host (never /root)
  // This lets us distinguish whether an incoming absolute path is host-side or
  // container-side. Warn early if we can't tell the difference.
  if (
    workspaceRoot.startsWith("/root") &&
    hostRoot.startsWith("/root") &&
    workspaceRoot !== hostRoot
  ) {
    logger.warn("hostRoot unexpectedly looks like a container path", {
      workspaceRoot,
      hostRoot,
    });
  }

  const shellHandler = async ({ command, args, cwd, env }: any) => {
    logger.debug("shellHandler exec", {
      command,
      args,
      cwd,
      env,
      workspaceRoot: normalizedWorkspace,
      hostRoot: normalizedHostRoot,
    });
    const joined =
      args && Array.isArray(args) && args.length > 0
        ? `${command} ${args.join(" ")}`
        : command;
    const result = await executor.exec(joined, {
      cwd,
      env,
    });
    return {
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      exitStatus: result.exitCode ?? undefined,
      signal: result.signal,
    };
  };

  const normalizedWorkspace = path.normalize(workspaceRoot || "/");
  const normalizedHostRoot = hostRoot ? path.normalize(hostRoot) : undefined;

  const toRelative = (p: string): string => {
    const absolute = path.isAbsolute(p)
      ? path.normalize(p)
      : path.resolve(normalizedWorkspace, path.normalize(p));

    // If the path is under the host mount, prefer that mapping.
    if (normalizedHostRoot && absolute.startsWith(normalizedHostRoot)) {
      const relHost = path.relative(normalizedHostRoot, absolute);
      if (relHost.startsWith("..")) {
        throw new Error(`path ${absolute} is outside host root`);
      }
      return relHost || ".";
    }

    // Otherwise, treat it as a container path relative to the workspaceRoot.
    const rel = path.relative(normalizedWorkspace, absolute);
    if (rel.startsWith("..")) {
      throw new Error(`path ${absolute} is outside workspace root`);
    }
    return rel || ".";
  };

  const fileAdapter: FileAdapter = {
    readTextFile: async (p: string) => {
      const rel = toRelative(p);
      return await executor.readTextFile(rel);
    },
    writeTextFile: async (p: string, content: string) => {
      const rel = toRelative(p);
      await executor.writeTextFile(rel, content);
    },
    toString: () => `FileAdapter(${executor})`,
  };

  const terminalAdapter: TerminalAdapter = {
    toString: () => `TerminalAdapter(${executor})`,
    async start(options: TerminalStartOptions, onOutput) {
      const { command, args, cwd, env, limit } = options;
      const joined =
        args && Array.isArray(args) && args.length > 0
          ? `${command} ${args.join(" ")}`
          : command;
      const relCwd = cwd ? toRelative(cwd) : undefined;
      const result = await executor.exec(joined, {
        cwd: relCwd,
        env,
      });
      let output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      let truncated = false;
      if (limit != null && output.length > limit) {
        output = output.slice(output.length - limit);
        truncated = true;
      }
      await onOutput(output);
      const exitStatus = {
        exitCode: result.exitCode ?? undefined,
        signal: result.signal,
      };
      return {
        async kill() {
          /* no-op for non-streaming exec */
        },
        async waitForExit() {
          return { exitStatus, output, truncated };
        },
      };
    },
  };

  return {
    workspaceRoot,
    fileAdapter,
    terminalAdapter,
    commandHandlers: {
      bash: shellHandler,
      sh: shellHandler,
      zsh: shellHandler,
    },
  };
}

async function ensureAgent(
  useNativeTerminal: boolean,
  bindings: ExecutorAdapters,
): Promise<AcpAgent> {
  const key = `${useNativeTerminal ? "native" : "proxy"}:${bindings.workspaceRoot}`;
  const existing = agents.get(key);
  if (existing != null) return existing;
  const mode = process.env.COCALC_ACP_MODE;
  logger.debug("ensureAgent", { mode, useNativeTerminal });
  if (mode === "echo") {
    logger.debug("ensureAgent: creating echo agent");
    const echo = new EchoAgent();
    agents.set(key, echo);
    return echo;
  }
  try {
    logger.debug("ensureAgent: creating codex exec agent");
    const created = await CodexExecAgent.create({
      binaryPath: process.env.COCALC_CODEX_BIN,
      cwd: bindings.workspaceRoot ?? process.cwd(),
    });
    logger.info("codex-exec agent ready", { key });
    agents.set(key, created);
    return created;
  } catch (err) {
    // Fail loudly: use an echo agent that emits an explicit error to the user.
    logger.error("failed to start codex-exec agent; using echo agent", err);
    const echo = new EchoAgent(
      `ERROR: codex-exec failed to start (${(err as Error)?.message ?? "unknown error"})`,
    );
    agents.set(key, echo);
    return echo;
  }
}

export async function evaluate({
  stream,
  ...request
}: AcpRequest & {
  stream: (payload?: AcpStreamPayload | null) => Promise<void>;
}): Promise<void> {
  const reqId = randomUUID();
  const startedAt = Date.now();
  const { config } = request;
  const projectId = request.chat?.project_id ?? request.project_id;
  const sessionMode = resolveCodexSessionMode(config);
  const workspaceRoot = resolveWorkspaceRoot(config);
  logger.debug("evaluate: start", {
    reqId,
    session_id: request.session_id,
    chat: request.chat,
    projectId,
    config,
    sessionMode,
    workspaceRoot,
  });
  if (!projectId) {
    throw Error("project_id must be set");
  }
  const executor: AcpExecutor = preferContainerExecutor()
    ? new ContainerExecutor({
        projectId,
        workspaceRoot,
        conatClient: conatClient!,
      })
    : new LocalExecutor(workspaceRoot);
  const effectiveConfig = {
    ...(config ?? {}),
    workingDirectory: workspaceRoot,
  };
  const useContainer = preferContainerExecutor();
  const hostRoot =
    useContainer && executor instanceof ContainerExecutor
      ? executor.getMountPoint()
      : workspaceRoot;
  // Container mode must always proxy terminals (useNativeTerminal=false) so ACP
  // routes commands through our adapter into the project container. In local
  // mode, respect "auto" behavior.
  const useNativeTerminal = useContainer ? false : sessionMode === "auto";
  logger.debug("evaluate: mode selection", {
    useContainer,
    workspaceRoot,
    project_id: projectId,
    useNativeTerminal,
  });
  if (useContainer && !conatClient) {
    throw Error("conat client must be initialized");
  }
  const bindings = buildExecutorAdapters(executor, workspaceRoot, hostRoot);
  const currentAgent = await ensureAgent(useNativeTerminal, bindings);
  const { prompt, cleanup } = await materializeBlobs(request.prompt ?? "");
  if (!conatClient) {
    throw Error("conat client must be initialized");
  }
  const chatWriter = request.chat
    ? new ChatStreamWriter({
        metadata: request.chat,
        client: conatClient,
        approverAccountId: request.account_id,
        sessionKey: request.session_id,
        workspaceRoot,
      })
    : null;

  let wrappedStream;
  stream({ type: "status", state: "init" });
  if (chatWriter != null) {
    await chatWriter.waitUntilReady();
    if (chatWriter.isClosed()) {
      throw Error(
        `failed to initialize chat writer -- ${chatWriter.syncdbError}`,
      );
    }
    wrappedStream = async (payload?: AcpStreamPayload | null) => {
      try {
        await chatWriter.handle(payload);
      } catch (err) {
        logger.warn("chat writer handle failed", err);
      }
      if (payload == null) {
        stream(null);
      }
    };
  } else {
    wrappedStream = stream;
  }

  try {
    stream({ type: "status", state: "running" });
    logger.debug("evaluate: running", { reqId });
    try {
      await currentAgent.evaluate({
        ...request,
        prompt,
        config: effectiveConfig,
        stream: wrappedStream,
      });
      logger.debug("evaluate: done", { reqId });
    } catch (err) {
      logger.warn("evaluate: agent failed", { reqId, err });
      try {
        await wrappedStream({
          type: "error",
          error: `codex agent failed: ${(err as Error)?.message ?? err}`,
        });
      } catch (streamErr) {
        logger.warn("evaluate: failed to stream error", streamErr);
      }
    }
  } finally {
    const elapsedMs = Date.now() - startedAt;
    logger.debug("evaluate: end", { reqId, elapsedMs });
    // TODO: we might not want to immediately close, since there is
    // overhead in creating the syncdoc each time.
    chatWriter?.dispose();
    await cleanup();
  }
}

export async function init(client: ConatClient): Promise<void> {
  logger.debug(
    "initializing ACP conat server",
    "preferContainerExecutor =",
    preferContainerExecutor(),
  );
  // IMPORTANT: initialize sqlite with the same hub.db path used by hub api,
  // before any ACP queue/lease tables are touched. Otherwise ACP can
  // accidentally lock the sqlite module onto a fallback cwd-relative file.
  const sqliteFilename = path.join(data, "hub.db");
  initDatabase({ filename: sqliteFilename });
  conatClient = client;
  process.once("exit", () => {
    for (const agent of agents.values()) {
      agent
        .dispose?.()
        .catch((err) => {
          logger.warn("failed to dispose ACP agent", err);
        })
        .finally(() => undefined);
    }
  });
  blobStore = getBlobstore(client);
  await recoverOrphanedAcpTurns(client);
  await initConatAcp(
    {
      evaluate,
      interrupt: handleInterruptRequest,
      forkSession: handleForkSessionRequest,
    },
    client,
  );
}

type BlobReference = {
  url: string;
  uuid: string;
  filename?: string;
};

async function materializeBlobs(
  prompt: string,
): Promise<{ prompt: string; cleanup: () => Promise<void> }> {
  if (!blobStore) {
    return { prompt, cleanup: async () => {} };
  }
  const refs = extractBlobReferences(prompt);
  if (!refs.length) {
    return { prompt, cleanup: async () => {} };
  }
  const unique = dedupeRefs(refs);
  if (!unique.length) {
    return { prompt, cleanup: async () => {} };
  }
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `cocalc-blobs-${randomUUID()}-`),
  );
  const attachments: { url: string; path: string }[] = [];
  try {
    for (const ref of unique) {
      try {
        const data = await blobStore!.get(ref.uuid);
        if (data == null) continue;
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const safeName = buildSafeFilename(ref);
        const filePath = path.join(tempDir, safeName);
        await fs.writeFile(filePath, buffer);
        attachments.push({ url: ref.url, path: filePath });
      } catch (err) {
        logger.warn("failed to materialize blob", { ref, err });
      }
    }
    if (!attachments.length) {
      await fs.rm(tempDir, { recursive: true, force: true });
      return { prompt, cleanup: async () => {} };
    }
    const info = attachments
      .map(
        (att, idx) =>
          `Attachment ${idx + 1}: saved at ${att.path} (source ${att.url})`,
      )
      .join("\n");
    const augmented = `${prompt}\n\nAttachments saved locally:\n${info}\n`;
    return {
      prompt: augmented,
      cleanup: async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    logger.warn("failed to prepare attachments", err);
    await fs.rm(tempDir, { recursive: true, force: true });
    return { prompt, cleanup: async () => {} };
  }
}

function dedupeRefs(refs: BlobReference[]): BlobReference[] {
  const seen = new Set<string>();
  const result: BlobReference[] = [];
  for (const ref of refs) {
    if (seen.has(ref.uuid)) continue;
    seen.add(ref.uuid);
    result.push(ref);
  }
  return result;
}

function buildSafeFilename(ref: BlobReference): string {
  const baseName = sanitizeFilename(ref.filename || ref.uuid);
  const extension = path.extname(baseName);
  const finalName =
    extension.length > 0 ? baseName : `${baseName || ref.uuid}.bin`;
  return `${ref.uuid}-${finalName}`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

function extractBlobReferences(prompt: string): BlobReference[] {
  const urls = new Set<string>();
  const markdown = /!\[[^\]]*\]\(([^)]+\/blobs\/[^)]+)\)/gi;
  const html = /<img[^>]+src=["']([^"']+\/blobs\/[^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = markdown.exec(prompt)) != null) {
    urls.add(match[1]);
  }
  while ((match = html.exec(prompt)) != null) {
    urls.add(match[1]);
  }
  const refs: BlobReference[] = [];
  for (const url of urls) {
    const parsed = parseBlobReference(url);
    if (parsed?.uuid) {
      refs.push(parsed);
    }
  }
  return refs;
}

function parseBlobReference(target: string): BlobReference | undefined {
  const trimmed = target.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(
      trimmed,
      trimmed.startsWith("http://") || trimmed.startsWith("https://")
        ? undefined
        : "http://placeholder",
    );
    if (!url.pathname.includes("/blobs/")) {
      return undefined;
    }
    const uuid = url.searchParams.get("uuid");
    if (!uuid) return undefined;
    const filename = path.basename(url.pathname);
    return {
      url: trimmed,
      uuid,
      filename,
    };
  } catch {
    return undefined;
  }
}

async function handleInterruptRequest(
  request: AcpInterruptRequest,
): Promise<void> {
  const writer = findChatWriter({
    threadId: request.threadId,
    chat: request.chat,
  });

  const candidateIds: Set<string> = new Set();
  if (request.threadId) {
    candidateIds.add(request.threadId);
  }
  writer?.getKnownThreadIds().forEach((id) => candidateIds.add(id));

  let handled = false;
  for (const id of candidateIds) {
    if (!id) continue;
    if (await interruptCodexSession(id)) {
      handled = true;
      break;
    }
  }

  if (!handled) {
    throw Error("unable to interrupt codex session");
  }
  writer?.notifyInterrupted(INTERRUPT_STATUS_TEXT);
}

async function handleForkSessionRequest(
  request: AcpForkSessionRequest,
): Promise<{ sessionId: string }> {
  if (!isValidUUID(request.sessionId)) {
    throw Error("sessionId must be a valid uuid");
  }
  const sessionsRoot = getSessionsRoot();
  if (!sessionsRoot) {
    throw Error("codex sessions directory not configured");
  }
  const newSessionId = request.newSessionId ?? randomUUID();
  if (!isValidUUID(newSessionId)) {
    throw Error("newSessionId must be a valid uuid");
  }
  await forkSession(request.sessionId, newSessionId, sessionsRoot);
  return { sessionId: newSessionId };
}

async function interruptCodexSession(threadId: string): Promise<boolean> {
  for (const agent of agents.values()) {
    if (
      "interrupt" in agent &&
      typeof (agent as any).interrupt === "function"
    ) {
      try {
        if (await (agent as any).interrupt(threadId)) {
          return true;
        }
      } catch (err) {
        logger.warn("failed to interrupt codex session", {
          threadId,
          err,
        });
      }
    }
  }
  return false;
}
