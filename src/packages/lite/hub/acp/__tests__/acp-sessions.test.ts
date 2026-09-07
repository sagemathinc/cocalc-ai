#!/usr/bin/env ts-node
import { randomUUID } from "node:crypto";
import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import {
  claimNextQueuedAcpJobForThread,
  enqueueAcpJob,
  listQueuedAcpJobs,
  setAcpJobState,
} from "../../sqlite/acp-jobs";
import {
  getAcpSessionByOpId,
  heartbeatAcpSession,
  listAcpSessions,
  publishActiveAcpSessions,
  publishPendingAcpSessions,
  setAcpSessionPublisher,
  upsertAcpSession,
  upsertAcpSessionFromRequest,
} from "../../sqlite/acp-sessions";

function makeRequest({
  userMessageId = "user-1",
  assistantMessageId = "assistant-1",
  assistantDate = "2026-06-17T20:00:00.000Z",
  prompt = "Investigate the failing test and fix it.",
}: {
  userMessageId?: string;
  assistantMessageId?: string;
  assistantDate?: string;
  prompt?: string;
} = {}) {
  return {
    project_id: "00000000-1000-4000-8000-000000000000",
    account_id: "00000000-1000-4000-8000-000000000001",
    session_id: randomUUID(),
    prompt,
    config: {
      model: "gpt-5.1-codex",
      workingDirectory: "/tmp",
    },
    chat: {
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "home/user/test.chat",
      thread_id: "thread-1",
      thread_title: "Investigate parser",
      parent_message_id: userMessageId,
      message_id: assistantMessageId,
      message_date: assistantDate,
      sender_id: "openai-codex-agent",
    },
  };
}

beforeAll(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
  listQueuedAcpJobs();
  listAcpSessions();
});

beforeEach(() => {
  setAcpSessionPublisher(undefined);
  getAcpDatabase().prepare("DELETE FROM acp_jobs").run();
  getAcpDatabase().prepare("DELETE FROM acp_sessions").run();
});

afterAll(() => {
  setAcpSessionPublisher(undefined);
  closeAcpDatabase();
});

describe("acp session registry", () => {
  it("automatically retries a lost final update without another heartbeat", async () => {
    jest.useFakeTimers();
    try {
      const request = makeRequest();
      const publish = jest
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue(undefined);
      setAcpSessionPublisher(publish);
      upsertAcpSessionFromRequest({
        request,
        state: "completed",
        op_id: request.chat.message_id,
      });
      await jest.advanceTimersByTimeAsync(10_000);
      expect(publish).toHaveBeenCalledTimes(2);
      expect(publishPendingAcpSessions()).toBe(0);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(publish).toHaveBeenCalledTimes(2);
    } finally {
      setAcpSessionPublisher(undefined);
      jest.useRealTimers();
    }
  });
  it("replays a failed terminal publication after replacing the publisher", async () => {
    const request = makeRequest();
    const failing = jest.fn(async () => {
      throw new Error("hub offline");
    });
    setAcpSessionPublisher(failing);
    upsertAcpSessionFromRequest({
      request,
      state: "completed",
      op_id: request.chat.message_id,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(failing).toHaveBeenCalledTimes(1);
    setAcpSessionPublisher(undefined);
    const recovered = jest.fn(async () => {});
    setAcpSessionPublisher(recovered);
    expect(publishPendingAcpSessions()).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(recovered).toHaveBeenCalledWith(
      expect.objectContaining({ state: "completed", terminal: 1 }),
    );
    expect(publishPendingAcpSessions()).toBe(0);
  });

  it("does not let a running publication acknowledge a newer terminal update", async () => {
    const request = makeRequest();
    let finish!: () => void;
    const publish = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    setAcpSessionPublisher(publish);
    upsertAcpSessionFromRequest({
      request,
      state: "running",
      op_id: request.chat.message_id,
    });
    upsertAcpSessionFromRequest({
      request,
      state: "completed",
      op_id: request.chat.message_id,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect(publish.mock.calls.map(([row]) => row.state)).toEqual([
      "running",
      "completed",
    ]);
    expect(publishPendingAcpSessions()).toBe(0);
  });
  it("stores account-visible metadata for a request", () => {
    const request = makeRequest();
    const row = upsertAcpSessionFromRequest({
      request,
      state: "queued",
      op_id: request.chat.message_id,
      session_id: request.session_id,
    });

    expect(row.terminal).toBe(0);
    expect(row.state).toBe("queued");
    expect(row.op_id).toBe(request.chat.message_id);
    expect(row.session_id).toBe(request.session_id);
    expect(row.account_id).toBe(request.account_id);
    expect(row.project_id).toBe(request.project_id);
    expect(row.path).toBe(request.chat.path);
    expect(row.thread_id).toBe(request.chat.thread_id);
    expect(row.title).toBe("Investigate parser");
    expect(row.message_id).toBe(request.chat.message_id);
    expect(row.parent_message_id).toBe(request.chat.parent_message_id);
    expect(row.model).toBe("gpt-5.1-codex");
    expect(row.agent_kind).toBe("codex");
    expect(row.run_kind).toBe("interactive");
    expect(row.payment_source_kind).toBe("unknown");
    expect(row.prompt_snippet).toContain("Investigate the failing test");
  });

  it("mirrors queued, running, and terminal job state", () => {
    const request = makeRequest();
    const queued = enqueueAcpJob(request);

    expect(getAcpSessionByOpId(queued.op_id)?.state).toBe("queued");
    expect(listAcpSessions({ activeOnly: true })).toHaveLength(1);

    const running = claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
      worker_id: "worker-1",
    });

    expect(running?.state).toBe("running");
    const runningSession = getAcpSessionByOpId(queued.op_id);
    expect(runningSession?.state).toBe("running");
    expect(runningSession?.last_heartbeat_at).toBeGreaterThan(0);
    expect(runningSession?.terminal).toBe(0);

    setAcpJobState({
      op_id: queued.op_id,
      state: "completed",
      worker_id: "worker-1",
    });

    const completed = getAcpSessionByOpId(queued.op_id);
    expect(completed?.state).toBe("completed");
    expect(completed?.terminal).toBe(1);
    expect(completed?.finished_at).toBeGreaterThan(0);
    expect(listAcpSessions({ activeOnly: true })).toHaveLength(0);
  });

  it("maps failed jobs to failed terminal sessions", () => {
    const request = makeRequest({
      userMessageId: "user-2",
      assistantMessageId: "assistant-2",
      assistantDate: "2026-06-17T20:00:01.000Z",
    });
    const queued = enqueueAcpJob(request);

    setAcpJobState({
      op_id: queued.op_id,
      state: "error",
      error: "provider failed",
    });

    const failed = getAcpSessionByOpId(queued.op_id);
    expect(failed?.state).toBe("failed");
    expect(failed?.terminal).toBe(1);
    expect(failed?.error).toBe("provider failed");
  });

  it("publishes local session changes best-effort", async () => {
    const published: string[] = [];
    setAcpSessionPublisher((row) => {
      published.push(`${row.op_id}:${row.state}:${row.terminal}`);
    });
    const request = makeRequest({
      userMessageId: "user-3",
      assistantMessageId: "assistant-3",
      assistantDate: "2026-06-17T20:00:02.000Z",
    });

    upsertAcpSessionFromRequest({
      request,
      state: "running",
      op_id: request.chat.message_id,
      session_id: request.session_id,
    });
    heartbeatAcpSession({
      op_id: request.chat.message_id,
      project_id: request.project_id,
      path: request.chat.path,
      message_id: request.chat.message_id,
    });

    await Promise.resolve();
    expect(published).toEqual([
      "assistant-3:running:0",
      "assistant-3:running:0",
    ]);
  });

  it("republishes active local sessions during startup reconciliation", async () => {
    const published: string[] = [];
    setAcpSessionPublisher((row) => {
      published.push(`${row.op_id}:${row.state}:${row.terminal}`);
    });
    const runningRequest = makeRequest({
      userMessageId: "user-4",
      assistantMessageId: "assistant-4",
    });
    const completedRequest = makeRequest({
      userMessageId: "user-5",
      assistantMessageId: "assistant-5",
    });

    upsertAcpSessionFromRequest({
      request: runningRequest,
      state: "running",
      op_id: runningRequest.chat.message_id,
      session_id: runningRequest.session_id,
    });
    upsertAcpSessionFromRequest({
      request: completedRequest,
      state: "completed",
      op_id: completedRequest.chat.message_id,
      session_id: completedRequest.session_id,
    });
    await new Promise((resolve) => setImmediate(resolve));
    published.length = 0;

    expect(publishActiveAcpSessions()).toBe(1);
    await Promise.resolve();
    expect(published).toEqual(["assistant-4:running:0"]);
  });

  it("does not let unknown payment source updates clobber known payment source state", () => {
    const request = makeRequest({
      userMessageId: "user-6",
      assistantMessageId: "assistant-6",
    });
    upsertAcpSession({
      session_id: request.session_id,
      op_id: request.chat.message_id,
      project_id: request.project_id,
      account_id: request.account_id,
      path: request.chat.path,
      thread_id: request.chat.thread_id,
      message_id: request.chat.message_id,
      state: "running",
      payment_source_kind: "account_plan",
      payment_source_id: request.account_id,
      payment_source_label: "ChatGPT Plan",
      payment_source_owner_account_id: request.account_id,
      site_funded_reservation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    upsertAcpSessionFromRequest({
      request,
      state: "completed",
      op_id: request.chat.message_id,
      session_id: request.session_id,
    });

    const row = getAcpSessionByOpId(request.chat.message_id);
    expect(row?.state).toBe("completed");
    expect(row?.payment_source_kind).toBe("account_plan");
    expect(row?.payment_source_label).toBe("ChatGPT Plan");
    expect(row?.site_funded_reservation_id).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
  });
});
