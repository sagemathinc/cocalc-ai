/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { Client as ConatClient } from "@cocalc/conat/core/client";
import type { DStream } from "@cocalc/conat/sync/dstream";
import { isValidUUID } from "@cocalc/util/misc";
import type {
  ChatSnapshot,
  HeadlessChatClient,
  ProjectedChatMessage,
  ProjectedChatThread,
} from "./types";

export const PROJECT_CHAT_SESSION_SERVICE = "project-chat-session";
export const PROJECT_CHAT_SESSION_NOT_FOUND =
  "project chat session was not found";
const DEFAULT_TIMEOUT_MS = 60_000;
const OPERATION_TIMEOUT_MS = 10 * 60_000;
const HEARTBEAT_MS = 5 * 60_000;

export type ProjectChatSessionOpenPhase =
  | "service_open_start"
  | "service_open_done"
  | "stream_open_start"
  | "stream_open_done";

export interface ProjectChatSessionOpenResponse {
  session_id: string;
  stream_name: string;
  snapshot: ChatSnapshot;
}

export type ProjectChatSessionStreamEvent =
  | { kind: "snapshot"; snapshot: ChatSnapshot }
  | {
      kind: "update";
      revision: number;
      connection: ChatSnapshot["connection"];
      ready: boolean;
      error?: string;
      selected_thread_id?: string;
      threads?: ProjectedChatThread[];
      messages: ProjectedChatMessage[];
      removed_message_ids?: string[];
      message_window?: ChatSnapshot["message_window"];
    };

export interface CreateRemoteHeadlessChatClientOptions {
  account_id: string;
  project_id: string;
  path: string;
  projectHostClient: ConatClient;
  selected_thread_id: string;
  initial_message_limit?: number;
  readyTimeoutMs?: number;
  onOpenPhase?: (phase: ProjectChatSessionOpenPhase) => void;
}

export function projectChatSessionSubject({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): string {
  if (!isValidUUID(account_id) || !isValidUUID(project_id)) {
    throw new Error(
      "project chat session requires valid account and project ids",
    );
  }
  return [
    "services",
    `account-${account_id}`,
    "_",
    project_id,
    "_",
    PROJECT_CHAT_SESSION_SERVICE,
  ].join(".");
}

export class RemoteHeadlessChatClient implements HeadlessChatClient {
  private readonly options: CreateRemoteHeadlessChatClientOptions;
  private selectedThreadId: string;
  private messageLimit: number;
  private sessionId?: string;
  private stream?: DStream<ProjectChatSessionStreamEvent>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private openPromise?: Promise<void>;
  private reconnectPromise?: Promise<void>;
  private closed = true;
  private revision = 0;
  private serverRevision = 0;
  private listeners = new Set<(snapshot: ChatSnapshot) => void>();
  private snapshot: ChatSnapshot;

  constructor(options: CreateRemoteHeadlessChatClientOptions) {
    this.options = options;
    this.selectedThreadId = options.selected_thread_id;
    this.messageLimit = options.initial_message_limit ?? 30;
    this.snapshot = {
      revision: 0,
      connection: "closed",
      ready: false,
      project_id: options.project_id,
      path: options.path,
      selected_thread_id: options.selected_thread_id,
      threads: [],
      messages: [],
    };
  }

  async open(): Promise<void> {
    this.closed = false;
    await this.ensureOpen();
  }

  private async ensureOpen(): Promise<void> {
    if (this.sessionId) return;
    if (this.openPromise) return await this.openPromise;
    this.openPromise = this.openSession();
    try {
      await this.openPromise;
    } finally {
      this.openPromise = undefined;
    }
  }

  private async openSession(): Promise<void> {
    this.setConnection("connecting");
    try {
      this.options.onOpenPhase?.("service_open_start");
      const opened = await this.call<ProjectChatSessionOpenResponse>(
        "open",
        [
          {
            path: this.options.path,
            selected_thread_id: this.selectedThreadId,
            limit: this.messageLimit,
          },
        ],
        this.options.readyTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      this.options.onOpenPhase?.("service_open_done");
      this.sessionId = opened.session_id;
      this.applySnapshot(opened.snapshot, true);
      this.options.onOpenPhase?.("stream_open_start");
      const stream =
        await this.options.projectHostClient.sync.dstream<ProjectChatSessionStreamEvent>(
          {
            project_id: this.options.project_id,
            name: opened.stream_name,
            ephemeral: true,
            noCache: true,
            noInventory: true,
          },
        );
      this.options.onOpenPhase?.("stream_open_done");
      if (this.sessionId !== opened.session_id) {
        stream.close();
        return;
      }
      this.stream = stream;
      stream.on("change", this.handleEvent);
      stream.on("disconnected", this.handleDisconnected);
      stream.on("recovered", this.handleRecovered);
      for (const event of stream.getAll()) this.handleEvent(event);
      this.heartbeat = setInterval(() => {
        if (!this.sessionId) return;
        void this.withSessionRecovery(() =>
          this.call("touch", [{ session_id: this.requireSession() }]),
        ).catch(() => this.setConnection("disconnected"));
      }, HEARTBEAT_MS);
    } catch (err) {
      await this.closeSession(false);
      this.setConnection(
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
    this.snapshot = {
      ...this.snapshot,
      revision: ++this.revision,
      selected_thread_id: normalized,
    };
    this.emit();
    void this.withSessionRecovery(() =>
      this.call("selectThread", [
        { session_id: this.requireSession(), thread_id: normalized },
      ]),
    ).catch((err) => {
      this.setConnection(
        "error",
        err instanceof Error ? err.message : `${err}`,
      );
    });
  }

  async sendToExistingCodexThread(opts: {
    thread_id: string;
    text: string;
  }): Promise<{ message_id: string; thread_id: string }> {
    return await this.withSessionRecovery(() =>
      this.call(
        "send",
        [{ session_id: this.requireSession(), ...opts }],
        OPERATION_TIMEOUT_MS,
      ),
    );
  }

  async interrupt(thread_id: string): Promise<void> {
    await this.withSessionRecovery(() =>
      this.call(
        "interrupt",
        [{ session_id: this.requireSession(), thread_id }],
        OPERATION_TIMEOUT_MS,
      ),
    );
  }

  async loadOlderMessages(limit: number): Promise<void> {
    this.messageLimit = limit;
    const snapshot = await this.withSessionRecovery(() =>
      this.call<ChatSnapshot>("setLimit", [
        { session_id: this.requireSession(), limit: this.messageLimit },
      ]),
    );
    this.applySnapshot(snapshot, true);
  }

  async reconnect(_reason: string): Promise<void> {
    if (this.closed) return;
    if (this.reconnectPromise) return await this.reconnectPromise;
    this.reconnectPromise = (async () => {
      await this.closeSession(false);
      if (!this.closed) await this.ensureOpen();
    })();
    try {
      await this.reconnectPromise;
    } finally {
      this.reconnectPromise = undefined;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.reconnectPromise?.catch(() => undefined);
    await this.openPromise?.catch(() => undefined);
    await this.closeSession(true);
    this.listeners.clear();
  }

  private readonly handleEvent = (event: ProjectChatSessionStreamEvent) => {
    if (event?.kind === "snapshot") {
      this.applySnapshot(event.snapshot);
      return;
    }
    if (event?.kind !== "update") return;
    if (event.revision <= this.serverRevision) return;
    this.serverRevision = event.revision;
    if (event.selected_thread_id) {
      this.selectedThreadId = event.selected_thread_id;
    }
    if (event.message_window?.limit) {
      this.messageLimit = event.message_window.limit;
    }
    const messages = new Map(
      this.snapshot.messages.map((message) => [message.message_id, message]),
    );
    for (const id of event.removed_message_ids ?? []) messages.delete(id);
    for (const message of event.messages)
      messages.set(message.message_id, message);
    this.snapshot = {
      ...this.snapshot,
      revision: Math.max(++this.revision, event.revision),
      connection: event.connection,
      ready: event.ready,
      error: event.error,
      selected_thread_id: event.selected_thread_id,
      threads: event.threads ?? this.snapshot.threads,
      messages: [...messages.values()].sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          a.message_id.localeCompare(b.message_id),
      ),
      message_window: event.message_window ?? this.snapshot.message_window,
    };
    this.emit();
  };

  private readonly handleDisconnected = () =>
    this.setConnection("disconnected");
  private readonly handleRecovered = () => {
    void this.reconnect("project-chat-stream-recovered").catch(() => undefined);
  };

  private applySnapshot(snapshot: ChatSnapshot, force = false): void {
    if (!force && snapshot.revision <= this.serverRevision) return;
    this.serverRevision = force
      ? snapshot.revision
      : Math.max(this.serverRevision, snapshot.revision);
    if (snapshot.selected_thread_id) {
      this.selectedThreadId = snapshot.selected_thread_id;
    }
    if (snapshot.message_window?.limit) {
      this.messageLimit = snapshot.message_window.limit;
    }
    this.revision = Math.max(this.revision + 1, snapshot.revision);
    this.snapshot = {
      ...snapshot,
      revision: this.revision,
      connection: snapshot.ready ? "connected" : snapshot.connection,
    };
    this.emit();
  }

  private setConnection(
    connection: ChatSnapshot["connection"],
    error?: string,
  ): void {
    this.snapshot = {
      ...this.snapshot,
      revision: ++this.revision,
      connection,
      ready: connection === "connected" && this.snapshot.ready,
      error,
    };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private requireSession(): string {
    if (!this.sessionId) throw new Error("Chat is not ready.");
    return this.sessionId;
  }

  private async withSessionRecovery<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      if (!this.isMissingSessionError(err) || this.closed) throw err;
      await this.reconnect("project-chat-session-expired");
      return await operation();
    }
  }

  private isMissingSessionError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : `${err}`;
    return message.includes(PROJECT_CHAT_SESSION_NOT_FOUND);
  }

  private async closeSession(final: boolean): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const session_id = this.sessionId;
    this.sessionId = undefined;
    const stream = this.stream;
    this.stream = undefined;
    stream?.removeListener("change", this.handleEvent);
    stream?.removeListener("disconnected", this.handleDisconnected);
    stream?.removeListener("recovered", this.handleRecovered);
    stream?.close();
    if (session_id) {
      await this.call("close", [{ session_id }], 10_000).catch(() => undefined);
    }
    this.setConnection(final ? "closed" : "disconnected");
  }

  private async call<T = void>(
    name: string,
    args: any[] = [],
    timeout = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const response = await this.options.projectHostClient.request(
      projectChatSessionSubject(this.options),
      [name, args],
      { timeout, waitForInterest: true },
    );
    return response.data as T;
  }
}

export function createRemoteHeadlessChatClient(
  options: CreateRemoteHeadlessChatClientOptions,
): HeadlessChatClient {
  return new RemoteHeadlessChatClient(options);
}
