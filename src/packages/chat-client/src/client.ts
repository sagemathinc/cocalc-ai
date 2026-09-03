/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import {
  buildThreadConfigRecord,
  CHAT_PRIMARY_KEYS,
  CHAT_STRING_COLS,
  type CodexThreadConfig,
} from "@cocalc/chat";
import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import type { DStream } from "@cocalc/conat/sync/dstream";
import { immerdb, type ImmerDB } from "@cocalc/conat/sync-doc/immer-db";

import { mergeAcpActivityEvents, projectAcpActivityMarkdown } from "./activity";
import { projectChatRows } from "./messages";
import {
  ChatSendPipeline,
  type ChatSendPipelineOptions,
  type ChatSendTransport,
} from "./send";
import type {
  ChatSnapshot,
  HeadlessChatClient,
  ProjectedChatMessage,
} from "./types";

type ActivityStream = DStream<AcpStreamMessage | AcpStreamMessage[]>;

type ActivityRecord = {
  signature: string;
  state: "loading" | "ready" | "error";
  events: AcpStreamMessage[];
  error?: string;
  persistedLoaded: boolean;
  finalLoaded: boolean;
  loading?: Promise<void>;
  streamName?: string;
  streamFailed?: boolean;
  stream?: ActivityStream;
  streamListener?: (payload: AcpStreamMessage | AcpStreamMessage[]) => void;
};

const MAX_RECENT_ACTIVITY_LOGS = 20;

export interface CreateHeadlessChatClientOptions {
  account_id: string;
  project_id: string;
  path: string;
  projectHostClient: ConatClient;
  selected_thread_id?: string;
  readyTimeoutMs?: number;
  idGenerator?: () => string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  sendTransport?: ChatSendTransport;
  ackTimeoutMs?: number;
  ackMaxAttempts?: number;
  ackBackoffMs?: number;
  codexCompletionNotificationDefault?: boolean;
  activityLoadPolicy?: "recent" | "live-preview-only";
}

export class CoCalcHeadlessChatClient implements HeadlessChatClient {
  private readonly options: CreateHeadlessChatClientOptions;
  private db?: ImmerDB;
  private sendPipeline?: ChatSendPipeline;
  private revision = 0;
  private selectedThreadId?: string;
  private listeners = new Set<(snapshot: ChatSnapshot) => void>();
  private snapshot: ChatSnapshot;
  private readonly onChange = () => this.rebuild();
  private readonly onDisconnected = () => this.updateConnection("disconnected");
  private readonly onConnected = () => this.updateConnection("connected");
  private readonly activity = new Map<string, ActivityRecord>();
  private activityGeneration = 0;

  constructor(options: CreateHeadlessChatClientOptions) {
    if (!options.account_id || !options.project_id || !options.path.trim()) {
      throw new Error("account_id, project_id, and chat path are required");
    }
    this.options = options;
    this.selectedThreadId = options.selected_thread_id?.trim() || undefined;
    this.snapshot = {
      revision: 0,
      connection: "closed",
      ready: false,
      project_id: options.project_id,
      path: options.path,
      selected_thread_id: this.selectedThreadId,
      threads: [],
      messages: [],
    };
  }

  async open(): Promise<void> {
    if (this.db?.isReady()) return;
    this.updateConnection("connecting");
    const db = immerdb({
      client: this.options.projectHostClient,
      project_id: this.options.project_id,
      path: this.options.path,
      primary_keys: [...CHAT_PRIMARY_KEYS],
      string_cols: [...CHAT_STRING_COLS],
      change_throttle: 50,
      patch_interval: 50,
      cursors: true,
      persistent: true,
    });
    this.db = db;
    db.on("change", this.onChange);
    this.options.projectHostClient.on("disconnected", this.onDisconnected);
    this.options.projectHostClient.on("connected", this.onConnected);
    try {
      await this.waitUntilReady(db);
      const sendOptions: ChatSendPipelineOptions = {
        account_id: this.options.account_id,
        project_id: this.options.project_id,
        path: this.options.path,
        db,
        acpClient: this.options.projectHostClient,
        idGenerator: this.options.idGenerator,
        now: this.options.now,
        sleep: this.options.sleep,
        transport: this.options.sendTransport,
        ackTimeoutMs: this.options.ackTimeoutMs,
        ackMaxAttempts: this.options.ackMaxAttempts,
        ackBackoffMs: this.options.ackBackoffMs,
        codexCompletionNotificationDefault:
          this.options.codexCompletionNotificationDefault,
      };
      this.sendPipeline = new ChatSendPipeline(sendOptions);
      this.rebuild();
    } catch (err) {
      this.updateConnection(
        "error",
        err instanceof Error ? err.message : `${err}`,
      );
      throw err;
    }
  }

  getSnapshot(): ChatSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: ChatSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  selectThread(thread_id: string): void {
    const normalized = thread_id.trim();
    if (!normalized || normalized === this.selectedThreadId) return;
    this.selectedThreadId = normalized;
    this.rebuild();
  }

  async createCodexThread(opts: {
    thread_id: string;
    name?: string;
    acp_config: import("@cocalc/chat").CodexThreadConfig;
  }): Promise<{ thread_id: string }> {
    const db = this.db;
    const threadId = opts.thread_id.trim();
    if (!db?.isReady()) throw new Error("Chat is not ready.");
    if (!threadId) throw new Error("thread_id is required");
    const rows = db.get();
    if (
      Array.isArray(rows) &&
      rows.some(
        (row) =>
          row?.event === "chat-thread-config" && row?.thread_id === threadId,
      )
    ) {
      throw new Error(`thread '${threadId}' already exists`);
    }
    db.set(
      buildThreadConfigRecord({
        acp_config: opts.acp_config,
        agent_kind: "acp",
        agent_mode: "interactive",
        agent_model: opts.acp_config.model,
        name: opts.name?.trim() || "Codex chat",
        thread_id: threadId,
        updated_at: new Date().toISOString(),
        updated_by: this.options.account_id,
      }),
    );
    db.commit({ emitChangeImmediately: true });
    await db.save();
    this.selectedThreadId = threadId;
    this.rebuild();
    return { thread_id: threadId };
  }

  async sendToExistingCodexThread(opts: {
    thread_id: string;
    text: string;
  }): Promise<{ message_id: string; thread_id: string }> {
    if (!this.sendPipeline) throw new Error("Chat is not ready.");
    return await this.sendPipeline.send(opts);
  }

  async sendGuidanceToCodexThread(opts: {
    thread_id: string;
    text: string;
  }): Promise<{ message_id: string; thread_id: string }> {
    if (!this.sendPipeline) throw new Error("Chat is not ready.");
    return await this.sendPipeline.sendGuidance(opts);
  }

  async updateCodexThreadConfig(opts: {
    thread_id: string;
    acp_config: CodexThreadConfig;
  }): Promise<void> {
    const db = this.db;
    const threadId = opts.thread_id.trim();
    if (!db?.isReady()) throw new Error("Chat is not ready.");
    const allRows = db.get();
    const existing = Array.isArray(allRows)
      ? allRows.find(
          (row) =>
            row?.event === "chat-thread-config" && row?.thread_id === threadId,
        )
      : undefined;
    if (
      !existing ||
      (existing.agent_kind !== "acp" && existing.acp_config == null)
    ) {
      throw new Error("The selected thread is not an existing Codex thread.");
    }
    db.set({
      ...existing,
      acp_config: opts.acp_config,
      agent_model: opts.acp_config.model ?? existing.agent_model,
      updated_at: new Date().toISOString(),
      updated_by: this.options.account_id,
    });
    this.commitOrThrow(db);
    await db.save();
    this.rebuild();
  }

  async interrupt(thread_id: string): Promise<void> {
    if (!this.sendPipeline) throw new Error("Chat is not ready.");
    await this.sendPipeline.interrupt(thread_id);
  }

  async reconnect(_reason: string): Promise<void> {
    await this.closeDb();
    await this.open();
  }

  async close(): Promise<void> {
    await this.closeDb();
    this.listeners.clear();
    this.updateConnection("closed");
  }

  private async closeDb(): Promise<void> {
    this.activityGeneration += 1;
    for (const record of this.activity.values()) {
      this.closeActivityStream(record);
    }
    this.activity.clear();
    this.options.projectHostClient.removeListener(
      "disconnected",
      this.onDisconnected,
    );
    this.options.projectHostClient.removeListener(
      "connected",
      this.onConnected,
    );
    const db = this.db;
    this.db = undefined;
    this.sendPipeline = undefined;
    db?.removeListener("change", this.onChange);
    await db?.close();
  }

  private commitOrThrow(db: ImmerDB): void {
    if (!db.commit({ emitChangeImmediately: true })) {
      throw new Error("Unable to commit the chat change.");
    }
  }

  private async waitUntilReady(db: ImmerDB): Promise<void> {
    if (db.isReady()) return;
    const timeoutMs = this.options.readyTimeoutMs ?? 30_000;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        db.removeListener("ready", onReady);
        db.removeListener("error", onError);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (err: unknown) => {
        cleanup();
        reject(err);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out opening chat '${this.options.path}'.`));
      }, timeoutMs);
      db.once("ready", onReady);
      db.once("error", onError);
    });
  }

  private rebuild(): void {
    const db = this.db;
    if (!db?.isReady()) return;
    const rows = db.get();
    const projected = projectChatRows(
      Array.isArray(rows) ? rows : [],
      this.selectedThreadId,
    );
    if (
      !this.selectedThreadId ||
      !projected.threads.some(
        (thread) => thread.thread_id === this.selectedThreadId,
      )
    ) {
      this.selectedThreadId = projected.threads[0]?.thread_id;
    }
    const current = projectChatRows(
      Array.isArray(rows) ? rows : [],
      this.selectedThreadId,
    );
    this.reconcileActivity(current.messages);
    this.snapshot = {
      revision: ++this.revision,
      connection: "connected",
      ready: true,
      project_id: this.options.project_id,
      path: this.options.path,
      selected_thread_id: this.selectedThreadId,
      threads: current.threads,
      messages: this.decorateActivity(current.messages),
    };
    this.emit();
  }

  private updateConnection(
    connection: ChatSnapshot["connection"],
    error?: string,
  ): void {
    this.snapshot = {
      ...this.snapshot,
      revision: ++this.revision,
      connection,
      ready: connection === "connected" && this.db?.isReady() === true,
      error,
    };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private reconcileActivity(messages: ProjectedChatMessage[]): void {
    const candidates =
      this.options.activityLoadPolicy === "live-preview-only"
        ? messages.filter(
            ({ generating, acp_live_preview_stream }) =>
              generating && !!acp_live_preview_stream,
          )
        : messages
            .filter(
              ({ acp_log_store, acp_log_key }) => acp_log_store && acp_log_key,
            )
            .slice(-MAX_RECENT_ACTIVITY_LOGS);
    const activeMessageIds = new Set(
      candidates.map(({ message_id }) => message_id),
    );
    for (const [messageId, record] of this.activity) {
      if (activeMessageIds.has(messageId)) continue;
      this.closeActivityStream(record);
      this.activity.delete(messageId);
    }

    for (const message of candidates) {
      const previewOnly =
        this.options.activityLoadPolicy === "live-preview-only";
      if (
        previewOnly
          ? !message.acp_live_preview_stream
          : !message.acp_log_store || !message.acp_log_key
      ) {
        continue;
      }
      const signature = previewOnly
        ? `preview:${message.acp_live_preview_stream}`
        : `${message.acp_log_store}:${message.acp_log_key}`;
      let record = this.activity.get(message.message_id);
      if (record?.signature !== signature) {
        if (record) this.closeActivityStream(record);
        record = {
          signature,
          state: "loading",
          events: [],
          persistedLoaded: previewOnly,
          finalLoaded: previewOnly,
        };
        this.activity.set(message.message_id, record);
      }

      if (!previewOnly && !record.persistedLoaded) {
        void this.loadPersistedActivity(message, record, false);
      }
      if (
        message.generating &&
        message.acp_live_log_stream &&
        !record.streamFailed
      ) {
        void this.openActivityStream(message, record);
      } else {
        this.closeActivityStream(record);
      }
      if (!message.generating && !record.finalLoaded) {
        void this.loadPersistedActivity(message, record, true);
      }
    }
  }

  private decorateActivity(
    messages: ProjectedChatMessage[],
  ): ProjectedChatMessage[] {
    return messages.map((message) => {
      const record = this.activity.get(message.message_id);
      if (!record) return message;
      return {
        ...message,
        activity: {
          state: record.state,
          events: record.events,
          markdown: projectAcpActivityMarkdown(record.events),
          error: record.error,
        },
      };
    });
  }

  private async loadPersistedActivity(
    message: ProjectedChatMessage,
    record: ActivityRecord,
    final: boolean,
  ): Promise<void> {
    if (record.loading) return await record.loading;
    const generation = this.activityGeneration;
    const signature = record.signature;
    const load = async () => {
      if (final) {
        // The backend batches activity persistence; let the final batch land.
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      const kv = this.options.projectHostClient.sync.akv<AcpStreamMessage[]>({
        project_id: this.options.project_id,
        name: message.acp_log_store!,
      });
      try {
        const events = await kv.get(message.acp_log_key!);
        if (
          generation !== this.activityGeneration ||
          this.activity.get(message.message_id)?.signature !== signature
        ) {
          return;
        }
        if (Array.isArray(events)) {
          record.events = mergeAcpActivityEvents(record.events, events);
        }
        record.persistedLoaded = true;
        record.finalLoaded = final;
        record.state = "ready";
        record.error = undefined;
      } catch (err) {
        if (generation !== this.activityGeneration) return;
        record.state = record.events.length ? "ready" : "error";
        record.error = err instanceof Error ? err.message : `${err}`;
        if (final) record.finalLoaded = true;
      } finally {
        kv.close();
      }
    };
    record.loading = load().finally(() => {
      record.loading = undefined;
      this.rebuild();
    });
    await record.loading;
  }

  private async openActivityStream(
    message: ProjectedChatMessage,
    record: ActivityRecord,
  ): Promise<void> {
    const streamName =
      this.options.activityLoadPolicy === "live-preview-only"
        ? message.acp_live_preview_stream
        : message.acp_live_log_stream;
    if (!streamName || record.streamName === streamName) return;
    this.closeActivityStream(record);
    record.streamName = streamName;
    const generation = this.activityGeneration;
    const signature = record.signature;
    try {
      const stream = await this.options.projectHostClient.sync.dstream<
        AcpStreamMessage | AcpStreamMessage[]
      >({
        project_id: this.options.project_id,
        name: streamName,
        ephemeral: true,
        noCache: true,
        noInventory: true,
      });
      if (
        generation !== this.activityGeneration ||
        this.activity.get(message.message_id)?.signature !== signature ||
        record.streamName !== streamName
      ) {
        stream.close();
        return;
      }
      const listener = (payload: AcpStreamMessage | AcpStreamMessage[]) => {
        const incoming = Array.isArray(payload) ? payload : [payload];
        record.events = mergeAcpActivityEvents(record.events, incoming);
        record.state = "ready";
        record.error = undefined;
        this.rebuild();
      };
      record.stream = stream;
      record.streamFailed = false;
      record.streamListener = listener;
      stream.on("change", listener);
      const initial = stream
        .getAll()
        .flatMap((payload) => (Array.isArray(payload) ? payload : [payload]));
      if (initial.length) {
        record.events = mergeAcpActivityEvents(record.events, initial);
        record.state = "ready";
        this.rebuild();
      }
    } catch (err) {
      if (generation !== this.activityGeneration) return;
      record.streamName = undefined;
      record.streamFailed = true;
      if (!record.events.length) {
        record.state = "error";
        record.error = err instanceof Error ? err.message : `${err}`;
        this.rebuild();
      }
    }
  }

  private closeActivityStream(record: ActivityRecord): void {
    if (record.stream && record.streamListener) {
      record.stream.removeListener("change", record.streamListener);
    }
    record.stream?.close();
    record.stream = undefined;
    record.streamListener = undefined;
    record.streamName = undefined;
  }
}

export function createHeadlessChatClient(
  options: CreateHeadlessChatClientOptions,
): HeadlessChatClient {
  return new CoCalcHeadlessChatClient(options);
}
