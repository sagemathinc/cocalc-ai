/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import callHub from "@cocalc/conat/hub/call-hub";
import type {
  AcpAttentionQuestion,
  AcpAttentionRecord,
} from "@cocalc/conat/ai/acp/types";
import type {
  CodexAttentionContext,
  CodexAttentionHandler,
} from "@cocalc/ai/acp";
import { validateAttentionAnswers } from "@cocalc/ai/acp";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import getLogger from "@cocalc/backend/logger";
import {
  getAcpAttention,
  getAcpAttentionBySource,
  markAcpSyncAttentionStale,
  type AcpAttentionStoredRecord,
  resolveAcpAttentionBySource,
  resolveAcpAttention,
  upsertAcpAttention,
} from "../sqlite/acp-attention";

const logger = getLogger("lite:hub:acp:codex-attention");
const RESPONSE_POLL_MS = 200;
const MAX_SYNC_QUESTION_LIFETIME_MS = 24 * 60 * 60 * 1000;

function syncSourceId(
  context: CodexAttentionContext,
  requestId: string,
): string {
  return `${context.threadId}:${context.turnId}:${requestId}`;
}

function asyncSourceId(context: CodexAttentionContext, itemId: string): string {
  return `${context.threadId}:${context.turnId}:${itemId}`;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Codex runtime closed"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Codex runtime closed"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function publicRecord(
  record: ReturnType<typeof upsertAcpAttention>,
): AcpAttentionRecord {
  const {
    chat: _chat,
    response: _response,
    response_id: _id,
    response_declined: _declined,
    ...publicRow
  } = record;
  const message_date = `${_chat?.message_date ?? ""}`.trim() || undefined;
  return {
    ...publicRow,
    ...(message_date ? { message_date } : {}),
  };
}

function sourceFragmentId(
  context: CodexAttentionContext,
  attentionId?: string,
): string | undefined {
  const date = Date.parse(`${context.chat?.message_date ?? ""}`);
  if (!Number.isFinite(date)) return;
  const parts = [`chat=${Math.floor(date)}`];
  const threadId =
    `${context.chat?.thread_id ?? context.threadId ?? ""}`.trim();
  if (threadId) parts.push(`thread=${threadId}`);
  const normalizedAttentionId = `${attentionId ?? ""}`.trim();
  if (normalizedAttentionId) {
    parts.push(`attention=${normalizedAttentionId}`);
  }
  return parts.join("&");
}

async function publishAttentionNoticeBestEffort(opts: {
  client: ConatClient;
  record: AcpAttentionRecord;
  source_fragment_id?: string;
}): Promise<void> {
  try {
    await callHub({
      client: opts.client,
      account_id: opts.record.account_id,
      name: "notifications.createCodexAttentionNotice",
      args: [
        {
          account_id: opts.record.account_id,
          source_project_id: opts.record.project_id,
          source_path: opts.record.path,
          source_fragment_id: opts.source_fragment_id,
          thread_id: opts.record.thread_id,
          attention_id: opts.record.attention_id,
          attention_kind: opts.record.attention_kind,
          is_blocking: opts.record.is_blocking,
          title: opts.record.title,
          stable_source_id: opts.record.source_id,
          acknowledged_at: opts.record.acknowledged_at,
          snoozed_until: opts.record.snoozed_until,
          state: opts.record.state,
        },
      ],
      timeout: 20_000,
    });
  } catch (err) {
    // Local Lite deliberately has no account notification projection. The
    // persisted chat event and local delivery remain available there.
    logger.debug("Codex attention inbox projection unavailable", { err });
  }
}

export async function publishStoredAttentionNoticeBestEffort(opts: {
  client: ConatClient;
  record: ReturnType<typeof upsertAcpAttention>;
}): Promise<void> {
  const record = publicRecord(opts.record);
  await publishAttentionNoticeBestEffort({
    client: opts.client,
    record,
    source_fragment_id: sourceFragmentId(
      {
        projectId: record.project_id,
        accountId: record.account_id,
        threadId: record.thread_id,
        turnId: record.turn_id ?? "",
        chat: opts.record.chat,
        stream: async () => undefined,
      },
      record.attention_id,
    ),
  });
}

type FreshAuthActionStatus = {
  challenge_id: string;
  state: "pending" | "approved" | "canceled" | "expired";
  expires_at: string;
};

async function getFreshAuthActionStatus(opts: {
  client: ConatClient;
  account_id: string;
  project_id: string;
  challenge_id: string;
}): Promise<FreshAuthActionStatus> {
  return await callHub({
    client: opts.client,
    account_id: opts.account_id,
    name: "notifications.getCodexFreshAuthActionStatus",
    args: [
      {
        account_id: opts.account_id,
        source_project_id: opts.project_id,
        challenge_id: opts.challenge_id,
      },
    ],
    timeout: 20_000,
  });
}

export async function createCodexFreshAuthAttention(opts: {
  client: ConatClient;
  account_id: string;
  project_id: string;
  path: string;
  thread_id: string;
  turn_id?: string;
  message_date?: string;
  challenge_id: string;
}): Promise<AcpAttentionStoredRecord> {
  const status = await getFreshAuthActionStatus({
    client: opts.client,
    account_id: opts.account_id,
    project_id: opts.project_id,
    challenge_id: opts.challenge_id,
  });
  if (status.state !== "pending") {
    throw new Error("fresh-auth challenge is not pending");
  }
  const expires_at = Date.parse(status.expires_at);
  if (!Number.isFinite(expires_at) || expires_at <= Date.now()) {
    throw new Error("fresh-auth challenge is expired");
  }
  return upsertAcpAttention({
    project_id: opts.project_id,
    account_id: opts.account_id,
    path: opts.path,
    thread_id: opts.thread_id,
    turn_id: opts.turn_id,
    source_kind: "cocalc_action",
    source_id: `fresh_auth:${opts.challenge_id}`,
    attention_kind: "fresh_auth",
    is_blocking: true,
    title: "Codex needs fresh account authorization",
    summary:
      "Approve the waiting CoCalc CLI command. Codex can continue other work while it waits.",
    questions: [],
    action: {
      kind: "fresh_auth",
      reference: opts.challenge_id,
      expires_at,
    },
    expires_at,
    chat: {
      project_id: opts.project_id,
      path: opts.path,
      thread_id: opts.thread_id,
      message_date: opts.message_date ?? "",
      sender_id: opts.account_id,
    },
  });
}

export async function reconcileCodexAction(opts: {
  client: ConatClient;
  record: AcpAttentionStoredRecord;
}): Promise<AcpAttentionStoredRecord> {
  const { record } = opts;
  if (
    record.source_kind !== "cocalc_action" ||
    record.action?.kind !== "fresh_auth" ||
    record.state !== "pending"
  ) {
    return record;
  }
  let state: "resolved" | "canceled" | "expired" | undefined;
  let reason: string | undefined;
  if (record.action.expires_at <= Date.now()) {
    state = "expired";
    reason = "Fresh-auth challenge expired";
  } else {
    const status = await getFreshAuthActionStatus({
      client: opts.client,
      account_id: record.account_id,
      project_id: record.project_id,
      challenge_id: record.action.reference,
    });
    if (status.state === "approved") {
      state = "resolved";
      reason = "Fresh account authorization approved; the command can retry";
    } else if (status.state === "canceled") {
      state = "canceled";
      reason = "Fresh-auth challenge canceled";
    } else if (status.state === "expired") {
      state = "expired";
      reason = "Fresh-auth challenge expired";
    }
  }
  if (!state) return record;
  const resolved =
    resolveAcpAttention({
      attention_id: record.attention_id,
      state,
      reason,
    }) ?? record;
  void publishStoredAttentionNoticeBestEffort({
    client: opts.client,
    record: resolved,
  });
  return resolved;
}

function titleForQuestions(questions: AcpAttentionQuestion[]): string {
  return questions.length === 1
    ? questions[0].header || "Codex needs your attention"
    : `Codex has ${questions.length} questions`;
}

export function createCodexAttentionHandler(
  client: ConatClient,
): CodexAttentionHandler {
  return {
    async requestSyncQuestion({
      requestId,
      itemId,
      isBlocking,
      autoResolutionMs,
      questions,
      context,
      signal,
    }) {
      if (!context.chat?.path || !context.chat.thread_id) {
        throw new Error("Codex attention requires durable chat context");
      }
      const now = Date.now();
      const expiresAt = Math.min(
        now + MAX_SYNC_QUESTION_LIFETIME_MS,
        autoResolutionMs != null
          ? now + Math.max(1_000, autoResolutionMs)
          : Number.POSITIVE_INFINITY,
      );
      const stored = upsertAcpAttention({
        project_id: context.projectId,
        account_id: context.accountId,
        path: context.chat.path,
        thread_id: context.chat.thread_id,
        turn_id: context.turnId,
        source_kind: "codex_sync_question",
        source_id: syncSourceId(context, requestId),
        attention_kind: "question",
        is_blocking: isBlocking,
        title: titleForQuestions(questions),
        summary: isBlocking
          ? "The current Codex turn is paused."
          : "Codex may continue while it waits.",
        questions,
        chat: context.chat,
        expires_at: Number.isFinite(expiresAt) ? expiresAt : undefined,
      });
      void itemId;
      const record = publicRecord(stored);
      await context.stream({
        type: "event",
        event: { type: "attention", request: record },
      });
      void publishAttentionNoticeBestEffort({
        client,
        record,
        source_fragment_id: sourceFragmentId(context, record.attention_id),
      });
      try {
        while (true) {
          const current = getAcpAttention(record.attention_id);
          if (!current || current.state !== "pending") {
            throw new Error(
              current?.resolution_reason ?? "Codex attention request closed",
            );
          }
          if (current.expires_at && Date.now() >= current.expires_at) {
            const expired = resolveAcpAttentionBySource({
              project_id: context.projectId,
              source_kind: "codex_sync_question",
              source_id: syncSourceId(context, requestId),
              state: "expired",
              reason: "Codex request expired",
            });
            if (expired) {
              void publishStoredAttentionNoticeBestEffort({
                client,
                record: expired,
              });
            }
            throw new Error("Codex attention request expired");
          }
          if (current.response_id) {
            return validateAttentionAnswers({
              questions,
              answers: current.response,
              decline: current.response_declined,
            });
          }
          await delay(RESPONSE_POLL_MS, signal);
        }
      } catch (err) {
        if (signal.aborted) {
          const stale = resolveAcpAttentionBySource({
            project_id: context.projectId,
            source_kind: "codex_sync_question",
            source_id: syncSourceId(context, requestId),
            state: "stale",
            reason: "Codex runtime closed before the response was delivered",
          });
          if (stale) {
            void publishStoredAttentionNoticeBestEffort({
              client,
              record: stale,
            });
          }
        }
        throw err;
      }
    },

    async createAsyncQuestion({ itemId, questions, context }) {
      if (!context.chat?.path || !context.chat.thread_id) {
        throw new Error("Codex attention requires durable chat context");
      }
      const stored = upsertAcpAttention({
        project_id: context.projectId,
        account_id: context.accountId,
        path: context.chat.path,
        thread_id: context.chat.thread_id,
        turn_id: context.turnId,
        source_kind: "codex_async_question",
        source_id: asyncSourceId(context, itemId),
        attention_kind: "question",
        is_blocking: false,
        title: titleForQuestions(questions),
        summary: "Codex may continue while it waits for your reply.",
        questions,
        chat: context.chat,
      });
      const record = publicRecord(stored);
      await context.stream({
        type: "event",
        event: { type: "attention", request: record },
      });
      void publishAttentionNoticeBestEffort({
        client,
        record,
        source_fragment_id: sourceFragmentId(context, record.attention_id),
      });
      return record;
    },

    serverRequestResolved({ requestId, context }) {
      if (!context) return;
      const current = getAcpAttentionBySource({
        project_id: context.projectId,
        source_kind: "codex_sync_question",
        source_id: syncSourceId(context, requestId),
      });
      const resolved = resolveAcpAttentionBySource({
        project_id: context.projectId,
        source_kind: "codex_sync_question",
        source_id: syncSourceId(context, requestId),
        state: current?.response_id
          ? current.response_declined
            ? "declined"
            : "answered"
          : "canceled",
        reason: current?.response_id
          ? current.response_declined
            ? "The user declined to answer"
            : "Codex accepted the response"
          : "Codex cleared the request before receiving an answer",
      });
      if (resolved) {
        void publishStoredAttentionNoticeBestEffort({
          client,
          record: resolved,
        });
      }
    },

    runtimeClosed(context) {
      if (!context) return;
      const staleRecords = markAcpSyncAttentionStale({
        project_id: context.projectId,
        thread_id: context.chat?.thread_id,
        turn_id: context.turnId,
        reason: "Codex runtime closed before the request was resolved",
      });
      for (const stale of staleRecords) {
        void publishStoredAttentionNoticeBestEffort({ client, record: stale });
      }
    },
  };
}

export const __test__ = { publicRecord, sourceFragmentId };
