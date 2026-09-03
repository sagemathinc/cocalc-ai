/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  claimAcpAttentionResponseDispatch,
  claimStaleAcpAttentionContinue,
  getAcpAttention,
  listPendingAcpActions,
  markAllPendingAcpSyncAttentionStale,
  markAcpAsyncAttentionSuperseded,
  markAcpSyncAttentionStale,
  submitAcpAttentionResponse,
  resolveAcpAttention,
  updateAcpAttentionDelivery,
  upsertAcpAttention,
} from "../../sqlite/acp-attention";
import { closeAcpDatabase, initAcpDatabase } from "../../sqlite/acp-database";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

function createAttention(opts?: {
  source_kind?: "codex_sync_question" | "codex_async_question";
  source_id?: string;
}) {
  return upsertAcpAttention({
    project_id: PROJECT_ID,
    account_id: ACCOUNT_ID,
    path: "agent.chat",
    thread_id: "thread-1",
    turn_id: "turn-1",
    source_kind: opts?.source_kind ?? "codex_sync_question",
    source_id: opts?.source_id ?? "source-1",
    attention_kind: "question",
    is_blocking: true,
    title: "Codex needs input",
    questions: [{ id: "choice", header: "Choice", question: "Continue?" }],
    chat: {
      project_id: PROJECT_ID,
      path: "agent.chat",
      message_date: "2026-09-02T00:00:00.000Z",
      sender_id: ACCOUNT_ID,
      thread_id: "thread-1",
    },
  });
}

describe("ACP attention storage", () => {
  beforeEach(() => {
    closeAcpDatabase();
    initAcpDatabase({ filename: ":memory:" });
  });

  afterEach(() => {
    closeAcpDatabase();
  });

  it("deduplicates source requests and atomically accepts one response", () => {
    const record = createAttention();
    expect(createAttention().attention_id).toBe(record.attention_id);

    expect(
      submitAcpAttentionResponse({
        attention_id: record.attention_id,
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        response_id: "response-1",
        answers: { choice: ["Yes"] },
      }),
    ).toMatchObject({ state: "submitted" });
    expect(
      submitAcpAttentionResponse({
        attention_id: record.attention_id,
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        response_id: "response-1",
        answers: { choice: ["No"] },
      }),
    ).toMatchObject({ state: "submitted" });
    expect(
      submitAcpAttentionResponse({
        attention_id: record.attention_id,
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        response_id: "response-2",
        answers: { choice: ["No"] },
      }),
    ).toMatchObject({ state: "already_submitted" });
    expect(getAcpAttention(record.attention_id)?.response).toEqual({
      choice: ["Yes"],
    });
    expect(
      claimAcpAttentionResponseDispatch({
        attention_id: record.attention_id,
        response_id: "response-1",
      }),
    ).toBe(true);
    expect(
      claimAcpAttentionResponseDispatch({
        attention_id: record.attention_id,
        response_id: "response-1",
      }),
    ).toBe(false);
  });

  it("rejects reads and writes under a different account or project", () => {
    const record = createAttention();
    const otherAccountId = "33333333-3333-4333-8333-333333333333";
    expect(
      submitAcpAttentionResponse({
        attention_id: record.attention_id,
        account_id: otherAccountId,
        project_id: PROJECT_ID,
        response_id: "response-1",
        answers: { choice: ["Yes"] },
      }),
    ).toEqual({ state: "missing" });
    expect(
      updateAcpAttentionDelivery({
        attention_id: record.attention_id,
        account_id: otherAccountId,
        project_id: PROJECT_ID,
        seen_at: Date.now(),
      }),
    ).toBeUndefined();
    expect(
      updateAcpAttentionDelivery({
        attention_id: record.attention_id,
        account_id: ACCOUNT_ID,
        project_id: "44444444-4444-4444-8444-444444444444",
        acknowledged_at: Date.now(),
      }),
    ).toBeUndefined();
    expect(getAcpAttention(record.attention_id)).toMatchObject({
      seen_at: undefined,
      acknowledged_at: undefined,
    });
  });

  it("tracks seen, acknowledged, and snoozed delivery state independently", () => {
    const record = createAttention();
    const seen_at = Date.now();
    const acknowledged_at = seen_at + 1;
    const snoozed_until = seen_at + 60_000;

    expect(
      updateAcpAttentionDelivery({
        attention_id: record.attention_id,
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        seen_at,
      }),
    ).toMatchObject({ seen_at, state: "pending" });
    expect(
      updateAcpAttentionDelivery({
        attention_id: record.attention_id,
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        acknowledged_at,
        snoozed_until,
      }),
    ).toMatchObject({ seen_at, acknowledged_at, snoozed_until });
  });

  it("rate limits repeated resolved requests in one thread", () => {
    for (let i = 0; i < 30; i += 1) {
      const record = createAttention({ source_id: `resolved-${i}` });
      resolveAcpAttention({
        attention_id: record.attention_id,
        state: "resolved",
      });
    }
    expect(() => createAttention({ source_id: "one-too-many" })).toThrow(
      "Too many Codex attention requests created in this thread",
    );
  });

  it("marks synchronous requests stale after runtime loss", () => {
    const record = createAttention();
    expect(
      markAcpSyncAttentionStale({
        project_id: PROJECT_ID,
        thread_id: "thread-1",
        turn_id: "turn-1",
        reason: "runtime closed",
      }),
    ).toEqual([
      expect.objectContaining({
        attention_id: record.attention_id,
        state: "stale",
        resolution_reason: "runtime closed",
      }),
    ]);
  });

  it("marks every held synchronous responder stale after service restart", () => {
    const first = createAttention({ source_id: "sync-before-restart-1" });
    const second = createAttention({ source_id: "sync-before-restart-2" });
    const asynchronous = createAttention({
      source_kind: "codex_async_question",
      source_id: "async-before-restart",
    });
    submitAcpAttentionResponse({
      attention_id: first.attention_id,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      response_id: "saved-response",
      answers: { choice: ["Yes"] },
    });

    expect(markAllPendingAcpSyncAttentionStale("service restarted")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attention_id: first.attention_id,
          state: "stale",
          response_id: "saved-response",
        }),
        expect.objectContaining({
          attention_id: second.attention_id,
          state: "stale",
        }),
      ]),
    );
    expect(getAcpAttention(asynchronous.attention_id)?.state).toBe("pending");
  });

  it("preserves synchronous requests still owned by a live responder", () => {
    const live = createAttention({ source_id: "sync-live" });
    const orphaned = createAttention({ source_id: "sync-orphaned" });

    expect(
      markAllPendingAcpSyncAttentionStale("service restarted", {
        preserve: ({ attention_id }) => attention_id === live.attention_id,
      }),
    ).toEqual([
      expect.objectContaining({
        attention_id: orphaned.attention_id,
        state: "stale",
      }),
    ]);
    expect(getAcpAttention(live.attention_id)?.state).toBe("pending");
  });

  it("supersedes unanswered async questions but preserves submitted ones", () => {
    const unanswered = createAttention({
      source_kind: "codex_async_question",
      source_id: "async-1",
    });
    const answered = createAttention({
      source_kind: "codex_async_question",
      source_id: "async-2",
    });
    submitAcpAttentionResponse({
      attention_id: answered.attention_id,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      response_id: "response-1",
      answers: { choice: ["Yes"] },
    });

    expect(
      markAcpAsyncAttentionSuperseded({
        project_id: PROJECT_ID,
        path: "agent.chat",
        thread_id: "thread-1",
        reason: "newer user message",
      }),
    ).toEqual([
      expect.objectContaining({
        attention_id: unanswered.attention_id,
        state: "superseded",
      }),
    ]);
    expect(getAcpAttention(answered.attention_id)?.state).toBe("pending");
  });

  it("allows one deliberate retry of a stale asynchronous answer", () => {
    const record = createAttention({
      source_kind: "codex_async_question",
      source_id: "async-retry",
    });
    submitAcpAttentionResponse({
      attention_id: record.attention_id,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      response_id: "response-retry",
      answers: { choice: ["Yes"] },
    });
    resolveAcpAttention({
      attention_id: record.attention_id,
      state: "stale",
      reason: "queue unavailable",
    });

    expect(
      claimStaleAcpAttentionContinue({
        attention_id: record.attention_id,
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).toMatchObject({
      attention_id: record.attention_id,
      state: "pending",
      response_id: "response-retry",
      resolution_reason: "continuing",
    });
    expect(
      claimStaleAcpAttentionContinue({
        attention_id: record.attention_id,
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).toBeUndefined();
  });

  it("persists only the typed opaque reference for a CoCalc action", () => {
    const expires_at = Date.now() + 60_000;
    const record = upsertAcpAttention({
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
      path: "agent.chat",
      thread_id: "thread-1",
      source_kind: "cocalc_action",
      source_id: "fresh_auth:33333333-3333-4333-8333-333333333333",
      attention_kind: "fresh_auth",
      is_blocking: true,
      title: "Codex needs fresh account authorization",
      questions: [],
      action: {
        kind: "fresh_auth",
        reference: "33333333-3333-4333-8333-333333333333",
        expires_at,
      },
      expires_at,
      chat: {
        project_id: PROJECT_ID,
        path: "agent.chat",
        message_date: "2026-09-02T00:00:00.000Z",
        sender_id: ACCOUNT_ID,
        thread_id: "thread-1",
      },
    });

    expect(getAcpAttention(record.attention_id)).toMatchObject({
      action: {
        kind: "fresh_auth",
        reference: "33333333-3333-4333-8333-333333333333",
        expires_at,
      },
    });
    expect(listPendingAcpActions()).toHaveLength(1);
    expect(JSON.stringify(record)).not.toContain("https://");
  });
});
