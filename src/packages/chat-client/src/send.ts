/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import {
  buildAcpChatContext,
  buildChatMessageRecordV2,
  buildCodexAcpConfig,
  buildThreadStateRecord,
  normalizeCodexMention,
  type ChatMessage,
  type ChatThreadConfigRecord,
} from "@cocalc/chat";
import { interruptAcp, steerAcp, streamAcp } from "@cocalc/conat/ai/acp/client";
import type {
  AcpInterruptRequest,
  AcpInterruptResponse,
  AcpRequest,
  AcpSteerRequest,
  AcpSteerResponse,
  AcpStreamMessage,
} from "@cocalc/conat/ai/acp/types";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import type { ImmerDB } from "@cocalc/conat/sync-doc/immer-db";
import { uuid } from "@cocalc/util/misc";
import { resolveCodexCompletionNotificationEnabled } from "@cocalc/util/notification-preferences";

export const ACP_ACK_TIMEOUT_MS = 2 * 60 * 1000;
export const ACP_ACK_MAX_ATTEMPTS = 5;
export const ACP_ACK_BACKOFF_MS = 2000;

export interface ChatSendTransport {
  stream(
    request: AcpRequest,
    timeoutMs: number,
  ): AsyncIterable<AcpStreamMessage>;
  interrupt(request: AcpInterruptRequest): Promise<AcpInterruptResponse>;
  steer(request: AcpSteerRequest): Promise<AcpSteerResponse>;
}

export interface ChatSendPipelineOptions {
  account_id: string;
  project_id: string;
  path: string;
  db: ImmerDB;
  acpClient: ConatClient;
  idGenerator?: () => string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  transport?: ChatSendTransport;
  ackTimeoutMs?: number;
  ackMaxAttempts?: number;
  ackBackoffMs?: number;
  codexCompletionNotificationDefault?: boolean;
}

type MutableChatMessage = Omit<ChatMessage, "acp_state"> & {
  acp_state?: "sending" | "queue" | "sent" | "running" | "not-sent" | null;
  acp_prompt?: string;
  acp_send_mode?: "immediate";
  acp_interrupted?: boolean;
  acp_interrupted_text?: string;
};

function rows(db: ImmerDB): Record<string, any>[] {
  const value = db.get();
  return Array.isArray(value) ? value : [];
}

function latestThreadMessage(
  allRows: readonly Record<string, any>[],
  threadId: string,
): MutableChatMessage | undefined {
  return allRows
    .filter(
      (row): row is MutableChatMessage =>
        row.event === "chat" && row.thread_id === threadId,
    )
    .sort((a, b) => `${a.date}`.localeCompare(`${b.date}`))
    .at(-1);
}

function threadConfig(
  allRows: readonly Record<string, any>[],
  threadId: string,
): ChatThreadConfigRecord | undefined {
  return allRows.find(
    (row) => row.event === "chat-thread-config" && row.thread_id === threadId,
  ) as ChatThreadConfigRecord | undefined;
}

function inferSessionId(
  allRows: readonly Record<string, any>[],
  threadId: string,
): string | undefined {
  const configured =
    `${threadConfig(allRows, threadId)?.acp_config?.sessionId ?? ""}`.trim();
  if (configured) return configured;
  const candidates = allRows
    .filter((row) => row.event === "chat" && row.thread_id === threadId)
    .sort((a, b) => `${b.date}`.localeCompare(`${a.date}`));
  for (const row of candidates) {
    const sessionId = `${row.acp_thread_id ?? ""}`.trim();
    if (sessionId) return sessionId;
  }
  return undefined;
}

function isRetryableAcpAckError(error: unknown): boolean {
  const message = `${error ?? ""}`.toLowerCase();
  return (
    message.includes("without acknowledgement") ||
    message.includes("timed out") ||
    message.includes("timeout")
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function directTransport(
  client: ConatClient,
  accountId: string,
): ChatSendTransport {
  return {
    stream: (request, timeoutMs) =>
      streamAcp(
        { ...request, account_id: accountId },
        { timeout: timeoutMs },
        client,
      ),
    interrupt: (request) =>
      interruptAcp({ ...request, account_id: accountId }, client),
    steer: (request) => steerAcp({ ...request, account_id: accountId }, client),
  };
}

export class ChatSendPipeline {
  private readonly options: Required<
    Pick<
      ChatSendPipelineOptions,
      | "account_id"
      | "project_id"
      | "path"
      | "db"
      | "acpClient"
      | "ackTimeoutMs"
      | "ackMaxAttempts"
      | "ackBackoffMs"
    >
  > &
    Pick<
      ChatSendPipelineOptions,
      "idGenerator" | "now" | "sleep" | "codexCompletionNotificationDefault"
    >;
  private readonly transport: ChatSendTransport;
  private readonly pending = new Map<
    string,
    Promise<{ message_id: string; thread_id: string }>
  >();
  private readonly pendingGuidance = new Map<
    string,
    Promise<{ message_id: string; thread_id: string }>
  >();
  private lastMessageMs = 0;

  constructor(options: ChatSendPipelineOptions) {
    this.options = {
      ...options,
      ackTimeoutMs: options.ackTimeoutMs ?? ACP_ACK_TIMEOUT_MS,
      ackMaxAttempts: options.ackMaxAttempts ?? ACP_ACK_MAX_ATTEMPTS,
      ackBackoffMs: options.ackBackoffMs ?? ACP_ACK_BACKOFF_MS,
    };
    this.transport =
      options.transport ??
      directTransport(options.acpClient, options.account_id);
  }

  send(opts: {
    thread_id: string;
    text: string;
  }): Promise<{ message_id: string; thread_id: string }> {
    const threadId = opts.thread_id.trim();
    const text = opts.text.trim();
    if (!threadId || !text) {
      return Promise.reject(
        new Error("thread_id and message text are required"),
      );
    }
    const existing = this.pending.get(threadId);
    if (existing) return existing;
    const operation = this.sendOnce({ threadId, text }).finally(() => {
      if (this.pending.get(threadId) === operation)
        this.pending.delete(threadId);
    });
    this.pending.set(threadId, operation);
    return operation;
  }

  sendGuidance(opts: {
    thread_id: string;
    text: string;
  }): Promise<{ message_id: string; thread_id: string }> {
    const threadId = opts.thread_id.trim();
    const text = opts.text.trim();
    if (!threadId || !text) {
      return Promise.reject(
        new Error("thread_id and guidance text are required"),
      );
    }
    const existing = this.pendingGuidance.get(threadId);
    if (existing) return existing;
    const operation = this.sendGuidanceOnce({ threadId, text }).finally(() => {
      if (this.pendingGuidance.get(threadId) === operation) {
        this.pendingGuidance.delete(threadId);
      }
    });
    this.pendingGuidance.set(threadId, operation);
    return operation;
  }

  async interrupt(threadIdValue: string): Promise<void> {
    const threadId = threadIdValue.trim();
    if (!threadId) throw new Error("thread_id is required");
    const allRows = rows(this.options.db);
    const target = [...allRows]
      .filter(
        (row) =>
          row.event === "chat" &&
          row.thread_id === threadId &&
          (row.generating === true || row.acp_state === "running"),
      )
      .sort((a, b) => `${a.date}`.localeCompare(`${b.date}`))
      .at(-1) as MutableChatMessage | undefined;
    const sessionId = inferSessionId(allRows, threadId) ?? threadId;
    const result = await this.transport.interrupt({
      project_id: this.options.project_id,
      account_id: this.options.account_id,
      threadId: sessionId,
      chat: target
        ? buildAcpChatContext({
            project_id: this.options.project_id,
            path: this.options.path,
            sender_id: target.sender_id,
            messageDate: new Date(target.date),
            message_id: target.message_id,
            thread_id: threadId,
          })
        : undefined,
    });
    if (!result.ok && result.state !== "missing") {
      throw new Error(`Codex interrupt was not accepted (${result.state}).`);
    }
    if (
      target &&
      ["interrupted", "repaired", "missing"].includes(result.state)
    ) {
      this.options.db.set({
        ...target,
        generating: false,
        acp_state: null,
        acp_interrupted: true,
        acp_interrupted_text:
          result.state === "missing"
            ? "Conversation interrupted locally after the backend confirmed that no running session exists."
            : "Conversation interrupted.",
      });
      this.options.db.delete({
        event: "chat-thread-state",
        thread_id: threadId,
      });
      this.options.db.set(
        buildThreadStateRecord({
          thread_id: threadId,
          state: "interrupted",
          active_message_id: target.message_id,
          updated_at: this.now(),
        }),
      );
      this.commitOrThrow();
      await this.options.db.save();
    }
  }

  private async sendOnce({
    threadId,
    text,
  }: {
    threadId: string;
    text: string;
  }): Promise<{ message_id: string; thread_id: string }> {
    if (!this.options.db.isReady()) {
      throw new Error("Chat is not ready.");
    }
    const allRows = rows(this.options.db);
    const configRow = threadConfig(allRows, threadId);
    if (
      !configRow ||
      (configRow.agent_kind !== "acp" && configRow.acp_config == null)
    ) {
      throw new Error("The selected thread is not an existing Codex thread.");
    }
    const previous = latestThreadMessage(allRows, threadId);
    const date = this.nextDate(allRows);
    const messageId = this.id();
    const message = {
      ...buildChatMessageRecordV2({
        sender_id: this.options.account_id,
        date,
        historyEntryDate: date.toISOString(),
        prevHistory: [],
        content: text,
        generating: false,
        message_id: messageId,
        thread_id: threadId,
        parent_message_id: previous?.message_id,
      }),
      acp_prompt: text,
      acp_state: "sending" as const,
    };
    this.options.db.set(message);
    this.commitOrThrow();
    await this.options.db.save();

    const sessionId = inferSessionId(allRows, threadId) ?? threadId;
    const assistantMessageId = this.id();
    const assistantDate = this.nextDate([...allRows, message]);
    const senderId = configRow.agent_model || "openai-codex-agent";
    const request: AcpRequest = {
      project_id: this.options.project_id,
      account_id: this.options.account_id,
      prompt: text,
      session_id: sessionId,
      config: buildCodexAcpConfig({
        path: this.options.path,
        config: {
          ...(configRow.acp_config ?? {}),
          ...(inferSessionId(allRows, threadId)
            ? { sessionId: inferSessionId(allRows, threadId) }
            : {}),
        },
        model: normalizeCodexMention(configRow.agent_model),
      }),
      chat: buildAcpChatContext({
        project_id: this.options.project_id,
        path: this.options.path,
        sender_id: senderId,
        user_message_date: date.toISOString(),
        user_message_content: text,
        user_parent_message_id: previous?.message_id,
        messageDate: assistantDate,
        thread_id: threadId,
        message_id: assistantMessageId,
        parent_message_id: messageId,
        completionNotificationEnabled:
          resolveCodexCompletionNotificationEnabled({
            override: configRow.codex_completion_notification,
            legacy: configRow.acp_config,
            accountDefault:
              this.options.codexCompletionNotificationDefault ?? true,
          }),
      }),
    };

    let acknowledged = false;
    try {
      for (
        let attempt = 1;
        attempt <= this.options.ackMaxAttempts;
        attempt += 1
      ) {
        try {
          for await (const response of this.transport.stream(
            request,
            this.options.ackTimeoutMs,
          )) {
            if (response.type === "error") throw new Error(response.error);
            if (response.type !== "status") continue;
            acknowledged = true;
            this.updateMessageState(
              message,
              response.state === "queued"
                ? "queue"
                : response.state === "running"
                  ? "running"
                  : "sent",
            );
          }
          if (!acknowledged) {
            throw new Error(
              "ACP queue submission ended without acknowledgement",
            );
          }
          break;
        } catch (error) {
          if (
            attempt >= this.options.ackMaxAttempts ||
            !isRetryableAcpAckError(error)
          ) {
            throw error;
          }
          await this.transport
            .interrupt({
              project_id: this.options.project_id,
              account_id: this.options.account_id,
              threadId: sessionId,
              chat: request.chat,
              note: `mobile retry after no ACP acknowledgement (attempt ${attempt})`,
            })
            .catch(() => undefined);
          const delay = Math.min(
            30_000,
            this.options.ackBackoffMs * 2 ** Math.max(0, attempt - 1),
          );
          await (this.options.sleep ?? wait)(delay);
        }
      }
    } catch (error) {
      if (!acknowledged) {
        this.updateMessageState(message, "not-sent");
      }
      throw error;
    }
    return { message_id: messageId, thread_id: threadId };
  }

  private async sendGuidanceOnce({
    threadId,
    text,
  }: {
    threadId: string;
    text: string;
  }): Promise<{ message_id: string; thread_id: string }> {
    if (!this.options.db.isReady()) throw new Error("Chat is not ready.");
    const allRows = rows(this.options.db);
    const configRow = threadConfig(allRows, threadId);
    if (
      !configRow ||
      (configRow.agent_kind !== "acp" && configRow.acp_config == null)
    ) {
      throw new Error("The selected thread is not an existing Codex thread.");
    }
    const active = [...allRows]
      .filter(
        (row) =>
          row.event === "chat" &&
          row.thread_id === threadId &&
          (row.generating === true || row.acp_state === "running"),
      )
      .sort((a, b) => `${a.date}`.localeCompare(`${b.date}`))
      .at(-1) as MutableChatMessage | undefined;
    if (!active) {
      throw new Error("Codex is no longer running; send a new turn instead.");
    }

    const date = this.nextDate(allRows);
    const messageId = this.id();
    const message: MutableChatMessage = {
      ...buildChatMessageRecordV2({
        sender_id: this.options.account_id,
        date,
        historyEntryDate: date.toISOString(),
        prevHistory: [],
        content: text,
        generating: false,
        message_id: messageId,
        thread_id: threadId,
        parent_message_id: active.message_id,
      }),
      acp_prompt: text,
      acp_send_mode: "immediate",
      acp_state: "sending",
    };
    this.options.db.set(message);
    this.commitOrThrow();
    await this.options.db.save();

    const sessionId = inferSessionId(allRows, threadId) ?? threadId;
    const assistantMessageId = this.id();
    const assistantDate = this.nextDate([...allRows, message]);
    const senderId = configRow.agent_model || "openai-codex-agent";
    const request: AcpSteerRequest = {
      project_id: this.options.project_id,
      account_id: this.options.account_id,
      prompt: text,
      session_id: sessionId,
      config: buildCodexAcpConfig({
        path: this.options.path,
        config: {
          ...(configRow.acp_config ?? {}),
          sessionId,
        },
        model: normalizeCodexMention(configRow.agent_model),
      }),
      chat: buildAcpChatContext({
        project_id: this.options.project_id,
        path: this.options.path,
        sender_id: senderId,
        user_message_date: date.toISOString(),
        user_message_content: text,
        user_parent_message_id: active.message_id,
        messageDate: assistantDate,
        thread_id: threadId,
        message_id: assistantMessageId,
        parent_message_id: messageId,
        sendMode: "immediate",
        completionNotificationEnabled:
          resolveCodexCompletionNotificationEnabled({
            override: configRow.codex_completion_notification,
            legacy: configRow.acp_config,
            accountDefault:
              this.options.codexCompletionNotificationDefault ?? true,
          }),
      }),
    };

    try {
      const response = await this.transport.steer(request);
      if (!response.ok || response.state === "missing") {
        throw new Error(`Codex guidance was not accepted (${response.state}).`);
      }
      this.updateMessageState(
        message,
        response.state === "queued" ? "queue" : "sent",
      );
      await this.options.db.save();
    } catch (error) {
      this.updateMessageState(message, "not-sent");
      await this.options.db.save().catch(() => undefined);
      throw error;
    }
    return { message_id: messageId, thread_id: threadId };
  }

  private updateMessageState(
    message: MutableChatMessage,
    state: NonNullable<MutableChatMessage["acp_state"]>,
  ): void {
    this.options.db.set({ ...message, acp_state: state });
    // ACP status streams may repeat the same state.  In that case syncstring's
    // commit returns false because there is no new change to persist, which is
    // successful rather than an error.
    this.options.db.commit({ emitChangeImmediately: true });
  }

  private commitOrThrow(): void {
    if (!this.options.db.commit({ emitChangeImmediately: true })) {
      throw new Error("Unable to commit the chat change.");
    }
  }

  private nextDate(allRows: readonly Record<string, any>[]): Date {
    const latestRowMs = allRows.reduce((latest, row) => {
      const value = new Date(`${row.date ?? ""}`).valueOf();
      return Number.isFinite(value) ? Math.max(latest, value) : latest;
    }, 0);
    const value = Math.max(
      this.now().valueOf(),
      latestRowMs + 1,
      this.lastMessageMs + 1,
    );
    this.lastMessageMs = value;
    return new Date(value);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private id(): string {
    return this.options.idGenerator?.() ?? uuid();
  }
}
