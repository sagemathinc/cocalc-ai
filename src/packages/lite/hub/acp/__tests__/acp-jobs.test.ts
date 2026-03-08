#!/usr/bin/env ts-node
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase, initDatabase } from "../../sqlite/database";
import {
  claimNextQueuedAcpJobForThread,
  enqueueAcpJob,
  listQueuedAcpJobs,
  listQueuedAcpJobsForThread,
  reprioritizeAcpJobImmediate,
} from "../../sqlite/acp-jobs";

async function delay(ms = 2): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRequest({
  userMessageId,
  assistantMessageId,
  assistantDate,
}: {
  userMessageId: string;
  assistantMessageId: string;
  assistantDate: string;
}) {
  return {
    project_id: "00000000-1000-4000-8000-000000000000",
    account_id: "00000000-1000-4000-8000-000000000001",
    session_id: randomUUID(),
    prompt: assistantMessageId,
    config: {
      workingDirectory: "/tmp",
    },
    chat: {
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/tmp/acp-jobs-order.chat",
      thread_id: "thread-1",
      parent_message_id: userMessageId,
      message_id: assistantMessageId,
      message_date: assistantDate,
      sender_id: "openai-codex-agent",
    },
  };
}

beforeAll(() => {
  closeDatabase();
  initDatabase({ filename: ":memory:" });
  listQueuedAcpJobs();
});

beforeEach(() => {
  getDatabase().prepare("DELETE FROM acp_jobs").run();
});

afterAll(() => {
  closeDatabase();
});

describe("acp job queue ordering", () => {
  it("keeps normal queued turns in FIFO order", async () => {
    const older = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        assistantDate: "2026-03-08T00:00:01.000Z",
      }),
    );
    await delay();
    const newer = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-2",
        assistantMessageId: "assistant-2",
        assistantDate: "2026-03-08T00:00:02.000Z",
      }),
    );
    const queued = listQueuedAcpJobsForThread({
      project_id: older.project_id,
      path: older.path,
      thread_id: older.thread_id,
    });
    expect(queued.map((row) => row.op_id)).toEqual([
      older.op_id,
      newer.op_id,
    ]);

    const first = claimNextQueuedAcpJobForThread({
      project_id: older.project_id,
      path: older.path,
      thread_id: older.thread_id,
    });
    expect(first?.op_id).toBe(older.op_id);
  });

  it("still lets send immediately jump ahead of normal queued turns", async () => {
    const older = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        assistantDate: "2026-03-08T00:00:01.000Z",
      }),
    );
    await delay();
    const newer = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-2",
        assistantMessageId: "assistant-2",
        assistantDate: "2026-03-08T00:00:02.000Z",
      }),
    );

    reprioritizeAcpJobImmediate({
      project_id: newer.project_id,
      path: newer.path,
      user_message_id: newer.user_message_id,
    });

    const queued = listQueuedAcpJobsForThread({
      project_id: older.project_id,
      path: older.path,
      thread_id: older.thread_id,
    });
    expect(queued.map((row) => row.op_id)).toEqual([
      newer.op_id,
      older.op_id,
    ]);

    const first = claimNextQueuedAcpJobForThread({
      project_id: older.project_id,
      path: older.path,
      thread_id: older.thread_id,
    });
    expect(first?.op_id).toBe(newer.op_id);
  });
});
