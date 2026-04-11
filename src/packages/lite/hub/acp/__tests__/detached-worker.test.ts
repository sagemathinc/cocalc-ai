#!/usr/bin/env ts-node
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import { CHAT_THREAD_META_ROW_DATE, threadConfigSenderId } from "@cocalc/chat";
import {
  recoverDetachedWorkerStartupState,
  shouldStopDetachedWorkerForIdle,
  turnNeedsInterruptedRepair,
} from "../index";
import * as turns from "../../sqlite/acp-turns";
import * as workers from "../../sqlite/acp-workers";
import * as chatServer from "@cocalc/chat/server";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../sqlite/database";
import {
  claimNextQueuedAcpJobForThread,
  decodeAcpJobRequest,
  enqueueAcpJob,
  getAcpJob,
  listAcpJobsByRecoveryParent,
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
jest.mock("@cocalc/project/logger", () => {
  const makeLogger = () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    extend: (_name?: string) => makeLogger(),
  });
  return {
    __esModule: true,
    rootLogger: makeLogger(),
    default: (name?: string) => makeLogger().extend(name),
    getLogger: (name?: string) => makeLogger().extend(name),
  };
});
jest.mock("../../sqlite/acp-turns", () => ({
  startAcpTurnLease: jest.fn(),
  heartbeatAcpTurnLease: jest.fn(),
  finalizeAcpTurnLease: jest.fn(),
  getAcpTurnLease: jest.fn(),
  updateAcpTurnLeaseSessionId: jest.fn(),
  listRunningAcpTurnLeases: jest.fn(() => []),
}));
jest.mock("../../sqlite/acp-workers", () => ({
  getAcpWorker: jest.fn(),
  heartbeatAcpWorker: jest.fn(),
  listLiveAcpWorkers: jest.fn(() => []),
  stopAcpWorker: jest.fn(),
  upsertAcpWorker: jest.fn(),
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

function makeCommandRequest() {
  return {
    request_kind: "command" as const,
    project_id: "00000000-1000-4000-8000-000000000000",
    account_id: "00000000-1000-4000-8000-000000000001",
    command: "python long_running.py",
    cwd: "/tmp",
    timeout_ms: 60_000,
    max_output_bytes: 100_000,
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
  (turns.getAcpTurnLease as any)?.mockReset?.();
  (turns.getAcpTurnLease as any)?.mockImplementation?.(() => undefined);
  (turns.listRunningAcpTurnLeases as any)?.mockReset?.();
  (turns.listRunningAcpTurnLeases as any)?.mockImplementation?.(() => []);
  (workers.listLiveAcpWorkers as any)?.mockReset?.();
  (workers.listLiveAcpWorkers as any)?.mockImplementation?.(() => []);
  (chatServer.acquireChatSyncDB as any)?.mockReset?.();
  (chatServer.releaseChatSyncDB as any)?.mockReset?.();
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

  it("finalizes stale running jobs when the turn already ended", async () => {
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
    (turns.getAcpTurnLease as any).mockReturnValue({
      project_id: queued.project_id,
      path: queued.path,
      message_date: queued.assistant_message_date,
      message_id: queued.assistant_message_id,
      thread_id: queued.thread_id,
      state: "completed",
      owner_instance_id: "worker-a",
      started_at: Date.now() - 65_000,
      heartbeat_at: Date.now() - 61_000,
      ended_at: Date.now() - 1_000,
      reason: null,
    });

    await recoverDetachedWorkerStartupState({} as ConatClient, {
      restartReason: "worker restart",
    });

    const after = getAcpJob({
      project_id: queued.project_id,
      path: queued.path,
      user_message_id: queued.user_message_id,
    });
    expect(after?.state).toBe("completed");
    expect(after?.worker_id).toBe("worker-a");
    expect(listQueuedAcpJobs()).toHaveLength(0);
  });

  it("reports host-managed startup recovery as a backend restart", async () => {
    const rows: any[] = [
      {
        event: "chat",
        date: "2026-04-02T14:00:00.000Z",
        sender_id: "openai-codex-agent",
        message_id: "assistant-1",
        thread_id: "thread-1",
        generating: true,
        history: [
          {
            author_id: "openai-codex-agent",
            content: "partial answer",
            date: "2026-04-02T14:00:00.000Z",
          },
        ],
      },
    ];
    const sets: any[] = [];
    const syncdb: any = {
      isReady: () => true,
      get: (where: any) =>
        rows.filter((row) =>
          Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
        ),
      get_one: (where: any) =>
        rows.find((row) =>
          Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
        ),
      set: (val: any) => {
        sets.push(val);
        const idx = rows.findIndex(
          (row) =>
            row.event === val.event &&
            row.date === val.date &&
            row.sender_id === val.sender_id,
        );
        if (idx >= 0) {
          rows[idx] = { ...rows[idx], ...val };
        } else {
          rows.push({ ...val });
        }
      },
      commit: jest.fn(),
      save: jest.fn(async () => {}),
      close: async () => {},
    };
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);
    (turns.listRunningAcpTurnLeases as any).mockReturnValue([
      {
        project_id: "00000000-1000-4000-8000-000000000000",
        path: "/tmp/detached-worker.chat",
        message_date: "2026-04-02T14:00:00.000Z",
        sender_id: "openai-codex-agent",
        message_id: "assistant-1",
        thread_id: "thread-1",
        owner_instance_id: "worker-old",
      },
    ]);

    await recoverDetachedWorkerStartupState({} as ConatClient, {
      workerContext: {
        worker_id: "worker-new",
        host_id: "host-1",
        bundle_version: "bundle-1",
        bundle_path: "/bundle",
        state: "active",
      },
      restartReason: "backend server restarted",
    });

    const repaired = sets.find(
      (row: any) => row.event === "chat" && row.generating === false,
    );
    expect(repaired?.acp_interrupted_text).toContain(
      "backend server restarted",
    );
  });

  it("auto-enqueues a Codex recovery continuation after startup repair", async () => {
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

    const rows: any[] = [
      {
        event: "chat",
        date: "2026-03-16T00:00:01.000Z",
        sender_id: "openai-codex-agent",
        message_id: "assistant-1",
        thread_id: "thread-1",
        generating: true,
        history: [
          {
            author_id: "openai-codex-agent",
            content: "partial answer",
            date: "2026-03-16T00:00:01.000Z",
          },
        ],
      },
    ];
    const syncdb: any = {
      isReady: () => true,
      get: (where: any) =>
        rows.filter((row) =>
          Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
        ),
      get_one: (where: any) =>
        rows.find((row) =>
          Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
        ),
      set: (val: any) => {
        const idx = rows.findIndex((row) =>
          row.message_id && val.message_id
            ? row.message_id === val.message_id
            : row.event === val.event &&
              row.date === val.date &&
              row.sender_id === val.sender_id,
        );
        if (idx >= 0) {
          rows[idx] = { ...rows[idx], ...val };
        } else {
          rows.push({ ...val });
        }
      },
      commit: jest.fn(),
      save: jest.fn(async () => {}),
      close: async () => {},
    };
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);
    (turns.listRunningAcpTurnLeases as any).mockReturnValue([
      {
        project_id: request.project_id,
        path: request.chat.path,
        message_date: request.chat.message_date,
        sender_id: request.chat.sender_id,
        message_id: request.chat.message_id,
        thread_id: request.chat.thread_id,
        owner_instance_id: "worker-old",
        started_at: Date.now(),
        heartbeat_at: Date.now(),
      },
    ]);

    await recoverDetachedWorkerStartupState({} as ConatClient, {
      workerContext: {
        worker_id: "worker-new",
        host_id: "host-1",
        bundle_version: "bundle-1",
        bundle_path: "/bundle",
        state: "active",
      },
      restartReason: "backend server restarted",
    });

    const interrupted = getAcpJob({
      project_id: queued.project_id,
      path: queued.path,
      user_message_id: queued.user_message_id,
    });
    expect(interrupted?.state).toBe("interrupted");

    const recoveryChildren = listAcpJobsByRecoveryParent({
      recovery_parent_op_id: queued.op_id,
    });
    expect(recoveryChildren).toHaveLength(1);
    expect(recoveryChildren[0].state).toBe("queued");
    expect(recoveryChildren[0].session_id).toBe("session-1");
    expect(recoveryChildren[0].recovery_count).toBe(1);
    const resumedRequest = decodeAcpJobRequest(recoveryChildren[0] as any);
    expect(resumedRequest.request_kind).toBe("codex");
    if (resumedRequest.request_kind === "command") {
      throw new Error("expected codex recovery request");
    }
    expect(resumedRequest.session_id).toBe("session-1");
    expect(resumedRequest.prompt).toContain(
      "Resume the work from the current workspace state.",
    );
    expect(resumedRequest.chat?.parent_message_id).toBeTruthy();
    const recoveryRow = rows.find(
      (row) =>
        row.event === "chat" &&
        row.message_id === resumedRequest.chat?.parent_message_id,
    );
    expect(recoveryRow).toBeTruthy();
    expect(recoveryRow?.sender_id).toBeTruthy();
  });

  it("resumes looped Codex turns from persisted thread loop state", async () => {
    const request = makeRequest();
    const queued = enqueueAcpJob({
      ...request,
      prompt: "run the first step",
      chat: {
        ...request.chat,
        loop_config: {
          enabled: true,
          max_turns: 8,
        },
        loop_state: {
          loop_id: "loop-1",
          status: "running",
          started_at_ms: 1000,
          updated_at_ms: 2000,
          iteration: 2,
        },
      },
    } as any);
    claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
      worker_id: "worker-a",
      worker_bundle_version: "bundle-a",
    });

    const rows: any[] = [
      {
        event: "chat",
        date: request.chat.message_date,
        sender_id: request.chat.sender_id,
        message_id: request.chat.message_id,
        thread_id: request.chat.thread_id,
        generating: true,
        history: [
          {
            author_id: "openai-codex-agent",
            content: "partial loop output",
            date: request.chat.message_date,
          },
        ],
      },
      {
        event: "chat-thread-config",
        sender_id: threadConfigSenderId("thread-1"),
        date: CHAT_THREAD_META_ROW_DATE,
        thread_id: "thread-1",
        loop_config: {
          enabled: true,
          max_turns: 8,
        },
        loop_state: {
          loop_id: "loop-1",
          status: "scheduled",
          started_at_ms: 1000,
          updated_at_ms: 2500,
          iteration: 2,
          next_prompt: "run the second step",
        },
      },
    ];
    const syncdb: any = {
      isReady: () => true,
      get: (where: any) =>
        rows.filter((row) =>
          Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
        ),
      get_one: (where: any) =>
        rows.find((row) =>
          Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
        ),
      set: (val: any) => {
        const idx = rows.findIndex((row) =>
          row.message_id && val.message_id
            ? row.message_id === val.message_id
            : row.event === val.event &&
              row.date === val.date &&
              row.sender_id === val.sender_id,
        );
        if (idx >= 0) {
          rows[idx] = { ...rows[idx], ...val };
        } else {
          rows.push({ ...val });
        }
      },
      commit: jest.fn(),
      save: jest.fn(async () => {}),
      close: async () => {},
    };
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);
    (turns.listRunningAcpTurnLeases as any).mockReturnValue([
      {
        project_id: request.project_id,
        path: request.chat.path,
        message_date: request.chat.message_date,
        sender_id: request.chat.sender_id,
        message_id: request.chat.message_id,
        thread_id: request.chat.thread_id,
        owner_instance_id: "worker-old",
        started_at: Date.now(),
        heartbeat_at: Date.now(),
      },
    ]);

    await recoverDetachedWorkerStartupState({} as ConatClient, {
      workerContext: {
        worker_id: "worker-new",
        host_id: "host-1",
        bundle_version: "bundle-1",
        bundle_path: "/bundle",
        state: "active",
      },
      restartReason: "backend server restarted",
    });

    const recoveryChildren = listAcpJobsByRecoveryParent({
      recovery_parent_op_id: queued.op_id,
    });
    expect(recoveryChildren).toHaveLength(1);
    const resumedRequest = decodeAcpJobRequest(recoveryChildren[0] as any);
    expect(resumedRequest.request_kind).toBe("codex");
    if (resumedRequest.request_kind === "command") {
      throw new Error("expected codex recovery request");
    }
    expect(resumedRequest.prompt).toContain("run the second step");
    expect(resumedRequest.chat?.loop_config).toEqual({
      enabled: true,
      max_turns: 8,
    });
    expect(resumedRequest.chat?.loop_state).toEqual(
      expect.objectContaining({
        loop_id: "loop-1",
        status: "running",
        iteration: 3,
      }),
    );
    expect(resumedRequest.chat?.loop_state).not.toHaveProperty("next_prompt");
  });

  it("does not auto-resume command jobs during startup recovery", async () => {
    const request = makeCommandRequest();
    const queued = enqueueAcpJob(request as any);
    claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
      worker_id: "worker-a",
      worker_bundle_version: "bundle-a",
    });

    const rows: any[] = [
      {
        event: "chat",
        date: request.chat.message_date,
        sender_id: request.chat.sender_id,
        message_id: request.chat.message_id,
        thread_id: request.chat.thread_id,
        generating: true,
        history: [
          {
            author_id: "openai-codex-agent",
            content: "partial command result",
            date: request.chat.message_date,
          },
        ],
      },
    ];
    const syncdb: any = {
      isReady: () => true,
      get: (where: any) =>
        rows.filter((row) =>
          Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
        ),
      get_one: (where: any) =>
        rows.find((row) =>
          Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
        ),
      set: (val: any) => {
        const idx = rows.findIndex((row) =>
          row.message_id && val.message_id
            ? row.message_id === val.message_id
            : row.event === val.event &&
              row.date === val.date &&
              row.sender_id === val.sender_id,
        );
        if (idx >= 0) {
          rows[idx] = { ...rows[idx], ...val };
        } else {
          rows.push({ ...val });
        }
      },
      commit: jest.fn(),
      save: jest.fn(async () => {}),
      close: async () => {},
    };
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);
    (turns.listRunningAcpTurnLeases as any).mockReturnValue([
      {
        project_id: request.project_id,
        path: request.chat.path,
        message_date: request.chat.message_date,
        sender_id: request.chat.sender_id,
        message_id: request.chat.message_id,
        thread_id: request.chat.thread_id,
        owner_instance_id: "worker-old",
      },
    ]);

    await recoverDetachedWorkerStartupState({} as ConatClient, {
      workerContext: {
        worker_id: "worker-new",
        host_id: "host-1",
        bundle_version: "bundle-1",
        bundle_path: "/bundle",
        state: "active",
      },
      restartReason: "backend server restarted",
    });

    expect(
      listAcpJobsByRecoveryParent({
        recovery_parent_op_id: queued.op_id,
      }),
    ).toHaveLength(0);
    expect(
      getAcpJob({
        project_id: queued.project_id,
        path: queued.path,
        user_message_id: queued.user_message_id,
      })?.state,
    ).toBe("interrupted");
  });

  it("does not auto-resume turns after the recovery timeout window", async () => {
    const request = makeRequest();
    const queued = enqueueAcpJob(request as any);
    claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
      worker_id: "worker-a",
      worker_bundle_version: "bundle-a",
    });

    const rows: any[] = [
      {
        event: "chat",
        date: request.chat.message_date,
        sender_id: request.chat.sender_id,
        message_id: request.chat.message_id,
        thread_id: request.chat.thread_id,
        generating: true,
        history: [
          {
            author_id: "openai-codex-agent",
            content: "partial answer",
            date: request.chat.message_date,
          },
        ],
      },
      {
        event: "chat-thread-config",
        sender_id: threadConfigSenderId("thread-1"),
        date: CHAT_THREAD_META_ROW_DATE,
        thread_id: "thread-1",
        loop_config: {
          enabled: true,
        },
        loop_state: {
          loop_id: "loop-1",
          status: "scheduled",
          started_at_ms: 1000,
          updated_at_ms: 2000,
          iteration: 1,
          next_prompt: "continue",
        },
      },
    ];
    const syncdb: any = {
      isReady: () => true,
      get: (where: any) =>
        rows.filter((row) =>
          Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
        ),
      get_one: (where: any) =>
        rows.find((row) =>
          Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
        ),
      set: (val: any) => {
        const idx = rows.findIndex((row) =>
          row.message_id && val.message_id
            ? row.message_id === val.message_id
            : row.event === val.event &&
              row.date === val.date &&
              row.sender_id === val.sender_id,
        );
        if (idx >= 0) {
          rows[idx] = { ...rows[idx], ...val };
        } else {
          rows.push({ ...val });
        }
      },
      commit: jest.fn(),
      save: jest.fn(async () => {}),
      close: async () => {},
    };
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);
    const staleNow = Date.now() - 3 * 60 * 60_000;
    (turns.listRunningAcpTurnLeases as any).mockReturnValue([
      {
        project_id: request.project_id,
        path: request.chat.path,
        message_date: request.chat.message_date,
        sender_id: request.chat.sender_id,
        message_id: request.chat.message_id,
        thread_id: request.chat.thread_id,
        owner_instance_id: "worker-old",
        started_at: staleNow,
        heartbeat_at: staleNow,
      },
    ]);

    await recoverDetachedWorkerStartupState({} as ConatClient, {
      workerContext: {
        worker_id: "worker-new",
        host_id: "host-1",
        bundle_version: "bundle-1",
        bundle_path: "/bundle",
        state: "active",
      },
      restartReason: "backend server restarted",
    });

    expect(
      listAcpJobsByRecoveryParent({
        recovery_parent_op_id: queued.op_id,
      }),
    ).toHaveLength(0);
    const configRow = rows.find(
      (row) =>
        row.event === "chat-thread-config" &&
        row.thread_id === request.chat.thread_id,
    );
    expect(configRow?.loop_config).toBeNull();
    expect(configRow?.loop_state).toEqual(
      expect.objectContaining({
        status: "stopped",
        stop_reason: "backend_error",
      }),
    );
  });

  it("gives up after the configured recovery retry count", async () => {
    const request = makeRequest();
    const queued = enqueueAcpJob({
      ...request,
      recovery_count: 2,
    } as any);
    claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
      worker_id: "worker-a",
      worker_bundle_version: "bundle-a",
    });

    const rows: any[] = [
      {
        event: "chat",
        date: request.chat.message_date,
        sender_id: request.chat.sender_id,
        message_id: request.chat.message_id,
        thread_id: request.chat.thread_id,
        generating: true,
        history: [
          {
            author_id: "openai-codex-agent",
            content: "partial recovered answer",
            date: request.chat.message_date,
          },
        ],
      },
    ];
    const syncdb: any = {
      isReady: () => true,
      get: (where: any) =>
        rows.filter((row) =>
          Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
        ),
      get_one: (where: any) =>
        rows.find((row) =>
          Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
        ),
      set: (val: any) => {
        const idx = rows.findIndex((row) =>
          row.message_id && val.message_id
            ? row.message_id === val.message_id
            : row.event === val.event &&
              row.date === val.date &&
              row.sender_id === val.sender_id,
        );
        if (idx >= 0) {
          rows[idx] = { ...rows[idx], ...val };
        } else {
          rows.push({ ...val });
        }
      },
      commit: jest.fn(),
      save: jest.fn(async () => {}),
      close: async () => {},
    };
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);
    (turns.listRunningAcpTurnLeases as any).mockReturnValue([
      {
        project_id: request.project_id,
        path: request.chat.path,
        message_date: request.chat.message_date,
        sender_id: request.chat.sender_id,
        message_id: request.chat.message_id,
        thread_id: request.chat.thread_id,
        owner_instance_id: "worker-old",
        started_at: Date.now(),
        heartbeat_at: Date.now(),
      },
    ]);

    await recoverDetachedWorkerStartupState({} as ConatClient, {
      workerContext: {
        worker_id: "worker-new",
        host_id: "host-1",
        bundle_version: "bundle-1",
        bundle_path: "/bundle",
        state: "active",
      },
      restartReason: "backend server restarted",
    });

    expect(
      listAcpJobsByRecoveryParent({
        recovery_parent_op_id: queued.op_id,
      }),
    ).toHaveLength(0);
    expect(
      getAcpJob({
        project_id: queued.project_id,
        path: queued.path,
        user_message_id: queued.user_message_id,
      })?.state,
    ).toBe("interrupted");
  });
});

describe("shouldStopDetachedWorkerForIdle", () => {
  it("does not idle-stop while work is present", () => {
    expect(
      shouldStopDetachedWorkerForIdle({
        hasWork: true,
        idleSince: 0,
        idleExitMs: 5000,
        now: Date.now(),
      }),
    ).toBe(false);
  });

  it("idle-stops only after the worker has actually been idle long enough", () => {
    const now = 50_000;
    expect(
      shouldStopDetachedWorkerForIdle({
        hasWork: false,
        idleSince: now - 4_999,
        idleExitMs: 5_000,
        now,
      }),
    ).toBe(false);
    expect(
      shouldStopDetachedWorkerForIdle({
        hasWork: false,
        idleSince: now - 5_000,
        idleExitMs: 5_000,
        now,
      }),
    ).toBe(true);
  });
});

describe("turnNeedsInterruptedRepair", () => {
  it("does not treat a live detached-worker turn as a stale chat repair", async () => {
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

    await expect(
      turnNeedsInterruptedRepair({
        client: {} as ConatClient,
        turn: {
          project_id: queued.project_id,
          path: queued.path,
          message_date: queued.assistant_message_date,
          message_id: queued.assistant_message_id,
          thread_id: queued.thread_id,
        },
      }),
    ).resolves.toBe(false);
  });
});
