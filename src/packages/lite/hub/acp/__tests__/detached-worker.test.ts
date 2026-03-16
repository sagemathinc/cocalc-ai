#!/usr/bin/env ts-node
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import { recoverDetachedWorkerStartupState } from "../index";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../sqlite/database";
import {
  claimNextQueuedAcpJobForThread,
  enqueueAcpJob,
  getAcpJob,
  listQueuedAcpJobs,
} from "../../sqlite/acp-jobs";

jest.mock("@cocalc/ai/acp", () => ({
  CodexAcpAgent: class {},
  EchoAgent: class {},
}));
jest.mock("@cocalc/conat/ai/acp/server", () => ({ init: async () => {} }));
jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));
jest.mock("../../sqlite/acp-turns", () => ({
  startAcpTurnLease: jest.fn(),
  heartbeatAcpTurnLease: jest.fn(),
  finalizeAcpTurnLease: jest.fn(),
  updateAcpTurnLeaseSessionId: jest.fn(),
  listRunningAcpTurnLeases: jest.fn(() => []),
}));
jest.mock("@cocalc/chat/server", () => ({
  acquireChatSyncDB: jest.fn(),
  releaseChatSyncDB: jest.fn(),
}));

function makeRequest() {
  return {
    project_id: "00000000-1000-4000-8000-000000000000",
    account_id: "00000000-1000-4000-8000-000000000001",
    session_id: "session-1",
    prompt: "test",
    config: {
      workingDirectory: "/tmp",
    },
    chat: {
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/tmp/detached-worker.chat",
      thread_id: "thread-1",
      parent_message_id: "user-1",
      message_id: "assistant-1",
      message_date: "2026-03-16T00:00:01.000Z",
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

describe("recoverDetachedWorkerStartupState", () => {
  it("does not blanket-interrupt running local detached jobs", async () => {
    const request = makeRequest();
    const queued = enqueueAcpJob(request as any);
    const running = claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
      worker_id: "worker-a",
      worker_bundle_version: "bundle-a",
    });
    expect(running?.state).toBe("running");

    await recoverDetachedWorkerStartupState({} as ConatClient, {
      restartReason: "worker restart",
    });

    const after = getAcpJob({
      project_id: queued.project_id,
      path: queued.path,
      user_message_id: queued.user_message_id,
    });
    expect(after?.state).toBe("running");
    expect(after?.error ?? null).toBeNull();
  });

  it("requeues stale running jobs that never created a lease", async () => {
    const request = makeRequest();
    const queued = enqueueAcpJob(request as any);
    const running = claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
      worker_id: "worker-a",
      worker_bundle_version: "bundle-a",
    });
    expect(running?.state).toBe("running");

    getDatabase()
      .prepare(
        "UPDATE acp_jobs SET started_at = ?, updated_at = ? WHERE op_id = ?",
      )
      .run(Date.now() - 60_000, Date.now() - 60_000, queued.op_id);

    await recoverDetachedWorkerStartupState({} as ConatClient, {
      restartReason: "worker restart",
    });

    const after = getAcpJob({
      project_id: queued.project_id,
      path: queued.path,
      user_message_id: queued.user_message_id,
    });
    expect(after?.state).toBe("queued");
    expect(after?.worker_id ?? null).toBeNull();
    expect(after?.error).toBe("ACP worker stopped before turn startup");
  });
});
