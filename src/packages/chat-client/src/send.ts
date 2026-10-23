/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import {
  buildAcpChatContext,
  buildChatMessageRecordV2,
  buildCodexAcpConfig,
  buildThreadStateRecord,
  contextStamp,
  messagesSinceContextCleared,
  normalizeCodexMention,
  resolveHarnessSessionId,
  sharedCodexThreadConfig,
  storedSessionInContext,
  threadContext,
  type ChatMessage,
  type ChatThreadConfigRecord,
} from "@cocalc/chat/core";
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
import { normalizeCodexSessionId } from "@cocalc/util/ai/codex";
import {
  parseAcpHarnessRuntime,
  type AcpHarnessRuntime,
} from "@cocalc/util/ai/runtime";
import type { AgentUserLocale } from "@cocalc/util/ai/agent-user-locale";
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

function agentThreadConfig(
  allRows: readonly Record<string, any>[],
  threadId: string,
): ChatThreadConfigRecord {
  const configRow = threadConfig(allRows, threadId);
  if (
    !configRow ||
    (configRow.agent_kind !== "acp" &&
      configRow.acp_config == null &&
      configRow.agent_runtime == null)
  ) {
    throw new Error("The selected thread is not an existing agent thread.");
  }
  return configRow;
}

/**
 * How a turn in this thread runs: Codex, or an ACP harness such as Claude
 * Code. The same rules as prepareChatSend in @cocalc/chat/send, which only
 * runs on the server: nothing before a "Context cleared" line counts.
 */
function agentTurn(
  allRows: readonly Record<string, any>[],
  configRow: ChatThreadConfigRecord,
  path: string,
): {
  runtime?: AcpHarnessRuntime;
  config?: AcpRequest["config"];
  session_id?: string;
  sender_id: string;
  context: ReturnType<typeof contextStamp>;
} {
  const threadId = configRow.thread_id;
  // An unknown runtime is an error, never a fallback to Codex.
  const runtime =
    configRow.agent_runtime == null
      ? undefined
      : parseAcpHarnessRuntime(configRow.agent_runtime);
  const messages = allRows
    .filter((row) => row.event === "chat" && row.thread_id === threadId)
    .sort((a, b) => `${a.date}`.localeCompare(`${b.date}`));
  const context = threadContext(configRow, messages);
  const sinceCleared = messagesSinceContextCleared(
    messages,
    context.clearedAtMs,
  );
  // A session saved by a turn from before the latest clear does not count.
  const stored = storedSessionInContext(configRow, context);
  const inferred = [...sinceCleared.messages]
    .reverse()
    .find(
      (row: any) =>
        !row.acp_automation_id && normalizeCodexSessionId(row.acp_thread_id),
    )?.acp_thread_id;
  if (runtime) {
    return {
      runtime,
      session_id: resolveHarnessSessionId(
        stored ? configRow.agent_session_id : undefined,
        inferred,
      ),
      sender_id: "acp-harness",
      context: contextStamp(context),
    };
  }
  const sessionId =
    (stored
      ? normalizeCodexSessionId(configRow.acp_config?.sessionId)
      : undefined) ?? inferred;
  return {
    config: buildCodexAcpConfig({
      path,
      config: { ...sharedCodexThreadConfig(configRow.acp_config), sessionId },
      model: normalizeCodexMention(configRow.agent_model),
    }),
    session_id: sessionId ?? (context.generation || threadId),
    sender_id: configRow.agent_model || "openai-codex-agent",
    context: contextStamp(context),
  };
}

function agentName(runtime?: AcpHarnessRuntime): string {
  if (!runtime) return "Codex";
  return runtime.profile.version === 2 && runtime.profile.id === "claude-code"
    ? "Claude"
    : "The agent";
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
    user_locale?: AgentUserLocale;
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
    const operation = this.sendOnce({
      threadId,
      text,
      userLocale: opts.user_locale,
    }).finally(() => {
      if (this.pending.get(threadId) === operation)
        this.pending.delete(threadId);
    });
    this.pending.set(threadId, operation);
    return operation;
  }

  sendGuidance(opts: {
    thread_id: string;
    text: string;
    user_locale?: AgentUserLocale;
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
    const operation = this.sendGuidanceOnce({
      threadId,
      text,
      userLocale: opts.user_locale,
    }).finally(() => {
      if (this.pendingGuidance.get(threadId) === operation) {
        this.pendingGuidance.delete(threadId);
      }
    });
    this.pendingGuidance.set(threadId, operation);
    return operation;
  }

  async interrupt(
    threadIdValue: string,
    expected?: {
      message_id: string;
      message_date: string;
      session_id?: string;
    },
  ): Promise<boolean> {
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
    const configRow = threadConfig(allRows, threadId);
    const turn = configRow
      ? agentTurn(allRows, configRow, this.options.path)
      : undefined;
    const sessionId = turn?.session_id ?? threadId;
    if (
      expected &&
      (!target ||
        target.message_id !== expected.message_id ||
        new Date(target.date).toISOString() !== expected.message_date ||
        (expected.session_id && expected.session_id !== sessionId))
    )
      return false;
    const result = await this.transport.interrupt({
      project_id: this.options.project_id,
      account_id: this.options.account_id,
      threadId: sessionId,
      expected_message_id: expected?.message_id,
      expected_session_id: expected?.session_id,
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
    if (result.state === "stale") return false;
    if (!result.ok && result.state !== "missing") {
      throw new Error(
        `${agentName(turn?.runtime)} interrupt was not accepted (${result.state}).`,
      );
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
    return true;
  }

  private async sendOnce({
    threadId,
    text,
    userLocale,
  }: {
    threadId: string;
    text: string;
    userLocale?: AgentUserLocale;
  }): Promise<{ message_id: string; thread_id: string }> {
    if (!this.options.db.isReady()) {
      throw new Error("Chat is not ready.");
    }
    const allRows = rows(this.options.db);
    const configRow = agentThreadConfig(allRows, threadId);
    const turn = agentTurn(allRows, configRow, this.options.path);
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

    const sessionId = turn.session_id ?? threadId;
    const assistantMessageId = this.id();
    const assistantDate = this.nextDate([...allRows, message]);
    const request: AcpRequest = {
      project_id: this.options.project_id,
      account_id: this.options.account_id,
      prompt: text,
      session_id: turn.session_id,
      // Admission picks the account's payment selection for either runtime.
      ...(turn.runtime ? { runtime: turn.runtime } : { config: turn.config }),
      chat: buildAcpChatContext({
        project_id: this.options.project_id,
        path: this.options.path,
        sender_id: turn.sender_id,
        user_message_date: date.toISOString(),
        user_message_content: text,
        user_parent_message_id: previous?.message_id,
        messageDate: assistantDate,
        thread_id: threadId,
        message_id: assistantMessageId,
        parent_message_id: messageId,
        userLocale,
        completionNotificationEnabled:
          resolveCodexCompletionNotificationEnabled({
            override: configRow.codex_completion_notification,
            legacy: configRow.acp_config,
            accountDefault:
              this.options.codexCompletionNotificationDefault ?? true,
          }),
      }),
    };
    // Which context the turn belongs to, so a clear made meanwhile is honored.
    Object.assign(request.chat!, turn.context);

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
          // Like the web app, a harness turn is never resubmitted blindly.
          if (
            turn.runtime ||
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
    userLocale,
  }: {
    threadId: string;
    text: string;
    userLocale?: AgentUserLocale;
  }): Promise<{ message_id: string; thread_id: string }> {
    if (!this.options.db.isReady()) throw new Error("Chat is not ready.");
    const allRows = rows(this.options.db);
    const configRow = agentThreadConfig(allRows, threadId);
    const turn = agentTurn(allRows, configRow, this.options.path);
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
      throw new Error(
        `${agentName(turn.runtime)} is no longer running; send a new turn instead.`,
      );
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

    const assistantMessageId = this.id();
    const assistantDate = this.nextDate([...allRows, message]);
    const request: AcpSteerRequest = {
      project_id: this.options.project_id,
      account_id: this.options.account_id,
      prompt: text,
      session_id: turn.session_id,
      ...(turn.runtime ? { runtime: turn.runtime } : { config: turn.config }),
      chat: buildAcpChatContext({
        project_id: this.options.project_id,
        path: this.options.path,
        sender_id: turn.sender_id,
        user_message_date: date.toISOString(),
        user_message_content: text,
        user_parent_message_id: active.message_id,
        messageDate: assistantDate,
        thread_id: threadId,
        message_id: assistantMessageId,
        parent_message_id: messageId,
        sendMode: "immediate",
        userLocale,
        completionNotificationEnabled:
          resolveCodexCompletionNotificationEnabled({
            override: configRow.codex_completion_notification,
            legacy: configRow.acp_config,
            accountDefault:
              this.options.codexCompletionNotificationDefault ?? true,
          }),
      }),
    };
    Object.assign(request.chat!, turn.context);

    try {
      const response = await this.transport.steer(request);
      if (!response.ok || response.state === "missing") {
        throw new Error(
          `${agentName(turn.runtime)} guidance was not accepted (${response.state}).`,
        );
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
