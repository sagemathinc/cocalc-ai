#!/usr/bin/env ts-node
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import { randomUUID } from "node:crypto";
import { CHAT_THREAD_META_ROW_DATE, threadConfigSenderId } from "@cocalc/chat";
import {
  ChatStreamWriter,
  acpTestInternals,
  disposeAllChatWritersForTests,
  finalizeInterruptedAcpBackendState,
  configureAcpDetachedWorkerRunning,
  fenceAcpProjectAfterStop,
  isFatalAcpWorkerStorageError,
  isProjectAcpStorageError,
  recoverCurrentWorkerStuckAcpTurns,
  recoverDetachedWorkerStartupState,
  recoverOrphanedAcpTurns,
  recoverOrphanedRunningAcpJobsWithoutLease,
  shouldCompleteAcpTurnAfterTerminalStorageFailure,
  shouldStopDetachedWorkerForDrain,
  shouldStopDetachedWorkerForIdle,
  shouldExitAcpWorkerAfterHeartbeatFailure,
  processAcpProjectFenceIntents,
  releaseAcpProjectFenceResumesAfterStart,
  turnNeedsInterruptedRepair,
} from "../index";
import * as turns from "../../sqlite/acp-turns";
import * as workers from "../../sqlite/acp-workers";
import * as chatServer from "@cocalc/chat/server";
import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import {
  ACP_FENCE_CHAT_FINALIZED,
  ACP_FENCE_INTENT_RESUME_PENDING,
  ACP_FENCE_INTENT_RESUME_READY,
  ACP_FENCE_INTENT_STOPPED,
  ACP_PROJECT_RESUME_FENCE_REASON,
  stopAcpFenceResumesForThread,
  cancelQueuedAcpJob,
  claimNextQueuedAcpJobForThread,
  decodeAcpJobRequest,
  enqueueAcpJob,
  enqueueAcpJobCancelingQueuedRecoveries,
  getAcpJob,
  getAcpJobByOpId,
  listAcpJobsByRecoveryParent,
  listAcpJobsWithRecoveryIntent,
  listQueuedAcpJobs,
  setAcpJobState,
} from "../../sqlite/acp-jobs";
import { setAcpAdmissionLimitsProvider } from "../admission";
import { listPendingAcpSteers } from "../../sqlite/acp-steers";
import { listDueAgentRpcReports } from "../../sqlite/agent-rpc-reports";
import {
  parseTurnOutcome,
  withTurnFailure,
} from "@cocalc/conat/ai/acp/turn-outcome";
import { hubApi } from "../../api";
import {
  setHarnessLauncher,
  harnessRuntimeKey,
  prepareHarnessRequest,
} from "../harness-runtime";
import {
  enqueueAcpInterrupt,
  listPendingAcpInterrupts,
} from "../../sqlite/acp-interrupts";
import {
  getAcpAttention,
  submitAcpAttentionResponse,
  upsertAcpAttention,
} from "../../sqlite/acp-attention";

jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/ai/acp", () => ({
  getCodexProjectSpawner: () => ({}),
  assertSameTurnPrincipal:
    jest.requireActual("@cocalc/ai/acp").assertSameTurnPrincipal,
  CODEX_ACP_RECOVERY_ERROR_CODE: {
    appServerExited: "codex_app_server_exited",
    commandBlocked: "codex_command_blocked",
    modelCapacity: "codex_model_capacity",
    resourceKilled: "codex_resource_killed",
    turnLost: "codex_turn_lost",
    harnessKilled: "acp_harness_killed",
  },
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
  fenceAcpTurnLeasesForProject: jest.fn(() => 0),
  countRunningAcpTurnLeasesForWorker: jest.fn(() => 0),
  startAcpTurnLease: jest.fn(),
  heartbeatAcpTurnLease: jest.fn(),
  finalizeAcpTurnLease: jest.fn(),
  getAcpTurnLease: jest.fn(),
  updateAcpTurnLeaseSessionId: jest.fn(),
  listRunningAcpTurnLeases: jest.fn(() => []),
  listRecentTerminalAcpTurnLeases: jest.fn(() => []),
}));
jest.mock("../../sqlite/acp-workers", () => ({
  getAcpWorker: jest.fn(),
  heartbeatAcpWorker: jest.fn(),
  listAcpWorkers: jest.fn(() => []),
  listLiveAcpWorkers: jest.fn(() => []),
  stopAcpWorker: jest.fn(),
  upsertAcpWorker: jest.fn(),
}));
jest.mock("@cocalc/chat/server", () => ({
  acquireChatSyncDB: jest.fn(),
  releaseChatSyncDB: jest.fn(),
}));

describe("detached worker queue liveness", () => {
  it("lets a draining worker claim only work pinned to itself", () => {
    const draining = {
      worker_id: "worker-old",
      state: "draining",
    } as any;

    expect(
      acpTestInternals.detachedWorkerCanClaimQueuedJob(
        { worker_id: "worker-old" } as any,
        draining,
      ),
    ).toBe(true);
    expect(
      acpTestInternals.detachedWorkerCanClaimQueuedJob(
        { worker_id: null } as any,
        draining,
      ),
    ).toBe(false);
    expect(
      acpTestInternals.detachedWorkerCanClaimQueuedJob(
        { worker_id: "worker-new" } as any,
        draining,
      ),
    ).toBe(false);
  });

  it("records a successful poll even when the queued job cannot be claimed", () => {
    const context = { last_queue_progress_at: 1 } as any;

    acpTestInternals.noteDetachedWorkerQueuePoll({
      context,
      now: 42_000,
    });

    expect(context.last_queue_progress_at).toBe(42_000);
  });

  it("releases stale affinity before the outer queue kick checks it", () => {
    const queued = enqueueAcpJob(makeRequest() as any, {
      preferred_worker_id: "worker-dead",
    });
    (workers.getAcpWorker as jest.Mock).mockReturnValue({
      worker_id: "worker-dead",
      state: "stopped",
      last_heartbeat_at: Date.now(),
    });

    const next = acpTestInternals.nextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
    });

    expect(next?.op_id).toBe(queued.op_id);
    expect(next?.worker_id).toBeNull();
    expect(next?.worker_bundle_version).toBeNull();
    expect(
      getAcpJob({
        project_id: queued.project_id,
        path: queued.path,
        user_message_id: queued.user_message_id,
      })?.worker_id,
    ).toBeNull();
  });

  it("bounds retries for an admission-blocked queued thread", async () => {
    const queued = enqueueAcpJob(makeRequest() as any);
    const retry = {
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
    };

    const admission = jest.fn(async () => ({ runningPerAccount: 0 }));
    setAcpAdmissionLimitsProvider(admission);

    acpTestInternals.kickQueuedAcpJobsForThread(retry);
    await new Promise((resolve) => setImmediate(resolve));

    expect(admission).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 100; i++) {
      acpTestInternals.kickQueuedAcpJobsForThread(retry);
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(admission).toHaveBeenCalledTimes(1);
    expect(acpTestInternals.queuedAcpJobThreadRetryCount()).toBe(1);
    acpTestInternals.cancelQueuedAcpJobThreadRetries();
    expect(acpTestInternals.queuedAcpJobThreadRetryCount()).toBe(0);
  });
});

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

it("a turn that cannot start still records how it ended", async () => {
  const original = process.env.COCALC_ACP_HARNESSES;
  process.env.COCALC_ACP_HARNESSES = "1";
  setHarnessLauncher(async () => {
    throw Error("must not launch");
  });
  const originalAuthorize = hubApi.agent.authorizeRpcExecution;
  hubApi.agent.authorizeRpcExecution = jest
    .fn()
    .mockRejectedValue(Error("network membership revoked"));
  const base = makeRequest();
  try {
    const job = enqueueAcpJob({
      ...base,
      config: undefined,
      runtime: {
        version: 1,
        kind: "acp",
        profile: {
          version: 1,
          kind: "acp",
          id: "fixture",
          revision: "1",
          executable: "/home/user/fixture",
          args: [],
          cwd: "/home/user",
          executionPolicy: "full-access",
          credentialMode: "project-managed",
        },
      },
      chat: {
        ...base.chat,
        message_id: randomUUID(),
        parent_message_id: randomUUID(),
        agent_rpc_execution: {
          version: 3,
          source: { agent_id: randomUUID(), project_id: randomUUID() },
          source_run_id: randomUUID(),
          target: { agent_id: randomUUID(), project_id: base.project_id },
          target_path: base.chat.path,
          target_thread_id: base.chat.thread_id,
          agent_network_id: randomUUID(),
          network_generation: randomUUID(),
          account_generation: 0,
          configured_delivery: "queued",
          principal_account_id: base.account_id,
          guidance: false,
        },
      },
    } as any);
    const queuedRequest = decodeAcpJobRequest(job);
    jest.mocked(chatServer.acquireChatSyncDB).mockResolvedValue(
      makeSyncdb([
        {
          event: "chat-thread-config",
          thread_id: job.thread_id,
          agent_kind: "acp",
          agent_runtime: queuedRequest.runtime,
        },
      ]) as any,
    );
    acpTestInternals.initializeAcpRuntime({
      sync: { akv: () => ({}) },
    } as unknown as ConatClient);
    const claimed = claimNextQueuedAcpJobForThread({
      project_id: job.project_id,
      path: job.path,
      thread_id: job.thread_id,
    })!;
    await acpTestInternals.runQueuedAcpJob(claimed);
    const row = getAcpJobByOpId(job.op_id);
    expect(row?.state).toBe("error");
    const outcome = parseTurnOutcome(row?.outcome_json);
    expect(outcome).toMatchObject({ version: 1, state: "failed" });
    // Nothing is claimed about tools it never got to run.
    expect(outcome && "tool_ran" in outcome).toBe(false);
  } finally {
    hubApi.agent.authorizeRpcExecution = originalAuthorize;
    setHarnessLauncher();
    if (original === undefined) delete process.env.COCALC_ACP_HARNESSES;
    else process.env.COCALC_ACP_HARNESSES = original;
  }
});

it.each(["network membership revoked", "authorization service unavailable"])(
  "persisted generic peer execution refuses launch when %s",
  async (message) => {
    const original = process.env.COCALC_ACP_HARNESSES;
    process.env.COCALC_ACP_HARNESSES = "1";
    const launch = jest.fn(async () => {
      throw Error("must not launch");
    });
    setHarnessLauncher(launch);
    const originalAuthorize = hubApi.agent.authorizeRpcExecution;
    const authorize = jest.fn().mockRejectedValueOnce(Error(message));
    hubApi.agent.authorizeRpcExecution = authorize;
    const base = makeRequest();
    const authorization = {
      version: 3,
      source: { agent_id: randomUUID(), project_id: randomUUID() },
      source_run_id: randomUUID(),
      target: { agent_id: randomUUID(), project_id: base.project_id },
      target_path: base.chat.path,
      target_thread_id: base.chat.thread_id,
      agent_network_id: randomUUID(),
      network_generation: randomUUID(),
      account_generation: 0,
      configured_delivery: "queued",
      principal_account_id: base.account_id,
      guidance: false,
    };
    const stream = jest.fn(async () => {});
    try {
      const job = enqueueAcpJob({
        ...base,
        config: undefined,
        runtime: {
          version: 1,
          kind: "acp",
          profile: {
            version: 1,
            kind: "acp",
            id: "fixture",
            revision: "1",
            executable: "/home/user/fixture",
            args: [],
            cwd: "/home/user",
            executionPolicy: "full-access",
            credentialMode: "project-managed",
          },
        },
        chat: { ...base.chat, agent_rpc_execution: authorization },
      } as any);
      const admitted = decodeAcpJobRequest(job);
      await expect(
        acpTestInternals.executeAcpRequest({
          ...admitted,
          stream,
        } as any),
      ).rejects.toThrow(message);
      expect(authorize).toHaveBeenCalledWith({
        account_id: base.account_id,
        authorization,
      });
      expect(launch).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
    } finally {
      if (originalAuthorize === undefined)
        delete (hubApi.agent as any).authorizeRpcExecution;
      else hubApi.agent.authorizeRpcExecution = originalAuthorize;
      setHarnessLauncher();
      if (original === undefined) delete process.env.COCALC_ACP_HARNESSES;
      else process.env.COCALC_ACP_HARNESSES = original;
    }
  },
);

it.each([
  [
    "the agent's own signal",
    () =>
      withTurnFailure(new Error("Claude could not run this request."), {
        kind: "limit",
        scope: "credential",
        resets_at: 1_800_000_000_000,
      }),
    {
      state: "failed",
      failure: {
        kind: "limit",
        scope: "credential",
        resets_at: 1_800_000_000_000,
      },
      tool_ran: true,
      classified_by: "signal",
    },
  ],
  [
    "only the error text",
    () => new Error("You've hit your weekly limit"),
    {
      state: "failed",
      failure: { kind: "limit", scope: "credential" },
      tool_ran: true,
      classified_by: "text",
    },
  ],
  ["a completed turn", undefined, { state: "completed" }],
  [
    "a turn that only asked for permission",
    () => new Error("boom"),
    { state: "failed", failure: { kind: "error" }, tool_ran: false },
    false,
  ],
  [
    "a turn whose tool call failed (it may have changed something)",
    () => new Error("boom"),
    { state: "failed", failure: { kind: "error" }, tool_ran: true },
    true,
    "failed",
  ],
] as const)(
  "records how a queued turn ended, from %s",
  async (
    _name,
    failWith,
    expected,
    runsTool: boolean = true,
    toolStatus: string = "in_progress",
  ) => {
    const previousEnabled = process.env.COCALC_ACP_HARNESSES;
    process.env.COCALC_ACP_HARNESSES = "1";
    setHarnessLauncher(async () => {
      throw Error("unexpected launch");
    });
    const request = prepareHarnessRequest({
      ...makeRequest(),
      session_id: undefined,
      config: undefined,
      runtime: {
        version: 1,
        kind: "acp",
        profile: {
          version: 2,
          kind: "acp",
          id: "claude-code",
          revision: "0.93.0",
          cwd: "/home/user",
          credentialMode: "project-managed",
          executionPolicy: "full-access",
        },
      },
      harness_credential: {
        version: 1,
        provider: "anthropic",
        mode: "account-subscription",
        credentialId: "33333333-3333-4333-8333-333333333333",
      },
    });
    const job = enqueueAcpJob(request);
    jest.mocked(chatServer.acquireChatSyncDB).mockResolvedValue(
      makeSyncdb([
        {
          event: "chat-thread-config",
          thread_id: request.chat!.thread_id,
          agent_kind: "acp",
          agent_runtime: request.runtime,
        },
      ]) as any,
    );
    acpTestInternals.initializeAcpRuntime({
      sync: { akv: () => ({}) },
    } as unknown as ConatClient);
    jest
      .spyOn(ChatStreamWriter.prototype as any, "persistLog")
      .mockResolvedValue(undefined);
    const evaluate = jest.fn(async ({ stream }: any) => {
      await stream({
        type: "event",
        event: {
          type: "harness",
          source: "acp",
          kind: "update",
          // Waiting for permission is not running.
          kind: "permission",
          data: { toolCallId: "t1", outcome: "cancelled" },
        },
      });
      await stream({
        type: "event",
        event: {
          type: "harness",
          source: "acp",
          kind: "update",
          data: {
            sessionUpdate: "tool_call",
            toolCallId: "t0",
            status: "pending",
          },
        },
      });
      if (runsTool)
        await stream({
          type: "event",
          event: {
            type: "harness",
            source: "acp",
            kind: "update",
            data: {
              sessionUpdate: "tool_call_update",
              toolCallId: "t1",
              status: toolStatus,
            },
          },
        });
      if (failWith) throw failWith();
      await stream({ type: "summary", finalResponse: "done" });
    });
    const unregister = acpTestInternals.registerInterruptAgentForTests(
      harnessRuntimeKey(request),
      request.project_id,
      { evaluate } as any,
      true,
    );
    try {
      const claimed = claimNextQueuedAcpJobForThread({
        project_id: job.project_id,
        path: job.path,
        thread_id: job.thread_id,
      })!;
      await acpTestInternals.runQueuedAcpJob(claimed);
      expect(evaluate).toHaveBeenCalledTimes(1);
      const outcome = parseTurnOutcome(
        getAcpJobByOpId(job.op_id)?.outcome_json,
      );
      expect(outcome).toMatchObject({ version: 1, ...expected });
    } finally {
      unregister();
      setHarnessLauncher();
      if (previousEnabled === undefined)
        delete process.env.COCALC_ACP_HARNESSES;
      else process.env.COCALC_ACP_HARNESSES = previousEnabled;
    }
  },
);

it.each(["created-by-preceding-turn", ""])(
  "passes refreshed human queue context %j to a cold ACP runtime with admitted settings",
  async (currentSessionId) => {
    const previousEnabled = process.env.COCALC_ACP_HARNESSES;
    process.env.COCALC_ACP_HARNESSES = "1";
    setHarnessLauncher(async () => {
      throw Error("unexpected launch");
    });
    const request = prepareHarnessRequest({
      ...makeRequest(),
      session_id: undefined,
      config: undefined,
      runtime: {
        version: 1,
        kind: "acp",
        profile: {
          version: 2,
          kind: "acp",
          id: "claude-code",
          revision: "0.93.0",
          cwd: "/home/user",
          credentialMode: "project-managed",
          executionPolicy: "full-access",
        },
        settings: { configOptions: [{ id: "model", value: "admitted-model" }] },
      },
      harness_credential: {
        version: 1,
        provider: "anthropic",
        mode: "account-subscription",
        credentialId: "33333333-3333-4333-8333-333333333333",
        claudeAiConnectors: false,
      },
    });
    const job = enqueueAcpJob(request);
    const rows = [
      {
        event: "chat-thread-config",
        thread_id: request.chat!.thread_id,
        agent_kind: "acp",
        agent_runtime: {
          ...request.runtime,
          settings: { configOptions: [{ id: "model", value: "next-model" }] },
        },
        agent_session_id: currentSessionId,
      },
    ];
    jest
      .mocked(chatServer.acquireChatSyncDB)
      .mockResolvedValue(makeSyncdb(rows) as any);
    acpTestInternals.initializeAcpRuntime({
      sync: { akv: () => ({}) },
    } as unknown as ConatClient);
    // Keep this regression at the durable queue -> runtime boundary; log-store
    // durability is covered by the storage/recovery tests below.
    jest
      .spyOn(ChatStreamWriter.prototype as any, "persistLog")
      .mockResolvedValue(undefined);
    const evaluate = jest.fn(async () => {});
    const unregister = acpTestInternals.registerInterruptAgentForTests(
      harnessRuntimeKey(request),
      request.project_id,
      { evaluate } as any,
      true,
    );
    try {
      const claimed = claimNextQueuedAcpJobForThread({
        project_id: job.project_id,
        path: job.path,
        thread_id: job.thread_id,
      })!;
      await acpTestInternals.runQueuedAcpJob(claimed);
      expect(
        getAcpJob({
          project_id: job.project_id,
          path: job.path,
          user_message_id: job.user_message_id,
        })?.error,
      ).toBeFalsy();
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          session_id: currentSessionId,
          runtime: request.runtime,
          harness_credential: request.harness_credential,
        }),
      );
      expect(decodeAcpJobRequest(job).session_id).toBeUndefined();
    } finally {
      unregister();
      setHarnessLauncher();
      if (previousEnabled === undefined)
        delete process.env.COCALC_ACP_HARNESSES;
      else process.env.COCALC_ACP_HARNESSES = previousEnabled;
    }
  },
);

beforeAll(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
  listQueuedAcpJobs();
});

beforeEach(() => {
  setAcpAdmissionLimitsProvider(undefined);
  acpTestInternals.cancelQueuedAcpJobThreadRetries();
  getAcpDatabase().prepare("DELETE FROM acp_jobs").run();
  jest.restoreAllMocks();
  (turns.startAcpTurnLease as any)?.mockReset?.();
  (turns.heartbeatAcpTurnLease as any)?.mockReset?.();
  (turns.finalizeAcpTurnLease as any)?.mockReset?.();
  (turns.getAcpTurnLease as any)?.mockReset?.();
  (turns.getAcpTurnLease as any)?.mockImplementation?.(() => undefined);
  (turns.listRunningAcpTurnLeases as any)?.mockReset?.();
  (turns.listRunningAcpTurnLeases as any)?.mockImplementation?.(() => []);
  (turns.listRecentTerminalAcpTurnLeases as any)?.mockReset?.();
  (turns.listRecentTerminalAcpTurnLeases as any)?.mockImplementation?.(
    () => [],
  );
  (workers.getAcpWorker as any)?.mockReset?.();
  (workers.getAcpWorker as any)?.mockImplementation?.(() => undefined);
  (workers.listAcpWorkers as any)?.mockReset?.();
  (workers.listAcpWorkers as any)?.mockImplementation?.(() => []);
  (workers.listLiveAcpWorkers as any)?.mockReset?.();
  (workers.listLiveAcpWorkers as any)?.mockImplementation?.(() => []);
  (chatServer.acquireChatSyncDB as any)?.mockReset?.();
  (chatServer.releaseChatSyncDB as any)?.mockReset?.();
});

afterEach(async () => {
  acpTestInternals.setDetachedWorkerContextForTests(null);
  acpTestInternals.cancelDelayedAcpQueueWake();
  jest.restoreAllMocks();
  await disposeAllChatWritersForTests();
});

afterAll(() => {
  closeAcpDatabase();
});

it("finalizes only the spoken turn when another turn starts in the same thread", () => {
  const common = {
    project_id: "project-1",
    path: "test.chat",
    thread_id: "thread-1",
    state: "running",
    owner_instance_id: "worker-1",
  };
  (turns.listRunningAcpTurnLeases as jest.Mock).mockReturnValue([
    {
      ...common,
      message_id: "turn-a",
      message_date: "2026-09-25T00:00:00.000Z",
    },
    {
      ...common,
      message_id: "turn-b",
      message_date: "2026-09-25T00:00:01.000Z",
    },
  ]);
  finalizeInterruptedAcpBackendState({
    turn: {
      project_id: common.project_id,
      path: common.path,
      thread_id: common.thread_id,
      message_id: "turn-a",
      message_date: "2026-09-25T00:00:00.000Z",
    },
    exactMessageId: true,
  });
  expect(turns.finalizeAcpTurnLease).toHaveBeenCalledTimes(1);
  expect(turns.finalizeAcpTurnLease).toHaveBeenCalledWith(
    expect.objectContaining({
      key: expect.objectContaining({
        message_date: "2026-09-25T00:00:00.000Z",
      }),
    }),
  );
});

it("project fencing retains a failed harness cleanup for the next attempt", async () => {
  const request = makeRequest();
  const dispose = jest
    .fn()
    .mockRejectedValueOnce(Error("temporary removal failure"))
    .mockResolvedValue(undefined);
  const unregister = acpTestInternals.registerInterruptAgentForTests(
    "cleanup-retry-harness",
    request.project_id,
    { dispose } as any,
    true,
  );
  try {
    await expect(
      fenceAcpProjectAfterStop({ project_id: request.project_id }),
    ).rejects.toThrow("temporary removal failure");
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(
      fenceAcpProjectAfterStop({ project_id: request.project_id }),
    ).resolves.toMatchObject({ disposed_agents: 1 });
    expect(dispose).toHaveBeenCalledTimes(2);
    await expect(
      fenceAcpProjectAfterStop({ project_id: request.project_id }),
    ).resolves.toMatchObject({ disposed_agents: 0 });
    expect(dispose).toHaveBeenCalledTimes(2);
  } finally {
    unregister();
  }
});

it.each(["lost", "terminal", "live"])(
  "worker recovery reconciles synchronous questions with a %s responder",
  async (responder) => {
    const request = makeRequest();
    const record = upsertAcpAttention({
      project_id: request.project_id,
      account_id: request.account_id,
      path: request.chat.path,
      thread_id: request.chat.thread_id,
      turn_id: "question-turn",
      source_kind: "codex_sync_question",
      source_id: `worker-question-${responder}`,
      attention_kind: "question",
      is_blocking: true,
      title: "ACP needs input",
      questions: [
        { id: "target", header: "Target", question: "Choose target" },
      ],
      chat: request.chat,
    });
    (turns.getAcpTurnLease as jest.Mock).mockReturnValue({
      state: responder === "terminal" ? "completed" : "running",
      owner_instance_id: "question-worker",
      pid: responder === "lost" ? null : process.pid,
      heartbeat_at: responder === "lost" ? 1 : Date.now(),
      started_at: 1,
    });
    try {
      await recoverDetachedWorkerStartupState({} as ConatClient);
      expect(getAcpAttention(record.attention_id)?.state).toBe(
        responder === "live" ? "pending" : "stale",
      );
      if (responder !== "live") {
        expect(
          getAcpAttention(record.attention_id)?.resolution_reason,
        ).toContain("responder was lost");
        expect(
          submitAcpAttentionResponse({
            attention_id: record.attention_id,
            project_id: request.project_id,
            account_id: request.account_id,
            response_id: "late-answer",
            answers: { target: ["local"] },
          }),
        ).toMatchObject({
          state: "already_submitted",
          record: { state: "stale" },
        });
        expect(
          getAcpAttention(record.attention_id)?.response_id,
        ).toBeUndefined();
      }
    } finally {
      getAcpDatabase()
        .prepare("DELETE FROM acp_attention_requests WHERE attention_id = ?")
        .run(record.attention_id);
    }
  },
);

it.each([
  ["direct", "1"],
  ["durable", "1"],
  ["direct", "0"],
  ["durable", "0"],
])(
  "%s harness cancel with admission flag %s waits for the prompt outcome",
  async (delivery, enabled) => {
    const previousEnabled = process.env.COCALC_ACP_HARNESSES;
    const request = {
      ...makeRequest(),
      config: undefined,
      runtime: {
        version: 1,
        kind: "acp",
        profile: {
          version: 1,
          kind: "acp",
          id: "fixture",
          revision: "1",
          executable: "/home/user/fixture",
          args: [],
          cwd: "/home/user",
          executionPolicy: "full-access",
          credentialMode: "project-managed",
        },
      },
    } satisfies AcpRequest;
    const job = enqueueAcpJob(request);
    claimNextQueuedAcpJobForThread({
      project_id: job.project_id,
      path: job.path,
      thread_id: job.thread_id,
      worker_id: "worker-P",
    });
    const interruptOutstanding = jest.fn(async () => true);
    const unregister = acpTestInternals.registerInterruptAgentForTests(
      "cancel-test",
      request.project_id,
      { interruptOutstanding } as any,
      true,
    );
    try {
      // The rollback switch applies to new admissions, not existing stop requests.
      process.env.COCALC_ACP_HARNESSES = enabled;
      if (delivery === "direct") {
        expect(
          await acpTestInternals.handleInterruptRequest({
            ...request,
            threadId: request.chat.thread_id,
          }),
        ).toMatchObject({ ok: true, state: "queued" });
      } else {
        enqueueAcpInterrupt({
          project_id: job.project_id,
          path: job.path,
          thread_id: job.thread_id,
          chat: request.chat,
        });
        await acpTestInternals.processPendingAcpInterruptsOnce();
        expect(listPendingAcpInterrupts()).toHaveLength(0);
      }
      expect(interruptOutstanding).toHaveBeenCalledTimes(1);
      const key = {
        project_id: job.project_id,
        path: job.path,
        user_message_id: job.user_message_id,
      };
      expect(getAcpJob(key)?.state).toBe("running");
      expect(turns.finalizeAcpTurnLease).not.toHaveBeenCalled();
      // The worker, not the cancellation transport, owns finalization.
      setAcpJobState({
        op_id: job.op_id,
        state: "error",
        worker_id: "worker-P",
      });
      expect(getAcpJob(key)?.state).toBe("error");
    } finally {
      if (previousEnabled === undefined)
        delete process.env.COCALC_ACP_HARNESSES;
      else process.env.COCALC_ACP_HARNESSES = previousEnabled;
      unregister();
    }
  },
);

it("targeted harness cancellation leaves other turn interrupts pending", async () => {
  const request = makeRequest();
  const expectedMessageId = request.chat.message_id!;
  const sessionId = "harness-session";
  (turns.listRunningAcpTurnLeases as jest.Mock).mockReturnValue([
    {
      project_id: request.project_id,
      path: request.chat.path,
      thread_id: request.chat.thread_id,
      message_id: expectedMessageId,
      session_id: sessionId,
    },
  ]);
  for (const messageId of [expectedMessageId, "another-turn"]) {
    enqueueAcpInterrupt({
      project_id: request.project_id,
      path: request.chat.path,
      thread_id: request.chat.thread_id!,
      chat: { ...request.chat, message_id: messageId },
      expected_message_id: messageId,
      expected_session_id: sessionId,
    });
  }
  const interruptOutstanding = jest.fn(async () => true);
  const unregister = acpTestInternals.registerInterruptAgentForTests(
    "targeted-cancel-harness",
    request.project_id,
    { interruptOutstanding } as any,
    true,
  );
  try {
    await expect(
      acpTestInternals.handleInterruptRequest({
        ...request,
        threadId: request.chat.thread_id,
        expected_message_id: expectedMessageId,
        expected_session_id: sessionId,
      }),
    ).resolves.toMatchObject({ ok: true, state: "queued" });
    expect(interruptOutstanding).toHaveBeenCalledWith(
      sessionId,
      expectedMessageId,
    );
    expect(listPendingAcpInterrupts()).toEqual([
      expect.objectContaining({ expected_message_id: "another-turn" }),
    ]);
    expect(turns.finalizeAcpTurnLease).not.toHaveBeenCalled();
  } finally {
    unregister();
    getAcpDatabase().prepare("DELETE FROM acp_interrupts").run();
  }
});

it("preserves native interruption finalization", async () => {
  const request = makeRequest();
  const job = enqueueAcpJob(request);
  claimNextQueuedAcpJobForThread({
    project_id: job.project_id,
    path: job.path,
    thread_id: job.thread_id,
    worker_id: "worker-P",
  });
  const unregister = acpTestInternals.registerInterruptAgentForTests(
    "native-cancel-test",
    request.project_id,
    { interruptOutstanding: async () => true } as any,
    false,
  );
  try {
    expect(
      await acpTestInternals.handleInterruptRequest({
        ...request,
        threadId: request.chat.thread_id,
      }),
    ).toMatchObject({ ok: true, state: "interrupted" });
    expect(
      getAcpJob({
        project_id: job.project_id,
        path: job.path,
        user_message_id: job.user_message_id,
      })?.state,
    ).toBe("interrupted");
  } finally {
    unregister();
  }
});

it("rejects another human before durable steering while permitting an ordinary queued turn", () => {
  const request = makeRequest();
  enqueueAcpJob(request);
  claimNextQueuedAcpJobForThread({
    project_id: request.project_id,
    path: request.chat.path,
    thread_id: request.chat.thread_id,
    worker_id: "worker-P",
  });
  expect(() =>
    acpTestInternals.assertRunningJobSteerPrincipal({
      ...request,
      account_id: "Q",
    }),
  ).toThrow("Queue a new turn under your account");
  expect(() =>
    acpTestInternals.assertRunningJobSteerPrincipal(request),
  ).not.toThrow();
  const queued = enqueueAcpJob({
    ...request,
    account_id: "Q",
    chat: {
      ...request.chat,
      parent_message_id: "user-Q",
      message_id: "assistant-Q",
      message_date: "2026-03-16T00:01:01.000Z",
    },
  });
  expect(queued.account_id).toBe("Q");
  expect(queued.state).toBe("queued");
});

function makeSyncdb(rows: any[] = []) {
  return {
    isReady: () => true,
    get: (where?: any) => {
      if (where == null) return rows;
      return rows.filter((row) =>
        Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
      );
    },
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
}

describe("terminal failure recovery", () => {
  it("recovers a real SQLite-full terminal write without replaying the harness", async () => {
    const queued = enqueueAcpJob({
      ...makeRequest(),
      runtime: { version: 1, kind: "acp", profile: {} },
    } as any);
    claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
      worker_id: "gone",
      worker_bundle_version: "old",
    });
    const db = getAcpDatabase();
    db.prepare(
      "UPDATE acp_jobs SET started_at = ?, updated_at = ? WHERE op_id = ?",
    ).run(Date.now() - 60_000, Date.now() - 60_000, queued.op_id);
    const limit = db.prepare("PRAGMA max_page_count").get().max_page_count;
    const pages = db.prepare("PRAGMA page_count").get().page_count;
    let storageError: unknown;
    try {
      // Restrict only this test database, without filling the host filesystem.
      db.exec(`PRAGMA max_page_count = ${pages}`);
      try {
        setAcpJobState({
          op_id: queued.op_id,
          state: "error",
          error: "x".repeat(1024 * 1024),
        });
      } catch (error) {
        storageError = error;
      }
      expect(storageError).toBeDefined();
      expect(`${storageError}`).toContain("database or disk is full");
      expect(isFatalAcpWorkerStorageError(storageError)).toBe(true);
      expect(
        shouldCompleteAcpTurnAfterTerminalStorageFailure({
          err: storageError,
          phase: "terminal-summary",
          finishedBy: "summary",
          terminalRowAlreadyPersisted: true,
        }),
      ).toBe(false);
      expect(
        getAcpJob({
          project_id: queued.project_id,
          path: queued.path,
          user_message_id: queued.user_message_id,
        })?.state,
      ).toBe("running");
    } finally {
      db.exec(`PRAGMA max_page_count = ${limit}`);
    }

    await recoverOrphanedRunningAcpJobsWithoutLease({ graceMs: 0 });
    const recovered = getAcpJob({
      project_id: queued.project_id,
      path: queued.path,
      user_message_id: queued.user_message_id,
    });
    expect(recovered?.state).toBe("error");
    expect(recovered?.error).toContain("completion is unknown");
    expect(listQueuedAcpJobs()).toHaveLength(0);
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: queued.op_id }),
    ).toHaveLength(0);
  });

  it("resumes a harness turn whose agent was killed once, with memory guidance", async () => {
    const request = {
      ...makeRequest(),
      runtime: { version: 1, kind: "acp", profile: {} },
    };
    const queued = enqueueAcpJob(request as any);
    const rows: any[] = [];
    (chatServer.acquireChatSyncDB as jest.Mock).mockImplementation(async () =>
      makeSyncdb(rows),
    );
    const detail = JSON.stringify({ agent: "Claude", oom: true });
    const resumed = await acpTestInternals.enqueueFailureRecoveryContinuation({
      client: {} as ConatClient,
      job: { ...queued, started_at: Date.now() },
      recoveryCode: "acp_harness_killed",
      recoveryDetail: detail,
    });
    expect(resumed?.recovery_count).toBe(1);
    const prompt = (decodeAcpJobRequest(resumed as any) as any).prompt;
    expect(prompt).toContain("ran out of memory");
    expect(prompt).toContain("one at a time");
    // Not a second time in a row.
    expect(
      await acpTestInternals.enqueueFailureRecoveryContinuation({
        client: {} as ConatClient,
        job: { ...(resumed as any), started_at: Date.now() },
        recoveryCode: "acp_harness_killed",
        recoveryDetail: detail,
      }),
    ).toBeUndefined();
  });

  it("does not apply the harness kill recovery to a Codex job", async () => {
    const queued = enqueueAcpJob(makeRequest() as any);
    expect(
      await acpTestInternals.enqueueFailureRecoveryContinuation({
        client: {} as ConatClient,
        job: { ...queued, started_at: Date.now() },
        recoveryCode: "acp_harness_killed",
      }),
    ).toBeUndefined();
  });

  it("never creates a Codex recovery continuation for a generic harness", async () => {
    const queued = enqueueAcpJob({
      ...makeRequest(),
      runtime: { version: 1, kind: "acp", profile: {} },
    } as any);
    const resumed = await acpTestInternals.enqueueFailureRecoveryContinuation({
      client: {} as ConatClient,
      job: { ...queued, started_at: Date.now() },
      recoveryCode: "codex_model_capacity",
    });
    expect(resumed).toBeUndefined();
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: queued.op_id }),
    ).toHaveLength(0);
  });

  it("terminalizes an orphaned harness rather than replaying ambiguous delivery", async () => {
    const queued = enqueueAcpJob({
      ...makeRequest(),
      runtime: { version: 1, kind: "acp", profile: {} },
    } as any);
    claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
      worker_id: "gone",
      worker_bundle_version: "old",
    });
    getAcpDatabase()
      .prepare(
        "UPDATE acp_jobs SET started_at = ?, updated_at = ? WHERE op_id = ?",
      )
      .run(Date.now() - 60_000, Date.now() - 60_000, queued.op_id);
    await recoverOrphanedRunningAcpJobsWithoutLease({ graceMs: 0 });
    const after = getAcpJob({
      project_id: queued.project_id,
      path: queued.path,
      user_message_id: queued.user_message_id,
    });
    expect(after?.state).toBe("error");
    expect(after?.error).toContain("completion is unknown");
  });

  it("schedules a same-process wakeup for a delayed continuation", () => {
    const previous = process.env.COCALC_LITE_ACP_DETACHED_WORKER;
    process.env.COCALC_LITE_ACP_DETACHED_WORKER = "0";
    try {
      const availableAt = Date.now() + 60_000;
      enqueueAcpJob(
        {
          ...makeRequest(),
          recovery_parent_op_id: "wake-parent",
          recovery_reason: "model capacity",
          recovery_count: 1,
        } as any,
        { available_at: availableAt },
      );

      acpTestInternals.scheduleNextDelayedAcpQueueWake();

      expect(acpTestInternals.delayedAcpQueueWakeAt()).toBe(availableAt);
    } finally {
      acpTestInternals.cancelDelayedAcpQueueWake();
      if (previous == null) {
        delete process.env.COCALC_LITE_ACP_DETACHED_WORKER;
      } else {
        process.env.COCALC_LITE_ACP_DETACHED_WORKER = previous;
      }
    }
  });

  it("never resumes a delivery report's turn (a report starts one turn)", async () => {
    const request = makeRequest();
    (request.chat as any).agent_rpc_report = { attempt_id: "attempt" };
    const queued = enqueueAcpJob(request as any);
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(
      makeSyncdb([
        {
          event: "chat",
          date: request.chat.message_date,
          sender_id: request.chat.sender_id,
          message_id: request.chat.message_id,
          thread_id: request.chat.thread_id,
          generating: false,
          history: [],
        },
      ]),
    );
    await expect(
      acpTestInternals.enqueueFailureRecoveryContinuation({
        client: {} as ConatClient,
        job: { ...queued, started_at: Date.now() },
        recoveryCode: "codex_model_capacity",
      }),
    ).resolves.toBeUndefined();
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: queued.op_id }),
    ).toHaveLength(0);
  });

  it("persists a bounded 15-minute model-capacity continuation", async () => {
    const request = makeRequest();
    const queued = enqueueAcpJob(request as any);
    const rows: any[] = [
      {
        event: "chat",
        date: request.chat.message_date,
        sender_id: request.chat.sender_id,
        message_id: request.chat.message_id,
        thread_id: request.chat.thread_id,
        generating: false,
        history: [],
      },
    ];
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(makeSyncdb(rows));
    const before = Date.now();

    const resumed = await acpTestInternals.enqueueFailureRecoveryContinuation({
      client: {} as ConatClient,
      job: { ...queued, started_at: Date.now() },
      recoveryCode: "codex_model_capacity",
    });

    expect(resumed?.recovery_count).toBe(1);
    expect(resumed?.available_at).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(resumed?.available_at).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    const recoveryRequest = decodeAcpJobRequest(resumed!);
    expect(recoveryRequest.prompt).toContain("selected model was at capacity");
    const recoveryRow = rows.find(
      (row) => row.message_id === recoveryRequest.chat?.parent_message_id,
    );
    expect(recoveryRow?.history?.[0]?.content).toContain("in about 15m");
    expect(recoveryRow?.history?.[0]?.content).toContain(
      "unless you send another turn first",
    );

    await expect(
      acpTestInternals.enqueueFailureRecoveryContinuation({
        client: {} as ConatClient,
        job: queued,
        recoveryCode: "codex_model_capacity",
      }),
    ).resolves.toBeUndefined();
    expect(
      listAcpJobsByRecoveryParent({
        recovery_parent_op_id: queued.op_id,
      }),
    ).toHaveLength(1);
  });

  it("resumes another agent's message as that message, not a user request", async () => {
    const request = makeRequest();
    request.prompt =
      "Message from @builder (agent a in project p).\nAgent Network: Review.\n\nPlease review.\n\nAttached file snapshots in this project (temporary; copy into the project home to retain across restart):\n{}";
    (request.chat as any).agent_message = true;
    const queued = enqueueAcpJob(request as any);
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(
      makeSyncdb([
        {
          event: "chat",
          date: request.chat.message_date,
          sender_id: request.chat.sender_id,
          message_id: request.chat.message_id,
          thread_id: request.chat.thread_id,
          generating: false,
          history: [],
        },
      ]),
    );
    const resumed = await acpTestInternals.enqueueFailureRecoveryContinuation({
      client: {} as ConatClient,
      job: { ...queued, started_at: Date.now() },
      recoveryCode: "codex_model_capacity",
    });
    const { prompt, chat } = decodeAcpJobRequest(resumed!);
    expect(prompt).toContain(
      `Original message (delivered by CoCalc; its header says who it is from):\n${request.prompt}`,
    );
    expect(prompt).not.toContain("Original user request");
    expect(prompt).toContain("check that each listed path still exists");
    expect(chat?.agent_message).toBe(true);
  });

  it("schedules delayed recovery before fallible chat projection", async () => {
    const previous = process.env.COCALC_LITE_ACP_DETACHED_WORKER;
    process.env.COCALC_LITE_ACP_DETACHED_WORKER = "0";
    try {
      const request = makeRequest();
      const queued = enqueueAcpJob(request as any);
      const rows: any[] = [
        {
          event: "chat",
          date: request.chat.message_date,
          sender_id: request.chat.sender_id,
          message_id: request.chat.message_id,
          thread_id: request.chat.thread_id,
          generating: false,
          history: [],
        },
      ];
      const syncdb = makeSyncdb(rows);
      (chatServer.acquireChatSyncDB as any)
        .mockResolvedValueOnce(syncdb)
        .mockRejectedValueOnce(new Error("projection write failed"));

      await expect(
        acpTestInternals.enqueueFailureRecoveryContinuation({
          client: {} as ConatClient,
          job: { ...queued, started_at: Date.now() },
          recoveryCode: "codex_model_capacity",
        }),
      ).rejects.toThrow("projection write failed");

      const [recovery] = listAcpJobsByRecoveryParent({
        recovery_parent_op_id: queued.op_id,
      });
      expect(recovery?.available_at).toEqual(expect.any(Number));
      expect(acpTestInternals.delayedAcpQueueWakeAt()).toBe(
        recovery.available_at,
      );
    } finally {
      if (previous == null) {
        delete process.env.COCALC_LITE_ACP_DETACHED_WORKER;
      } else {
        process.env.COCALC_LITE_ACP_DETACHED_WORKER = previous;
      }
    }
  });

  it("collapses concurrent recovery replay into one continuation", async () => {
    const request = makeRequest();
    const queued = enqueueAcpJob(request as any);
    setAcpJobState({
      op_id: queued.op_id,
      state: "error",
      error: "Codex app-server exited",
    });
    const failed = getAcpJob({
      project_id: queued.project_id,
      path: queued.path,
      user_message_id: queued.user_message_id,
    })!;
    const rows: any[] = [];
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(makeSyncdb(rows));

    await Promise.all([
      acpTestInternals.enqueueFailureRecoveryContinuation({
        client: {} as ConatClient,
        job: { ...failed, started_at: Date.now() },
        recoveryCode: "codex_app_server_exited",
      }),
      acpTestInternals.enqueueFailureRecoveryContinuation({
        client: {} as ConatClient,
        job: { ...failed, started_at: Date.now() },
        recoveryCode: "codex_app_server_exited",
      }),
    ]);

    const recoveries = listAcpJobsByRecoveryParent({
      recovery_parent_op_id: queued.op_id,
    });
    expect(recoveries).toHaveLength(1);
    expect(
      rows.filter((row) => row.message_id === recoveries[0].user_message_id),
    ).toHaveLength(1);
  });

  it("stops failure recovery after two continuation attempts", async () => {
    const request = {
      ...makeRequest(),
      recovery_parent_op_id: "recovery-parent",
      recovery_reason: "model capacity",
      recovery_count: 2,
    };
    const queued = enqueueAcpJob(request as any);
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(makeSyncdb([]));

    await expect(
      acpTestInternals.enqueueFailureRecoveryContinuation({
        client: {} as ConatClient,
        job: queued,
        recoveryCode: "codex_model_capacity",
      }),
    ).resolves.toBeUndefined();
    expect(
      listAcpJobsByRecoveryParent({
        recovery_parent_op_id: queued.op_id,
      }),
    ).toHaveLength(0);
  });

  it("resumes a blocked command once with explicit safer-command guidance", async () => {
    const request = makeRequest();
    const queued = enqueueAcpJob(request as any);
    const rows: any[] = [];
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(makeSyncdb(rows));
    const denial =
      "Codex blocked a command: rm -f style commands are not permitted. Use a safer approach";

    const resumed = await acpTestInternals.enqueueFailureRecoveryContinuation({
      client: {} as ConatClient,
      job: { ...queued, started_at: Date.now() },
      recoveryCode: "codex_command_blocked",
      recoveryDetail: denial,
    });

    expect(resumed?.recovery_count).toBe(1);
    expect(resumed?.available_at).toBeNull();
    const recoveryRequest = decodeAcpJobRequest(resumed!);
    expect(recoveryRequest.prompt).toContain(denial);
    expect(recoveryRequest.prompt).toContain(
      "Do not repeat the rejected command or an equivalent destructive shell form",
    );
    const recoveryRow = rows.find(
      (row) => row.message_id === recoveryRequest.chat?.parent_message_id,
    );
    expect(recoveryRow?.history?.[0]?.content).toContain("attempt 1/1");

    const secondRequest = {
      ...request,
      chat: {
        ...request.chat,
        message_id: "00000000-0000-4000-8000-000000000099",
        parent_message_id: "00000000-0000-4000-8000-000000000098",
      },
      recovery_parent_op_id: queued.op_id,
      recovery_reason: "Codex command blocked by CoCalc safety policy",
      recovery_count: 1,
    };
    const second = enqueueAcpJob(secondRequest as any);
    await expect(
      acpTestInternals.enqueueFailureRecoveryContinuation({
        client: {} as ConatClient,
        job: { ...second, started_at: Date.now() },
        recoveryCode: "codex_command_blocked",
        recoveryDetail: denial,
      }),
    ).resolves.toBeUndefined();
  });

  it("delays resource-killed recovery and preserves memory guidance", async () => {
    const request = makeRequest();
    const queued = enqueueAcpJob(request as any);
    const rows: any[] = [];
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(makeSyncdb(rows));
    const detail =
      "Codex was killed by SIGKILL (exit code 137). This is usually caused by the project running out of RAM.";
    const before = Date.now();

    const resumed = await acpTestInternals.enqueueFailureRecoveryContinuation({
      client: {} as ConatClient,
      job: { ...queued, started_at: Date.now() },
      recoveryCode: "codex_resource_killed",
      recoveryDetail: detail,
    });

    expect(resumed?.available_at).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(resumed?.available_at).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    const recoveryRequest = decodeAcpJobRequest(resumed!);
    expect(recoveryRequest.prompt).toContain(detail);
    expect(recoveryRequest.prompt).toContain(
      "inspect current workspace and memory state",
    );
    const recoveryRow = rows.find(
      (row) => row.message_id === recoveryRequest.chat?.parent_message_id,
    );
    expect(recoveryRow?.history?.[0]?.content).toContain("in about 5m");
    expect(recoveryRow?.history?.[0]?.content).toContain("attempt 1/2");
  });
});

describe("recoverDetachedWorkerStartupState", () => {
  it("replays a durable terminal recovery intent after worker restart", async () => {
    const request = makeRequest();
    const queued = enqueueAcpJob(request as any);
    const running = claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
      worker_id: "worker-before-crash",
      worker_bundle_version: "bundle-before-crash",
    });
    expect(running?.state).toBe("running");
    setAcpJobState({
      op_id: queued.op_id,
      state: "error",
      worker_id: "worker-before-crash",
      error: "Codex app-server exited",
      recovery_code: "codex_app_server_exited",
      recovery_detail: "exit code 1",
    });
    expect(listAcpJobsWithRecoveryIntent()).toHaveLength(1);
    const rows: any[] = [];
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(makeSyncdb(rows));

    await recoverDetachedWorkerStartupState({} as ConatClient, {
      restartReason: "worker restart",
    });

    expect(listAcpJobsWithRecoveryIntent()).toHaveLength(0);
    const recoveries = listAcpJobsByRecoveryParent({
      recovery_parent_op_id: queued.op_id,
    });
    expect(recoveries).toHaveLength(1);
    const recoveryRequest = decodeAcpJobRequest(recoveries[0]);
    expect(recoveryRequest.prompt).toContain(
      "Codex app-server exited unexpectedly",
    );
    expect(recoveryRequest.chat?.user_message_content).toContain(
      "System recovery",
    );
  });

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

    getAcpDatabase()
      .prepare(
        "UPDATE acp_jobs SET started_at = ?, updated_at = ? WHERE op_id = ?",
      )
      .run(Date.now() - 60_000, Date.now() - 60_000, queued.op_id);

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
            content: ":robot: Thinking...",
            date: request.chat.message_date,
          },
        ],
      },
      {
        event: "chat",
        date: "2026-03-16T00:00:00.000Z",
        sender_id: "user",
        message_id: request.chat.parent_message_id,
        thread_id: request.chat.thread_id,
        history: [{ author_id: "user", content: "test", date: "now" }],
      },
      {
        event: "chat-thread-state",
        sender_id: "__thread_state__",
        date: "1970-01-01T00:00:00.000Z",
        thread_id: request.chat.thread_id,
        active_message_id: request.chat.message_id,
        state: "running",
      },
    ];
    const syncdb: any = {
      isReady: () => true,
      get: (where?: any) =>
        where == null
          ? rows
          : rows.filter((row) =>
              Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
            ),
      get_one: (where: any) =>
        rows.find((row) =>
          Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
        ),
      delete: (where: any) => {
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (Object.entries(where ?? {}).every(([k, v]) => rows[i][k] === v)) {
            rows.splice(i, 1);
          }
        }
      },
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
    const durableThreadState = syncdb.get_one({
      event: "chat-thread-state",
      thread_id: request.chat.thread_id,
    });
    expect(durableThreadState?.state).toBe("queued");
    expect(durableThreadState?.active_message_id).toBe(
      request.chat.parent_message_id,
    );
    expect(
      syncdb.get_one({
        event: "chat",
        message_id: request.chat.parent_message_id,
      })?.acp_state,
    ).toBe("queued");
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

    getAcpDatabase()
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

  it("repairs stale generating chat rows for terminal turns on startup", async () => {
    const rows: any[] = [
      {
        event: "chat",
        date: "2026-04-03T14:00:00.000Z",
        sender_id: "openai-codex-agent",
        message_id: "assistant-terminal",
        thread_id: "thread-terminal",
        generating: true,
        history: [
          {
            author_id: "openai-codex-agent",
            content: "partial answer",
            date: "2026-04-03T14:00:00.000Z",
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
    (turns.listRecentTerminalAcpTurnLeases as any).mockReturnValue([
      {
        project_id: "00000000-1000-4000-8000-000000000000",
        path: "/tmp/detached-worker.chat",
        message_date: "2026-04-03T14:00:00.000Z",
        sender_id: "openai-codex-agent",
        message_id: "assistant-terminal",
        thread_id: "thread-terminal",
        state: "error",
        owner_instance_id: "worker-old",
        started_at: Date.now() - 65_000,
        heartbeat_at: Date.now() - 61_000,
        ended_at: Date.now() - 1_000,
        reason: "codex exited",
      },
    ]);

    await recoverDetachedWorkerStartupState({} as ConatClient, {
      restartReason: "worker restart",
    });

    const repaired = sets.find(
      (row: any) => row.event === "chat" && row.generating === false,
    );
    expect(repaired?.message_id).toBe("assistant-terminal");
    expect(repaired?.acp_interrupted_text).toContain(
      "could not confirm that this turn finished saving",
    );
    expect(repaired?.acp_interrupted_reason).toBe("backend_error");
  });

  it("explains a terminal storage failure with the reason recorded for the turn", async () => {
    const rows: any[] = [
      {
        event: "chat",
        date: "2026-04-03T14:00:00.000Z",
        sender_id: "openai-codex-agent",
        message_id: "assistant-terminal",
        thread_id: "thread-terminal",
        generating: true,
        history: [
          {
            author_id: "openai-codex-agent",
            content: "partial answer",
            date: "2026-04-03T14:00:00.000Z",
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
    (turns.listRecentTerminalAcpTurnLeases as any).mockReturnValue([
      {
        project_id: "00000000-1000-4000-8000-000000000000",
        path: "/tmp/detached-worker.chat",
        message_date: "2026-04-03T14:00:00.000Z",
        sender_id: "openai-codex-agent",
        message_id: "assistant-terminal",
        thread_id: "thread-terminal",
        state: "error",
        owner_instance_id: "worker-old",
        started_at: Date.now() - 65_000,
        heartbeat_at: Date.now() - 61_000,
        ended_at: Date.now() - 1_000,
        reason:
          "Project storage was temporarily unavailable while saving this Codex turn. CoCalc retained local recovery data and will retry automatically.",
      },
    ]);

    await recoverDetachedWorkerStartupState({} as ConatClient, {
      restartReason: "worker restart",
    });

    const repaired = sets.find(
      (row: any) => row.event === "chat" && row.generating === false,
    );
    expect(repaired?.message_id).toBe("assistant-terminal");
    expect(repaired?.acp_interrupted_text).toContain(
      "Project storage was temporarily unavailable while saving this Codex turn",
    );
    expect(repaired?.acp_interrupted_text).not.toContain(
      "could not confirm that this turn finished saving",
    );
    expect(repaired?.acp_interrupted_reason).toBe("backend_error");
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
      "recover the live agent turn",
    );
  });

  it("does not recover a host-managed turn when the owner pid is still alive", async () => {
    (turns.listRunningAcpTurnLeases as any).mockReturnValue([
      {
        project_id: "00000000-1000-4000-8000-000000000000",
        path: "/tmp/detached-worker.chat",
        message_date: "2026-04-02T14:00:00.000Z",
        sender_id: "openai-codex-agent",
        message_id: "assistant-1",
        thread_id: "thread-1",
        owner_instance_id: "worker-live",
        pid: process.pid,
        started_at: Date.now() - 70_000,
        heartbeat_at: Date.now() - 70_000,
      },
    ]);
    (workers.getAcpWorker as any).mockReturnValue({
      worker_id: "worker-live",
      host_id: "host-1",
      bundle_version: "bundle-1",
      bundle_path: "/bundle",
      pid: process.pid,
      state: "active",
      started_at: Date.now() - 70_000,
      last_heartbeat_at: Date.now() - 70_000,
      last_seen_running_jobs: 1,
      exit_requested_at: null,
      stopped_at: null,
      stop_reason: null,
    });

    await recoverDetachedWorkerStartupState({} as ConatClient, {
      workerContext: {
        worker_id: "worker-new",
        host_id: "host-1",
        bundle_version: "bundle-1",
        bundle_path: "/bundle",
        state: "active",
      },
      restartReason: "ACP worker stopped unexpectedly",
    });

    expect(chatServer.acquireChatSyncDB).not.toHaveBeenCalled();
    expect(turns.finalizeAcpTurnLease).not.toHaveBeenCalled();
  });

  it("does not requeue a running job without a lease while the worker pid is still alive", async () => {
    const request = makeRequest();
    const queued = enqueueAcpJob(request as any);
    const running = claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
      worker_id: "worker-live",
      worker_bundle_version: "bundle-a",
    });
    expect(running?.state).toBe("running");

    getAcpDatabase()
      .prepare(
        "UPDATE acp_jobs SET started_at = ?, updated_at = ? WHERE op_id = ?",
      )
      .run(Date.now() - 60_000, Date.now() - 60_000, queued.op_id);
    (workers.getAcpWorker as any).mockImplementation((workerId: string) =>
      workerId === "worker-live"
        ? {
            worker_id: "worker-live",
            host_id: "host-1",
            bundle_version: "bundle-1",
            bundle_path: "/bundle",
            pid: process.pid,
            state: "active",
            started_at: Date.now() - 60_000,
            last_heartbeat_at: Date.now() - 60_000,
            last_seen_running_jobs: 1,
            exit_requested_at: null,
            stopped_at: null,
            stop_reason: null,
          }
        : undefined,
    );

    await recoverDetachedWorkerStartupState({} as ConatClient, {
      restartReason: "worker restart",
    });

    const after = getAcpJob({
      project_id: queued.project_id,
      path: queued.path,
      user_message_id: queued.user_message_id,
    });
    expect(after?.state).toBe("running");
    expect(after?.worker_id).toBe("worker-live");
    expect(after?.error ?? null).toBeNull();
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

  it.each(["partial", "empty", "unavailable"])(
    "preserves unknown harness outcome when not resumed (%s chat)",
    async (chatState) => {
      const request = {
        ...makeRequest(),
        runtime: { version: 1, kind: "acp", profile: {} },
      };
      const job = enqueueAcpJob(request as any);
      claimNextQueuedAcpJobForThread({
        project_id: job.project_id,
        path: job.path,
        thread_id: job.thread_id,
        worker_id: "worker-old",
        worker_bundle_version: "bundle-old",
      });
      const rows: any[] = [
        {
          event: "chat",
          date: request.chat.message_date,
          sender_id: request.chat.sender_id,
          message_id: request.chat.message_id,
          thread_id: request.chat.thread_id,
          generating: true,
          history:
            chatState === "partial"
              ? [{ content: "partial harness output" }]
              : [],
        },
      ];
      (chatServer.acquireChatSyncDB as jest.Mock).mockImplementation(
        async () => {
          if (chatState === "unavailable") throw new Error("chat unavailable");
          return makeSyncdb(rows);
        },
      );
      (turns.listRunningAcpTurnLeases as jest.Mock).mockReturnValue([
        {
          project_id: request.project_id,
          path: request.chat.path,
          message_date: request.chat.message_date,
          sender_id: request.chat.sender_id,
          message_id: request.chat.message_id,
          thread_id: request.chat.thread_id,
          owner_instance_id: "worker-old",
          started_at: Date.now() - 60000,
          heartbeat_at: Date.now() - 30000,
        },
      ]);
      // Without automatic resumption (as when retries are exhausted).
      expect(
        await recoverOrphanedAcpTurns({} as ConatClient, { autoResume: false }),
      ).toBe(1);
      expect(
        getAcpJob({
          project_id: job.project_id,
          path: job.path,
          user_message_id: job.user_message_id,
        }),
      ).toMatchObject({
        state: "error",
        error: expect.stringContaining("completion is unknown"),
      });
      expect(turns.finalizeAcpTurnLease).toHaveBeenCalledWith(
        expect.objectContaining({ state: "error" }),
      );
      expect(
        listAcpJobsByRecoveryParent({ recovery_parent_op_id: job.op_id }),
      ).toHaveLength(0);
      if (chatState !== "unavailable") {
        const row = rows.find((x) => x.event === "chat");
        expect(row).toMatchObject({
          generating: false,
          acp_interrupted: false,
        });
        expect(row.history[0].content).toContain("completion is unknown");
        if (chatState === "partial")
          expect(row.history[0].content).toContain("partial harness output");
        expect(rows.find((x) => x.event === "chat-thread-state")?.state).toBe(
          "error",
        );
      }
    },
  );

  it("resumes a harness turn in its session after worker loss", async () => {
    const request = {
      ...makeRequest(),
      runtime: { version: 1, kind: "acp", profile: { id: "claude-code" } },
    };
    const job = enqueueAcpJob(request as any);
    claimNextQueuedAcpJobForThread({
      project_id: job.project_id,
      path: job.path,
      thread_id: job.thread_id,
      worker_id: "worker-old",
      worker_bundle_version: "bundle-old",
    });
    const rows: any[] = [
      {
        event: "chat",
        date: request.chat.message_date,
        sender_id: request.chat.sender_id,
        message_id: request.chat.message_id,
        thread_id: request.chat.thread_id,
        generating: true,
        history: [{ content: "partial harness output" }],
      },
    ];
    (chatServer.acquireChatSyncDB as jest.Mock).mockImplementation(async () =>
      makeSyncdb(rows),
    );
    (turns.listRunningAcpTurnLeases as jest.Mock).mockReturnValue([
      {
        project_id: request.project_id,
        path: request.chat.path,
        message_date: request.chat.message_date,
        sender_id: request.chat.sender_id,
        message_id: request.chat.message_id,
        thread_id: request.chat.thread_id,
        owner_instance_id: "worker-old",
        started_at: Date.now() - 60000,
        heartbeat_at: Date.now() - 30000,
      },
    ]);
    expect(
      await recoverOrphanedAcpTurns({} as ConatClient, { autoResume: true }),
    ).toBe(1);
    expect(
      getAcpJob({
        project_id: job.project_id,
        path: job.path,
        user_message_id: job.user_message_id,
      })?.state,
    ).toBe("interrupted");
    const children = listAcpJobsByRecoveryParent({
      recovery_parent_op_id: job.op_id,
    });
    expect(children).toHaveLength(1);
    expect(children[0].state).toBe("queued");
    const resumed = decodeAcpJobRequest(children[0] as any);
    expect(resumed.runtime).toEqual(request.runtime);
    expect(resumed.session_id).toBe("session-1");
    expect(resumed.prompt).toContain(
      "inspect what already completed and avoid duplicating side effects",
    );
    const notice = rows.find(
      (row) => row.message_id === resumed.chat?.parent_message_id,
    );
    expect(JSON.stringify(notice)).toContain(
      "CoCalc is automatically resuming this Claude session",
    );
  });

  it("does not let an unavailable chat block later orphan recovery", async () => {
    const badRequest = {
      ...makeRequest(),
      project_id: "00000000-1000-4000-8000-000000000010",
      session_id: "session-bad",
      chat: {
        ...makeRequest().chat,
        project_id: "00000000-1000-4000-8000-000000000010",
        path: "/tmp/unavailable.chat",
        thread_id: "thread-bad",
        parent_message_id: "user-bad",
        message_id: "assistant-bad",
      },
    };
    const goodRequest = {
      ...makeRequest(),
      project_id: "00000000-1000-4000-8000-000000000020",
      session_id: "session-good",
      chat: {
        ...makeRequest().chat,
        project_id: "00000000-1000-4000-8000-000000000020",
        path: "/tmp/healthy.chat",
        thread_id: "thread-good",
        parent_message_id: "user-good",
        message_id: "assistant-good",
      },
    };
    const badJob = enqueueAcpJob(badRequest as any);
    const goodJob = enqueueAcpJob(goodRequest as any);
    for (const job of [badJob, goodJob]) {
      claimNextQueuedAcpJobForThread({
        project_id: job.project_id,
        path: job.path,
        thread_id: job.thread_id,
        worker_id: "worker-old",
        worker_bundle_version: "bundle-old",
      });
    }
    const goodRows: any[] = [
      {
        event: "chat",
        date: goodRequest.chat.message_date,
        sender_id: goodRequest.chat.sender_id,
        message_id: goodRequest.chat.message_id,
        thread_id: goodRequest.chat.thread_id,
        generating: true,
        history: [],
      },
    ];
    (chatServer.acquireChatSyncDB as jest.Mock).mockImplementation(
      async (opts: any) => {
        expect(opts.readyTimeoutMs).toEqual(expect.any(Number));
        expect(opts.readyTimeoutMs).toBeGreaterThan(0);
        if (opts.project_id === badRequest.project_id) {
          throw new Error("timed out waiting for unavailable chat SyncDB");
        }
        return makeSyncdb(goodRows);
      },
    );
    (turns.listRunningAcpTurnLeases as jest.Mock).mockReturnValue(
      [badRequest, goodRequest].map((request) => ({
        project_id: request.project_id,
        path: request.chat.path,
        message_date: request.chat.message_date,
        sender_id: request.chat.sender_id,
        message_id: request.chat.message_id,
        thread_id: request.chat.thread_id,
        session_id: request.session_id,
        owner_instance_id: "worker-old",
        started_at: Date.now() - 60_000,
        heartbeat_at: Date.now() - 30_000,
      })),
    );

    const recovered = await recoverOrphanedAcpTurns({} as ConatClient, {
      recoveryReason: "worker stopped",
      autoResume: true,
    });

    expect(recovered).toBe(2);
    expect(
      (chatServer.acquireChatSyncDB as jest.Mock).mock.calls.some(
        ([opts]) => opts.project_id === goodRequest.project_id,
      ),
    ).toBe(true);
    expect(
      getAcpJob({
        project_id: goodJob.project_id,
        path: goodJob.path,
        user_message_id: goodJob.user_message_id,
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

describe("recoverCurrentWorkerStuckAcpTurns", () => {
  function makeRows(request = makeRequest()) {
    return [
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
    ];
  }

  async function startWriterForRequest(request = makeRequest()) {
    const rows = makeRows(request);
    const syncdb = makeSyncdb(rows);
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);
    const writer = new ChatStreamWriter({
      metadata: request.chat as any,
      client: {} as ConatClient,
      approverAccountId: request.account_id,
      sessionKey: request.session_id,
      syncdbOverride: syncdb,
    });
    await writer.waitUntilReady();
    const leaseCall = (turns.startAcpTurnLease as jest.Mock).mock.calls.at(-1);
    const owner_instance_id = leaseCall?.[0]?.owner_instance_id;
    expect(owner_instance_id).toBeTruthy();
    return { rows, syncdb, writer, owner_instance_id };
  }

  it("records queue progress before releasing a completed turn lease", async () => {
    acpTestInternals.setDetachedWorkerContextForTests({
      worker_id: "worker-current",
      host_id: "host-1",
      bundle_version: "bundle-a",
      bundle_path: "/bundle-a",
      state: "active",
      started_at: Date.now() - 60_000,
      last_heartbeat_at: Date.now(),
      last_queue_progress_at: Date.now() - 60_000,
    });
    const { writer } = await startWriterForRequest();

    (writer as any).finalizeLease("completed");

    const progressCall = (workers.heartbeatAcpWorker as jest.Mock).mock.calls
      .map((args, index) => ({ args, index }))
      .find(({ args }) => Number(args[0]?.last_queue_progress_at) > 0);
    expect(progressCall).toBeDefined();
    const progressOrder = (workers.heartbeatAcpWorker as jest.Mock).mock
      .invocationCallOrder[progressCall!.index];
    const finalizeOrder = (turns.finalizeAcpTurnLease as jest.Mock).mock
      .invocationCallOrder[0];
    expect(progressOrder).toBeLessThan(finalizeOrder);
  });

  it("does not recover a current-worker turn while its writer is recently active", async () => {
    const request = makeRequest();
    const queued = enqueueAcpJob(request as any);
    claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
      worker_id: "worker-current",
      worker_bundle_version: "bundle-a",
    });
    const { owner_instance_id } = await startWriterForRequest(request);
    (turns.listRunningAcpTurnLeases as any).mockReturnValue([
      {
        project_id: request.project_id,
        path: request.chat.path,
        message_date: request.chat.message_date,
        sender_id: request.chat.sender_id,
        message_id: request.chat.message_id,
        thread_id: request.chat.thread_id,
        session_id: request.session_id,
        owner_instance_id,
        started_at: Date.now() - 60_000,
        heartbeat_at: Date.now() - 60_000,
      },
    ]);

    const recovered = await recoverCurrentWorkerStuckAcpTurns(
      {} as ConatClient,
      {
        graceMs: 0,
        writerStaleMs: 60_000,
      },
    );

    expect(recovered).toBe(0);
    expect(turns.finalizeAcpTurnLease).not.toHaveBeenCalled();
    expect(
      getAcpJob({
        project_id: queued.project_id,
        path: queued.path,
        user_message_id: queued.user_message_id,
      })?.state,
    ).toBe("running");
  });

  it("recovers a current-worker turn after its writer goes stale", async () => {
    const request = makeRequest();
    const queued = enqueueAcpJob(request as any);
    claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
      worker_id: "worker-current",
      worker_bundle_version: "bundle-a",
    });
    const { owner_instance_id } = await startWriterForRequest(request);
    const startedAt = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(startedAt + 120_000);
    (turns.listRunningAcpTurnLeases as any).mockReturnValue([
      {
        project_id: request.project_id,
        path: request.chat.path,
        message_date: request.chat.message_date,
        sender_id: request.chat.sender_id,
        message_id: request.chat.message_id,
        thread_id: request.chat.thread_id,
        session_id: request.session_id,
        owner_instance_id,
        started_at: startedAt - 120_000,
        heartbeat_at: startedAt - 120_000,
      },
    ]);

    const recovered = await recoverCurrentWorkerStuckAcpTurns(
      {} as ConatClient,
      {
        recoveryReason: "backend lost live Codex turn",
        graceMs: 0,
        writerStaleMs: 60_000,
      },
    );

    expect(recovered).toBe(1);
    expect(
      getAcpJob({
        project_id: queued.project_id,
        path: queued.path,
        user_message_id: queued.user_message_id,
      })?.state,
    ).toBe("interrupted");
    expect(turns.finalizeAcpTurnLease).toHaveBeenCalled();
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

describe("shouldStopDetachedWorkerForDrain", () => {
  it("does not drain-stop while an in-memory Codex turn is active", () => {
    expect(
      shouldStopDetachedWorkerForDrain({
        isDraining: true,
        runningJobs: 0,
        runningTurnLeases: 0,
        activeTurns: 1,
        exitRequestedAt: 1_000,
        quiesceMs: 30_000,
        now: 60_000,
      }),
    ).toBe(false);
  });

  it("does not drain-stop while Codex owns a background terminal", () => {
    expect(
      shouldStopDetachedWorkerForDrain({
        isDraining: true,
        runningJobs: 0,
        runningTurnLeases: 0,
        backgroundTerminalProcesses: 1,
        exitRequestedAt: 1_000,
        quiesceMs: 30_000,
        now: 60_000,
      }),
    ).toBe(false);
  });

  it("does not drain-stop while the worker still owns a running turn lease", () => {
    expect(
      shouldStopDetachedWorkerForDrain({
        isDraining: true,
        runningJobs: 0,
        runningTurnLeases: 1,
        exitRequestedAt: 1_000,
        quiesceMs: 30_000,
        now: 60_000,
      }),
    ).toBe(false);
  });

  it("does not drain-stop before the quiescence window elapses", () => {
    expect(
      shouldStopDetachedWorkerForDrain({
        isDraining: true,
        runningJobs: 0,
        runningTurnLeases: 0,
        exitRequestedAt: 10_000,
        quiesceMs: 30_000,
        now: 39_999,
      }),
    ).toBe(false);
    expect(
      shouldStopDetachedWorkerForDrain({
        isDraining: true,
        runningJobs: 0,
        runningTurnLeases: 0,
        exitRequestedAt: 10_000,
        quiesceMs: 30_000,
        now: 40_000,
      }),
    ).toBe(true);
  });
});

describe("isFatalAcpWorkerStorageError", () => {
  it("treats disk-full and SQLite I/O failures as worker-fatal", () => {
    expect(
      isFatalAcpWorkerStorageError(
        Object.assign(new Error("ENOSPC: no space left on device, write"), {
          code: "ENOSPC",
        }),
      ),
    ).toBe(true);
    expect(isFatalAcpWorkerStorageError(new Error("disk I/O error"))).toBe(
      true,
    );
    expect(
      isFatalAcpWorkerStorageError(
        Object.assign(new Error("database or disk is full"), {
          code: "SQLITE_FULL",
        }),
      ),
    ).toBe(true);
    expect(
      isProjectAcpStorageError(
        Object.assign(new Error("terminal storage timed out"), {
          code: "ACP_TERMINAL_STORAGE_TIMEOUT",
        }),
      ),
    ).toBe(true);
  });

  it("does not treat ordinary transient lock errors as worker-fatal", () => {
    expect(isFatalAcpWorkerStorageError(new Error("database is locked"))).toBe(
      false,
    );
    expect(isFatalAcpWorkerStorageError(new Error("network timeout"))).toBe(
      false,
    );
  });
});

describe("shouldCompleteAcpTurnAfterTerminalStorageFailure", () => {
  it("completes verified summary turns after terminal storage timeouts", () => {
    expect(
      shouldCompleteAcpTurnAfterTerminalStorageFailure({
        err: Object.assign(new Error("terminal storage timed out"), {
          code: "ACP_TERMINAL_STORAGE_TIMEOUT",
        }),
        phase: "terminal-summary",
        finishedBy: "summary",
        terminalRowAlreadyPersisted: true,
      }),
    ).toBe(true);
  });

  it("completes summary turns retained in the durable payload queue", () => {
    expect(
      shouldCompleteAcpTurnAfterTerminalStorageFailure({
        err: Object.assign(new Error("terminal storage timed out"), {
          code: "ACP_TERMINAL_STORAGE_TIMEOUT",
        }),
        phase: "terminal-summary",
        finishedBy: "summary",
        terminalRowAlreadyPersisted: false,
        recoverableSummaryQueued: true,
      }),
    ).toBe(true);
  });

  it("does not hide real storage failures or unverified terminal rows", () => {
    expect(
      shouldCompleteAcpTurnAfterTerminalStorageFailure({
        err: Object.assign(new Error("database or disk is full"), {
          code: "SQLITE_FULL",
        }),
        phase: "terminal-summary",
        finishedBy: "summary",
        terminalRowAlreadyPersisted: true,
      }),
    ).toBe(false);
    expect(
      shouldCompleteAcpTurnAfterTerminalStorageFailure({
        err: Object.assign(new Error("terminal storage timed out"), {
          code: "ACP_TERMINAL_STORAGE_TIMEOUT",
        }),
        phase: "terminal-summary",
        finishedBy: "summary",
        terminalRowAlreadyPersisted: false,
      }),
    ).toBe(false);
    expect(
      shouldCompleteAcpTurnAfterTerminalStorageFailure({
        err: Object.assign(new Error("terminal storage timed out"), {
          code: "ACP_TERMINAL_STORAGE_TIMEOUT",
        }),
        phase: "terminal-error",
        finishedBy: "error",
        terminalRowAlreadyPersisted: true,
      }),
    ).toBe(false);
  });
});

describe("shouldExitAcpWorkerAfterHeartbeatFailure", () => {
  it("always exits on fatal worker storage errors", () => {
    expect(
      shouldExitAcpWorkerAfterHeartbeatFailure({
        consecutiveFailures: 1,
        failureExitThreshold: 0,
        fatalStorageError: true,
      }),
    ).toBe(true);
  });

  it("does not exit on repeated nonfatal heartbeat failures by default", () => {
    expect(
      shouldExitAcpWorkerAfterHeartbeatFailure({
        consecutiveFailures: 100,
        failureExitThreshold: 0,
        fatalStorageError: false,
      }),
    ).toBe(false);
  });

  it("can opt in to exiting after repeated nonfatal heartbeat failures", () => {
    expect(
      shouldExitAcpWorkerAfterHeartbeatFailure({
        consecutiveFailures: 2,
        failureExitThreshold: 3,
        fatalStorageError: false,
      }),
    ).toBe(false);
    expect(
      shouldExitAcpWorkerAfterHeartbeatFailure({
        consecutiveFailures: 3,
        failureExitThreshold: 3,
        fatalStorageError: false,
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
    (workers.getAcpWorker as jest.Mock).mockReturnValue({
      worker_id: "worker-a",
      state: "active",
      pid: process.pid,
      last_heartbeat_at: Date.now(),
    });

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

  it("repairs a running turn after its detached worker has stopped", async () => {
    const request = makeRequest();
    const queued = enqueueAcpJob(request as any);
    const running = claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
      worker_id: "worker-dead",
      worker_bundle_version: "bundle-a",
    });
    expect(running?.state).toBe("running");
    (workers.getAcpWorker as jest.Mock).mockReturnValue({
      worker_id: "worker-dead",
      state: "stopped",
      pid: 999_999_999,
      last_heartbeat_at: Date.now() - 60_000,
    });
    const rows = [
      {
        event: "chat-thread-state",
        thread_id: request.chat.thread_id,
        state: "running",
      },
    ];
    (chatServer.acquireChatSyncDB as jest.Mock).mockResolvedValue(
      makeSyncdb(rows),
    );

    await expect(
      turnNeedsInterruptedRepair({
        client: {} as ConatClient,
        turn: {
          project_id: queued.project_id,
          path: queued.path,
          message_id: queued.assistant_message_id,
        },
      }),
    ).resolves.toBe(true);
  });
});

describe("project fence follow-ups", () => {
  const wake = jest.fn(async () => {});
  const client = {} as ConatClient;

  beforeEach(() => {
    listPendingAcpSteers();
    listDueAgentRpcReports(Date.now());
    getAcpDatabase().prepare("DELETE FROM acp_steers").run();
    getAcpDatabase().prepare("DELETE FROM acp_agent_rpc_reports").run();
    wake.mockClear();
    configureAcpDetachedWorkerRunning(wake as any);
  });

  afterAll(() => {
    configureAcpDetachedWorkerRunning(undefined);
  });

  function runningTurn(rows: any[], request: any = makeRequest()) {
    const job = enqueueAcpJob(request);
    claimNextQueuedAcpJobForThread({
      project_id: job.project_id,
      path: job.path,
      thread_id: job.thread_id,
      worker_id: "worker-before-restart",
      worker_bundle_version: "bundle-before-restart",
    });
    getAcpDatabase()
      .prepare("UPDATE acp_jobs SET started_at = ? WHERE op_id = ?")
      .run(Date.now() - 60_000, job.op_id);
    rows.push(
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
            content: "Working on it",
            date: request.chat.message_date,
          },
        ],
      },
      {
        event: "chat-thread-state",
        sender_id: "__thread_state__",
        date: "1970-01-01T00:00:00.000Z",
        thread_id: request.chat.thread_id,
        active_message_id: request.chat.message_id,
        state: "running",
      },
    );
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(makeSyncdb(rows));
    return { request, job };
  }

  function handledGuidance(job: any, user_message_id: string, prompt: string) {
    const now = Date.now();
    getAcpDatabase()
      .prepare(
        `INSERT INTO acp_steers (id, project_id, path, thread_id, user_message_id,
           candidate_ids_json, request_json, state, created_at, updated_at, handled_at)
         VALUES (?, ?, ?, ?, ?, '[]', ?, 'handled', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        job.project_id,
        job.path,
        job.thread_id,
        user_message_id,
        JSON.stringify({ prompt }),
        now - 5_000,
        now - 5_000,
        now - 5_000,
      );
  }

  it("shows a stopped project's turn as interrupted, without resuming it", async () => {
    const rows: any[] = [];
    const { request, job } = runningTurn(rows);

    await fenceAcpProjectAfterStop({ project_id: job.project_id });
    expect(getAcpJobByOpId(job.op_id)).toMatchObject({
      state: "interrupted",
      recovery_code: ACP_FENCE_INTENT_STOPPED,
    });
    await processAcpProjectFenceIntents(client);

    const turn = rows.find((row) => row.message_id === request.chat.message_id);
    expect(turn.generating).toBe(false);
    expect(turn.acp_interrupted_text).toContain("project was stopped");
    expect(getAcpJobByOpId(job.op_id)?.recovery_code).toBeNull();
    expect(releaseAcpProjectFenceResumesAfterStart(job.project_id)).toBe(0);
    await processAcpProjectFenceIntents(client);
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: job.op_id }),
    ).toHaveLength(0);
  });

  it("resumes a restarted project's turn once it runs again, with guidance it may have missed", async () => {
    const rows: any[] = [];
    const { request, job } = runningTurn(rows);
    handledGuidance(job, "guidance-1", "Also update the changelog.");

    await fenceAcpProjectAfterStop({
      project_id: job.project_id,
      resume: true,
    });
    expect(getAcpJobByOpId(job.op_id)).toMatchObject({
      state: "interrupted",
      error: ACP_PROJECT_RESUME_FENCE_REASON,
      recovery_code: ACP_FENCE_INTENT_RESUME_PENDING,
    });

    // While the project is down the chat says so, and nothing runs.
    await processAcpProjectFenceIntents(client);
    const turn = rows.find((row) => row.message_id === request.chat.message_id);
    expect(turn.generating).toBe(false);
    expect(turn.acp_interrupted_text).toContain("CoCalc resumes this turn");
    expect(getAcpJobByOpId(job.op_id)?.recovery_detail).toBe(
      ACP_FENCE_CHAT_FINALIZED,
    );
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: job.op_id }),
    ).toHaveLength(0);

    expect(releaseAcpProjectFenceResumesAfterStart(job.project_id)).toBe(1);
    await processAcpProjectFenceIntents(client);

    const recoveries = listAcpJobsByRecoveryParent({
      recovery_parent_op_id: job.op_id,
    });
    expect(recoveries).toHaveLength(1);
    const resumed = decodeAcpJobRequest(recoveries[0]);
    expect(resumed.prompt).toContain("the project restarted");
    expect(resumed.prompt).toContain("Also update the changelog.");
    expect(resumed.prompt).toContain(request.prompt);
    expect(resumed.chat?.user_message_content).toContain("System recovery");
    expect(getAcpJobByOpId(job.op_id)?.recovery_code).toBeNull();
    expect(wake).toHaveBeenCalled();

    // Processing again never resumes twice.
    await processAcpProjectFenceIntents(client);
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: job.op_id }),
    ).toHaveLength(1);
  });

  it("treats a restart that is not running again within the hour as a stop", async () => {
    const rows: any[] = [];
    const { request, job } = runningTurn(rows);
    await fenceAcpProjectAfterStop({
      project_id: job.project_id,
      resume: true,
    });
    getAcpDatabase()
      .prepare("UPDATE acp_jobs SET finished_at = ? WHERE op_id = ?")
      .run(Date.now() - 2 * 60 * 60_000, job.op_id);

    await processAcpProjectFenceIntents(client);
    expect(getAcpJobByOpId(job.op_id)?.recovery_code).toBe(
      ACP_FENCE_INTENT_STOPPED,
    );
    expect(releaseAcpProjectFenceResumesAfterStart(job.project_id)).toBe(0);
    await processAcpProjectFenceIntents(client);

    const turn = rows.find((row) => row.message_id === request.chat.message_id);
    expect(turn.generating).toBe(false);
    expect(getAcpJobByOpId(job.op_id)?.recovery_code).toBeNull();
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: job.op_id }),
    ).toHaveLength(0);
  });

  it("queues a message held back by a restart again once the project runs", async () => {
    const queued = enqueueAcpJob(makeRequest() as any);
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(makeSyncdb([]));

    await fenceAcpProjectAfterStop({
      project_id: queued.project_id,
      resume: true,
    });
    expect(getAcpJobByOpId(queued.op_id)).toMatchObject({
      state: "canceled",
      recovery_code: ACP_FENCE_INTENT_RESUME_PENDING,
    });
    await processAcpProjectFenceIntents(client);
    expect(getAcpJobByOpId(queued.op_id)?.state).toBe("canceled");

    expect(releaseAcpProjectFenceResumesAfterStart(queued.project_id)).toBe(1);
    await processAcpProjectFenceIntents(client);
    expect(getAcpJobByOpId(queued.op_id)).toMatchObject({
      state: "queued",
      recovery_code: null,
    });
    expect(wake).toHaveBeenCalled();
  });

  it("lets a stop win against a resume that is already being enqueued", async () => {
    const rows: any[] = [];
    const { job } = runningTurn(rows);
    await fenceAcpProjectAfterStop({
      project_id: job.project_id,
      resume: true,
    });
    await processAcpProjectFenceIntents(client); // chat shows the restart
    expect(releaseAcpProjectFenceResumesAfterStart(job.project_id)).toBe(1);

    // Block the resume while it saves its recovery message to the chat.
    let saving!: () => void;
    const saveStarted = new Promise<void>((resolve) => (saving = resolve));
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => (unblock = resolve));
    const syncdb = makeSyncdb(rows);
    syncdb.save = jest.fn(async () => {
      saving();
      await gate;
    });
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);
    const processing = processAcpProjectFenceIntents(client);
    await saveStarted;

    // The project is stopped meanwhile: both sweeps finish first.
    await fenceAcpProjectAfterStop({ project_id: job.project_id });
    unblock();
    await processing;

    expect(listQueuedAcpJobs()).toHaveLength(0);
    for (const child of listAcpJobsByRecoveryParent({
      recovery_parent_op_id: job.op_id,
    })) {
      expect(child.state).not.toBe("queued");
      expect(child.state).not.toBe("running");
    }
    expect(getAcpJobByOpId(job.op_id)?.recovery_code).toBe(
      ACP_FENCE_INTENT_STOPPED,
    );
  });

  // A message sent in the same thread after the running turn.
  function laterMessage(request: any) {
    return {
      ...request,
      prompt: "a later message",
      chat: {
        ...request.chat,
        parent_message_id: "user-later",
        message_id: "assistant-later",
        message_date: "2026-03-16T00:00:09.000Z",
      },
    };
  }

  it("runs newer messages instead of resuming, and says so", async () => {
    const rows: any[] = [];
    const { request, job } = runningTurn(rows);
    const later = enqueueAcpJob(laterMessage(request));
    await fenceAcpProjectAfterStop({
      project_id: job.project_id,
      resume: true,
    });
    await processAcpProjectFenceIntents(client);
    const turn = rows.find((row) => row.message_id === request.chat.message_id);
    // The newer message is held and may still be canceled.
    expect(turn.acp_interrupted_text).toContain("CoCalc resumes");

    expect(releaseAcpProjectFenceResumesAfterStart(job.project_id)).toBe(2);
    await processAcpProjectFenceIntents(client);
    const after = rows.find(
      (row) => row.message_id === request.chat.message_id,
    );
    expect(after.acp_interrupted_text).toContain(
      "newer messages in this thread run instead",
    );
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: job.op_id }),
    ).toHaveLength(0);
    expect(getAcpJobByOpId(job.op_id)?.recovery_code).toBeNull();
    expect(getAcpJobByOpId(later.op_id)?.state).toBe("queued");
  });

  it("resumes a turn whose only newer message was canceled while held", async () => {
    const rows: any[] = [];
    const { request, job } = runningTurn(rows);
    const later = enqueueAcpJob(laterMessage(request));
    await fenceAcpProjectAfterStop({
      project_id: job.project_id,
      resume: true,
    });
    await processAcpProjectFenceIntents(client);
    expect(
      cancelQueuedAcpJob({
        project_id: later.project_id,
        path: later.path,
        user_message_id: later.user_message_id,
        account_id: later.account_id,
        thread_id: later.thread_id,
      }),
    ).toMatchObject({ state: "canceled" });

    expect(releaseAcpProjectFenceResumesAfterStart(job.project_id)).toBe(1);
    await processAcpProjectFenceIntents(client);
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: job.op_id }),
    ).toHaveLength(1);
    expect(getAcpJobByOpId(later.op_id)?.state).toBe("canceled");
    const turn = rows.find((row) => row.message_id === request.chat.message_id);
    expect(turn.acp_interrupted_text).not.toContain("run instead");
  });

  it("keeps the resume retryable when the chat cannot be told newer messages win", async () => {
    const rows: any[] = [];
    const { request, job } = runningTurn(rows);
    enqueueAcpJob(laterMessage(request));
    await fenceAcpProjectAfterStop({
      project_id: job.project_id,
      resume: true,
    });
    await processAcpProjectFenceIntents(client);
    expect(releaseAcpProjectFenceResumesAfterStart(job.project_id)).toBe(2);

    // Saving the replaced notice fails.
    const broken = makeSyncdb(rows);
    broken.save = jest.fn(async () => {
      throw new Error("chat unavailable");
    });
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(broken);
    await processAcpProjectFenceIntents(client);
    expect(getAcpJobByOpId(job.op_id)?.recovery_code).toBe(
      ACP_FENCE_INTENT_RESUME_READY,
    );

    // A later pass replaces it, then ends the resume.
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(makeSyncdb(rows));
    await processAcpProjectFenceIntents(client);
    const turn = rows.find((row) => row.message_id === request.chat.message_id);
    expect(turn.acp_interrupted_text).toContain("run instead");
    expect(getAcpJobByOpId(job.op_id)?.recovery_code).toBeNull();
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: job.op_id }),
    ).toHaveLength(0);
  });

  it("resumes after all when the newer message is canceled while the chat is updated", async () => {
    const rows: any[] = [];
    const { request, job } = runningTurn(rows);
    const later = enqueueAcpJob(laterMessage(request));
    await fenceAcpProjectAfterStop({
      project_id: job.project_id,
      resume: true,
    });
    await processAcpProjectFenceIntents(client);
    expect(releaseAcpProjectFenceResumesAfterStart(job.project_id)).toBe(2);

    // The user cancels the newer message while the "run instead" notice is
    // being written.
    const syncdb = makeSyncdb(rows);
    const set = syncdb.set;
    let canceled = false;
    syncdb.set = (val: any) => {
      if (
        !canceled &&
        `${val?.acp_interrupted_text ?? ""}`.includes("run instead")
      ) {
        canceled = true;
        cancelQueuedAcpJob({
          project_id: later.project_id,
          path: later.path,
          user_message_id: later.user_message_id,
          account_id: later.account_id,
          thread_id: later.thread_id,
        });
      }
      return set(val);
    };
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);
    await processAcpProjectFenceIntents(client);
    expect(canceled).toBe(true);
    // Not ended: handed back, since nothing newer runs any more.
    expect(getAcpJobByOpId(job.op_id)?.recovery_code).toBe(
      ACP_FENCE_INTENT_RESUME_READY,
    );

    await processAcpProjectFenceIntents(client);
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: job.op_id }),
    ).toHaveLength(1);
    expect(getAcpJobByOpId(later.op_id)?.state).toBe("canceled");
    const turn = rows.find((row) => row.message_id === request.chat.message_id);
    expect(turn.acp_interrupted_text).not.toContain("run instead");
  });

  it("does not resume a turn past the recovery limit", async () => {
    const rows: any[] = [];
    const { request, job } = runningTurn(rows);
    getAcpDatabase()
      .prepare("UPDATE acp_jobs SET recovery_count = ? WHERE op_id = ?")
      .run(2, job.op_id);
    await fenceAcpProjectAfterStop({
      project_id: job.project_id,
      resume: true,
    });
    await processAcpProjectFenceIntents(client);
    const turn = rows.find((row) => row.message_id === request.chat.message_id);
    expect(turn.acp_interrupted_text).toContain("already resumed");

    expect(releaseAcpProjectFenceResumesAfterStart(job.project_id)).toBe(1);
    await processAcpProjectFenceIntents(client);
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: job.op_id }),
    ).toHaveLength(0);
    expect(getAcpJobByOpId(job.op_id)?.recovery_code).toBeNull();
  });

  // Fence, show the restart in the chat, start again: ready to resume.
  async function readyToResume(rows: any[], request?: any) {
    const turn = runningTurn(rows, request);
    await fenceAcpProjectAfterStop({
      project_id: turn.job.project_id,
      resume: true,
    });
    await processAcpProjectFenceIntents(client);
    expect(releaseAcpProjectFenceResumesAfterStart(turn.job.project_id)).toBe(
      1,
    );
    return turn;
  }

  it("retries a resume that fails before its continuation is queued", async () => {
    const rows: any[] = [];
    const { job } = await readyToResume(rows);
    const syncdb = makeSyncdb(rows);
    syncdb.save = jest
      .fn()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValue(undefined);
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);

    await processAcpProjectFenceIntents(client);
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: job.op_id }),
    ).toHaveLength(0);
    // Not consumed: handed back for the next poll.
    expect(getAcpJobByOpId(job.op_id)?.recovery_code).toBe(
      ACP_FENCE_INTENT_RESUME_READY,
    );
    expect(listDueAgentRpcReports(Date.now() + 60 * 60_000)).toHaveLength(0);

    await processAcpProjectFenceIntents(client);
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: job.op_id }),
    ).toHaveLength(1);
    expect(getAcpJobByOpId(job.op_id)?.recovery_code).toBeNull();
  });

  it("does not resume before the cut-off turn's chat shows it ended", async () => {
    const rows: any[] = [];
    const { request, job } = runningTurn(rows);
    await fenceAcpProjectAfterStop({
      project_id: job.project_id,
      resume: true,
    });
    // Released before any poll could write the chat.
    expect(releaseAcpProjectFenceResumesAfterStart(job.project_id)).toBe(1);
    const syncdb = makeSyncdb(rows);
    syncdb.save = jest
      .fn()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValue(undefined);
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);

    await processAcpProjectFenceIntents(client);
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: job.op_id }),
    ).toHaveLength(0);
    expect(getAcpJobByOpId(job.op_id)?.recovery_code).toBe(
      ACP_FENCE_INTENT_RESUME_READY,
    );

    await processAcpProjectFenceIntents(client);
    const turn = rows.find((row) => row.message_id === request.chat.message_id);
    expect(turn.generating).toBe(false);
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: job.op_id }),
    ).toHaveLength(1);
  });

  it("counts a resume as done once its continuation is queued, even if a later step fails", async () => {
    const rows: any[] = [];
    const { job } = await readyToResume(rows);
    const syncdb = makeSyncdb(rows);
    // The recovery message saves; showing the continuation as queued fails.
    syncdb.save = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("storage unavailable"));
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);

    await processAcpProjectFenceIntents(client);
    const children = listAcpJobsByRecoveryParent({
      recovery_parent_op_id: job.op_id,
    });
    expect(children).toHaveLength(1);
    expect(children[0].state).toBe("queued");
    expect(getAcpJobByOpId(job.op_id)?.recovery_code).toBeNull();
    expect(wake).toHaveBeenCalled();
  });

  it("lets an Interrupt win against a continuation that was just queued", async () => {
    const rows: any[] = [];
    const { job } = await readyToResume(rows);
    let blocked!: () => void;
    const reachedProjection = new Promise<void>((r) => (blocked = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const syncdb = makeSyncdb(rows);
    let saves = 0;
    syncdb.save = jest.fn(async () => {
      saves += 1;
      // The second save shows the queued continuation: block it there.
      if (saves === 2) {
        blocked();
        await gate;
      }
    });
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);
    wake.mockClear();
    const processing = processAcpProjectFenceIntents(client);
    await reachedProjection;
    expect(listQueuedAcpJobs()).toHaveLength(1);

    stopAcpFenceResumesForThread({
      project_id: job.project_id,
      path: job.path,
      thread_id: job.thread_id,
    });
    release();
    await processing;

    expect(listQueuedAcpJobs()).toHaveLength(0);
    expect(wake).not.toHaveBeenCalled();
    expect(getAcpJobByOpId(job.op_id)?.recovery_code).toBe(
      ACP_FENCE_INTENT_STOPPED,
    );
  });

  it("does not resume a one-time sensor wake", async () => {
    const base = makeRequest();
    const rows: any[] = [];
    const { request, job } = await readyToResume(rows, {
      ...base,
      chat: {
        ...base.chat,
        sensor_wake: { permit: "[redacted]" },
      },
    });
    await processAcpProjectFenceIntents(client);
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: job.op_id }),
    ).toHaveLength(0);
    expect(getAcpJobByOpId(job.op_id)?.recovery_code).toBeNull();
    const turn = rows.find((row) => row.message_id === request.chat.message_id);
    expect(turn.acp_interrupted_text).toContain("sensor wake runs once");
  });

  it("tells the agent that sent a message its turn was stopped", async () => {
    const base = makeRequest();
    const request = {
      ...base,
      chat: {
        ...base.chat,
        agent_message: true,
        agent_rpc_execution: {
          version: 3,
          source: {
            project_id: "11111111-1111-4111-8111-111111111111",
            agent_id: "22222222-2222-4222-8222-222222222222",
          },
          source_run_id: "77777777-7777-4777-8777-777777777777",
          target: {
            project_id: base.project_id,
            agent_id: "44444444-4444-4444-8444-444444444444",
          },
          target_path: base.chat.path,
          target_thread_id: base.chat.thread_id,
          agent_network_id: "88888888-8888-4888-8888-888888888888",
          network_generation: "99999999-9999-4999-8999-999999999999",
          account_generation: 3,
          configured_delivery: "queued",
          principal_account_id: base.account_id,
          guidance: false,
          attempt_id: "55555555-5555-4555-8555-555555555555",
          report_capability: "1791800000000." + "c".repeat(43),
        },
      },
    };
    const rows: any[] = [];
    const { job } = runningTurn(rows, request);

    await fenceAcpProjectAfterStop({ project_id: job.project_id });
    await processAcpProjectFenceIntents(client);

    const reports = listDueAgentRpcReports(Date.now() + 60 * 60_000);
    expect(reports).toHaveLength(1);
    expect(reports[0].report.attempt_id).toBe(
      "55555555-5555-4555-8555-555555555555",
    );
    expect(reports[0].report.detail ?? "").toContain("project was stopped");
    // Typed, not guessed from the text.
    expect(reports[0].report.kind).toBe("project-stopped");
  });

  it("tells it too when the stopped turn was resuming an earlier one", async () => {
    const base = makeRequest();
    const request = {
      ...base,
      chat: {
        ...base.chat,
        agent_message: true,
        agent_rpc_execution: {
          version: 3,
          source: {
            project_id: "11111111-1111-4111-8111-111111111111",
            agent_id: "22222222-2222-4222-8222-222222222222",
          },
          source_run_id: "77777777-7777-4777-8777-777777777777",
          target: {
            project_id: base.project_id,
            agent_id: "44444444-4444-4444-8444-444444444444",
          },
          target_path: base.chat.path,
          target_thread_id: base.chat.thread_id,
          agent_network_id: "88888888-8888-4888-8888-888888888888",
          network_generation: "99999999-9999-4999-8999-999999999999",
          account_generation: 3,
          configured_delivery: "queued",
          principal_account_id: base.account_id,
          guidance: false,
          attempt_id: "55555555-5555-4555-8555-555555555555",
          report_capability: "1791800000000." + "c".repeat(43),
        },
      },
    };
    // The first attempt was cut off and queued this continuation.
    const first = enqueueAcpJob({
      ...request,
      chat: {
        ...request.chat,
        message_id: randomUUID(),
        parent_message_id: randomUUID(),
      },
    });
    getAcpDatabase()
      .prepare("UPDATE acp_jobs SET state='error', started_at=? WHERE op_id=?")
      .run(Date.now() - 120_000, first.op_id);
    const rows: any[] = [];
    const { job } = runningTurn(rows, request);
    getAcpDatabase()
      .prepare("UPDATE acp_jobs SET recovery_parent_op_id=? WHERE op_id=?")
      .run(first.op_id, job.op_id);

    await fenceAcpProjectAfterStop({ project_id: job.project_id });
    await processAcpProjectFenceIntents(client);

    const reports = listDueAgentRpcReports(Date.now() + 60 * 60_000);
    expect(reports).toHaveLength(1);
    expect(reports[0].report.attempt_id).toBe(
      "55555555-5555-4555-8555-555555555555",
    );
    expect(reports[0].report.detail ?? "").toContain("project was stopped");
    // Typed, not guessed from the text.
    expect(reports[0].report.kind).toBe("project-stopped");
  });
});

describe("the agent that sent a message is told how its turn ended", () => {
  const authorization = (base: any) => ({
    version: 3,
    source: {
      project_id: "11111111-1111-4111-8111-111111111111",
      agent_id: "22222222-2222-4222-8222-222222222222",
    },
    source_run_id: "77777777-7777-4777-8777-777777777777",
    target: {
      project_id: base.project_id,
      agent_id: "44444444-4444-4444-8444-444444444444",
    },
    target_path: base.chat.path,
    target_thread_id: base.chat.thread_id,
    agent_network_id: "88888888-8888-4888-8888-888888888888",
    network_generation: "99999999-9999-4999-8999-999999999999",
    account_generation: 3,
    configured_delivery: "queued",
    principal_account_id: base.account_id,
    guidance: false,
    attempt_id: randomUUID(),
    report_capability: "1791800000000." + "c".repeat(43),
  });
  const agentRequest = (base: any = makeRequest()) => {
    const execution = authorization(base);
    return {
      execution,
      request: {
        ...base,
        chat: {
          ...base.chat,
          message_id: randomUUID(),
          parent_message_id: randomUUID(),
          agent_message: true,
          agent_rpc_execution: execution,
        },
      },
    };
  };
  const reports = () => listDueAgentRpcReports(Date.now() + 60 * 60_000);

  beforeEach(() => {
    reports();
    getAcpDatabase().prepare("DELETE FROM acp_agent_rpc_reports").run();
    acpTestInternals.initializeAcpRuntime({
      sync: { akv: () => ({}) },
    } as unknown as ConatClient);
    jest
      .mocked(chatServer.acquireChatSyncDB)
      .mockResolvedValue(makeSyncdb([]) as any);
  });

  it("when someone in its project cancels it before it runs", async () => {
    const { request, execution } = agentRequest();
    const job = enqueueAcpJob(request);
    await expect(
      acpTestInternals.handleAcpControlRequest({
        action: "cancel",
        account_id: request.account_id,
        project_id: job.project_id,
        path: job.path,
        thread_id: job.thread_id,
        user_message_id: job.user_message_id,
      } as any),
    ).resolves.toMatchObject({ ok: true, state: "canceled" });
    expect(parseTurnOutcome(getAcpJobByOpId(job.op_id)?.outcome_json)).toEqual({
      version: 1,
      state: "never-started",
      reason: "canceled",
    });
    const due = reports();
    expect(due).toHaveLength(1);
    expect(due[0].report).toMatchObject({
      attempt_id: execution.attempt_id,
      kind: "canceled",
      tool_ran: false,
    });
  });

  it("even when the chat cannot be updated for the cancel", async () => {
    const { request, execution } = agentRequest();
    const job = enqueueAcpJob(request);
    jest
      .mocked(chatServer.acquireChatSyncDB)
      .mockRejectedValue(new Error("chat unavailable"));
    await expect(
      acpTestInternals.handleAcpControlRequest({
        action: "cancel",
        account_id: request.account_id,
        project_id: job.project_id,
        path: job.path,
        thread_id: job.thread_id,
        user_message_id: job.user_message_id,
      } as any),
    ).rejects.toThrow("chat unavailable");
    expect(getAcpJobByOpId(job.op_id)?.state).toBe("canceled");
    const due = reports();
    expect(due).toHaveLength(1);
    expect(due[0].report).toMatchObject({
      attempt_id: execution.attempt_id,
      kind: "canceled",
      tool_ran: false,
    });
  });

  it("but not for a person's own message", async () => {
    const job = enqueueAcpJob({
      ...makeRequest(),
      chat: { ...makeRequest().chat, message_id: randomUUID() },
    } as any);
    await acpTestInternals.handleAcpControlRequest({
      action: "cancel",
      account_id: job.account_id,
      project_id: job.project_id,
      path: job.path,
      thread_id: job.thread_id,
      user_message_id: job.user_message_id,
    } as any);
    expect(getAcpJobByOpId(job.op_id)?.state).toBe("canceled");
    expect(reports()).toHaveLength(0);
  });

  it("when someone stops its turn", async () => {
    const previousEnabled = process.env.COCALC_ACP_HARNESSES;
    process.env.COCALC_ACP_HARNESSES = "1";
    setHarnessLauncher(async () => {
      throw Error("unexpected launch");
    });
    const originalAuthorize = hubApi.agent.authorizeRpcExecution;
    hubApi.agent.authorizeRpcExecution = jest.fn(async () => ({})) as any;
    const { request: raw, execution } = agentRequest();
    const request = prepareHarnessRequest({
      ...raw,
      session_id: undefined,
      config: undefined,
      runtime: {
        version: 1,
        kind: "acp",
        profile: {
          version: 2,
          kind: "acp",
          id: "claude-code",
          revision: "0.93.0",
          cwd: "/home/user",
          credentialMode: "project-managed",
          executionPolicy: "full-access",
        },
      },
      harness_credential: {
        version: 1,
        provider: "anthropic",
        mode: "account-subscription",
        credentialId: "33333333-3333-4333-8333-333333333333",
      },
    });
    const job = enqueueAcpJob(request);
    jest.mocked(chatServer.acquireChatSyncDB).mockResolvedValue(
      makeSyncdb([
        {
          event: "chat-thread-config",
          thread_id: request.chat!.thread_id,
          agent_kind: "acp",
          agent_runtime: request.runtime,
        },
      ]) as any,
    );
    acpTestInternals.initializeAcpRuntime({
      sync: { akv: () => ({}) },
    } as unknown as ConatClient);
    jest
      .spyOn(ChatStreamWriter.prototype as any, "persistLog")
      .mockResolvedValue(undefined);
    const evaluate = jest.fn(async ({ stream }: any) => {
      await stream({
        type: "event",
        event: {
          type: "harness",
          source: "acp",
          kind: "update",
          data: {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            status: "in_progress",
          },
        },
      });
      // Claude confirms the cancellation a person asked for.
      await stream({
        type: "event",
        event: {
          type: "harness",
          source: "acp",
          kind: "stop",
          data: { stopReason: "cancelled" },
        },
      });
    });
    const unregister = acpTestInternals.registerInterruptAgentForTests(
      harnessRuntimeKey(request),
      request.project_id,
      { evaluate } as any,
      true,
    );
    try {
      const claimed = claimNextQueuedAcpJobForThread({
        project_id: job.project_id,
        path: job.path,
        thread_id: job.thread_id,
      })!;
      await acpTestInternals.runQueuedAcpJob(claimed);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(
        parseTurnOutcome(getAcpJobByOpId(job.op_id)?.outcome_json),
      ).toEqual({
        version: 1,
        state: "canceled",
        by: "person",
        tool_ran: true,
      });
      const due = reports();
      expect(due).toHaveLength(1);
      expect(due[0].report).toMatchObject({
        attempt_id: execution.attempt_id,
        kind: "stopped",
        tool_ran: true,
      });
    } finally {
      unregister();
      hubApi.agent.authorizeRpcExecution = originalAuthorize;
      setHarnessLauncher();
      if (previousEnabled === undefined)
        delete process.env.COCALC_ACP_HARNESSES;
      else process.env.COCALC_ACP_HARNESSES = previousEnabled;
    }
  });

  it("not by the worker when a project stop fenced the turn as it ended", async () => {
    const previousEnabled = process.env.COCALC_ACP_HARNESSES;
    process.env.COCALC_ACP_HARNESSES = "1";
    setHarnessLauncher(async () => {
      throw Error("unexpected launch");
    });
    const originalAuthorize = hubApi.agent.authorizeRpcExecution;
    hubApi.agent.authorizeRpcExecution = jest.fn(async () => ({})) as any;
    const { request: raw, execution } = agentRequest();
    const request = prepareHarnessRequest({
      ...raw,
      session_id: undefined,
      config: undefined,
      runtime: {
        version: 1,
        kind: "acp",
        profile: {
          version: 2,
          kind: "acp",
          id: "claude-code",
          revision: "0.93.0",
          cwd: "/home/user",
          credentialMode: "project-managed",
          executionPolicy: "full-access",
        },
      },
      harness_credential: {
        version: 1,
        provider: "anthropic",
        mode: "account-subscription",
        credentialId: "33333333-3333-4333-8333-333333333333",
      },
    });
    const job = enqueueAcpJob(request);
    jest.mocked(chatServer.acquireChatSyncDB).mockResolvedValue(
      makeSyncdb([
        {
          event: "chat-thread-config",
          thread_id: request.chat!.thread_id,
          agent_kind: "acp",
          agent_runtime: request.runtime,
        },
      ]) as any,
    );
    acpTestInternals.initializeAcpRuntime({
      sync: { akv: () => ({}) },
    } as unknown as ConatClient);
    jest
      .spyOn(ChatStreamWriter.prototype as any, "persistLog")
      .mockResolvedValue(undefined);
    const evaluate = jest.fn(async ({ stream }: any) => {
      await stream({
        type: "event",
        event: {
          type: "harness",
          source: "acp",
          kind: "update",
          data: {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            status: "in_progress",
          },
        },
      });
      // The project stops while the turn unwinds: the fence takes the job.
      await fenceAcpProjectAfterStop({ project_id: request.project_id });
      // Claude confirms the cancellation a person asked for.
      await stream({
        type: "event",
        event: {
          type: "harness",
          source: "acp",
          kind: "stop",
          data: { stopReason: "cancelled" },
        },
      });
    });
    const unregister = acpTestInternals.registerInterruptAgentForTests(
      harnessRuntimeKey(request),
      request.project_id,
      { evaluate } as any,
      true,
    );
    try {
      const claimed = claimNextQueuedAcpJobForThread({
        project_id: job.project_id,
        path: job.path,
        thread_id: job.thread_id,
      })!;
      await acpTestInternals.runQueuedAcpJob(claimed);
      expect(evaluate).toHaveBeenCalledTimes(1);
      // The worker saw a stop, but the fence owns the job now.
      expect(reports()).toHaveLength(0);
      expect(getAcpJobByOpId(job.op_id)?.state).not.toBe("canceled");
      await processAcpProjectFenceIntents({
        sync: { akv: () => ({}) },
      } as unknown as ConatClient);
      const due = reports();
      expect(due).toHaveLength(1);
      expect(due[0].report).toMatchObject({
        attempt_id: execution.attempt_id,
        kind: "project-stopped",
      });
    } finally {
      unregister();
      hubApi.agent.authorizeRpcExecution = originalAuthorize;
      setHarnessLauncher();
      if (previousEnabled === undefined)
        delete process.env.COCALC_ACP_HARNESSES;
      else process.env.COCALC_ACP_HARNESSES = previousEnabled;
    }
  });

  it("not by the worker when a project stop fenced the turn while it was prepared", async () => {
    const previousEnabled = process.env.COCALC_ACP_HARNESSES;
    process.env.COCALC_ACP_HARNESSES = "1";
    setHarnessLauncher(async () => {
      throw Error("unexpected launch");
    });
    const originalAuthorize = hubApi.agent.authorizeRpcExecution;
    hubApi.agent.authorizeRpcExecution = jest.fn(async () => ({})) as any;
    const { request: raw, execution } = agentRequest();
    const request = prepareHarnessRequest({
      ...raw,
      session_id: undefined,
      config: undefined,
      runtime: {
        version: 1,
        kind: "acp",
        profile: {
          version: 2,
          kind: "acp",
          id: "claude-code",
          revision: "0.93.0",
          cwd: "/home/user",
          credentialMode: "project-managed",
          executionPolicy: "full-access",
        },
      },
      harness_credential: {
        version: 1,
        provider: "anthropic",
        mode: "account-subscription",
        credentialId: "33333333-3333-4333-8333-333333333333",
      },
    });
    const job = enqueueAcpJob(request);
    const chatRows = [
      {
        event: "chat-thread-config",
        thread_id: request.chat!.thread_id,
        agent_kind: "acp",
        agent_runtime: request.runtime,
      },
    ];
    // The project stops while the job's chat is read: then the read fails.
    jest
      .mocked(chatServer.acquireChatSyncDB)
      .mockImplementationOnce(async () => {
        await fenceAcpProjectAfterStop({ project_id: request.project_id });
        throw new Error("chat unavailable");
      })
      .mockResolvedValue(makeSyncdb(chatRows) as any);
    acpTestInternals.initializeAcpRuntime({
      sync: { akv: () => ({}) },
    } as unknown as ConatClient);
    jest
      .spyOn(ChatStreamWriter.prototype as any, "persistLog")
      .mockResolvedValue(undefined);
    const evaluate = jest.fn(async ({ stream }: any) => {
      await stream({
        type: "event",
        event: {
          type: "harness",
          source: "acp",
          kind: "update",
          data: {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            status: "in_progress",
          },
        },
      });
      // Claude confirms the cancellation a person asked for.
      await stream({
        type: "event",
        event: {
          type: "harness",
          source: "acp",
          kind: "stop",
          data: { stopReason: "cancelled" },
        },
      });
    });
    const unregister = acpTestInternals.registerInterruptAgentForTests(
      harnessRuntimeKey(request),
      request.project_id,
      { evaluate } as any,
      true,
    );
    try {
      const claimed = claimNextQueuedAcpJobForThread({
        project_id: job.project_id,
        path: job.path,
        thread_id: job.thread_id,
      })!;
      await acpTestInternals.runQueuedAcpJob(claimed);
      expect(evaluate).not.toHaveBeenCalled();
      // The preparation failed, but the fence owns the job now.
      expect(reports()).toHaveLength(0);
      expect(getAcpJobByOpId(job.op_id)?.state).not.toBe("canceled");
      await processAcpProjectFenceIntents({
        sync: { akv: () => ({}) },
      } as unknown as ConatClient);
      const due = reports();
      expect(due).toHaveLength(1);
      expect(due[0].report).toMatchObject({
        attempt_id: execution.attempt_id,
        kind: "project-stopped",
      });
    } finally {
      unregister();
      hubApi.agent.authorizeRpcExecution = originalAuthorize;
      setHarnessLauncher();
      if (previousEnabled === undefined)
        delete process.env.COCALC_ACP_HARNESSES;
      else process.env.COCALC_ACP_HARNESSES = previousEnabled;
    }
  });

  it("when a newer message replaces the turn waiting to resume", () => {
    const base = makeRequest();
    const { request, execution } = agentRequest(base);
    const parent = enqueueAcpJob(request);
    // It ran, and was cut off.
    claimNextQueuedAcpJobForThread({
      project_id: parent.project_id,
      path: parent.path,
      thread_id: parent.thread_id,
    });
    setAcpJobState({
      op_id: parent.op_id,
      state: "error",
      outcome: {
        version: 1,
        state: "failed",
        failure: { kind: "host-lost" },
        tool_ran: true,
      },
    });
    // Its continuation, queued to resume it.
    const child = enqueueAcpJob({
      ...request,
      chat: {
        ...request.chat,
        message_id: randomUUID(),
        parent_message_id: randomUUID(),
      },
    });
    expect(child.op_id).not.toBe(parent.op_id);
    getAcpDatabase()
      .prepare("UPDATE acp_jobs SET recovery_parent_op_id = ? WHERE op_id = ?")
      .run(parent.op_id, child.op_id);
    // A person's newer message in the same thread supersedes it.
    const { canceled } = enqueueAcpJobCancelingQueuedRecoveries({
      ...base,
      chat: {
        ...base.chat,
        message_id: randomUUID(),
        parent_message_id: randomUUID(),
      },
    } as any);
    expect(canceled.map((row) => row.op_id)).toEqual([child.op_id]);
    for (const row of canceled) acpTestInternals.reportSupersededRecovery(row);
    // The continuation itself never ran; its chain had run tools.
    expect(
      parseTurnOutcome(getAcpJobByOpId(child.op_id)?.outcome_json),
    ).toEqual({
      version: 1,
      state: "canceled",
      by: "superseded",
      tool_ran: false,
    });
    const due = reports();
    expect(due).toHaveLength(1);
    expect(due[0].report).toMatchObject({
      attempt_id: execution.attempt_id,
      kind: "superseded",
      tool_ran: true,
    });
  });

  function chain(request: any, toolRan: (boolean | undefined)[]) {
    // Attempts of one message: each later one continues the one before.
    const jobs: any[] = [];
    for (const ran of toolRan) {
      const job = enqueueAcpJob({
        ...request,
        chat: {
          ...request.chat,
          message_id: randomUUID(),
          parent_message_id: jobs.length
            ? randomUUID()
            : request.chat.parent_message_id,
        },
      });
      getAcpDatabase()
        .prepare(
          "UPDATE acp_jobs SET state='error', started_at=?, recovery_parent_op_id=?, outcome_json=? WHERE op_id=?",
        )
        .run(
          Date.now() - 60_000,
          jobs.at(-1)?.op_id ?? null,
          JSON.stringify({
            version: 1,
            state: "failed",
            failure: { kind: "host-lost" },
            ...(ran === undefined ? {} : { tool_ran: ran }),
          }),
          job.op_id,
        );
      jobs.push(getAcpJobByOpId(job.op_id));
    }
    return jobs;
  }

  it.each([
    [[true, false, false], true],
    [[false, false, false], false],
    [[false, undefined, false], undefined],
  ] as const)(
    "a recovery chain whose attempts ran tools %j reports tool_ran %j, once",
    (attempts, expected) => {
      const { request } = agentRequest();
      const jobs = chain(request, [...attempts]);
      for (const job of [jobs.at(-1), jobs.at(-1)]) {
        acpTestInternals.reportFailedAgentMessageTurn(
          job,
          decodeAcpJobRequest(job),
          "lost",
        );
      }
      // An earlier attempt reporting too is the same report.
      acpTestInternals.reportFailedAgentMessageTurn(
        jobs[0],
        decodeAcpJobRequest(jobs[0]),
        "lost",
      );
      const due = reports();
      expect(due).toHaveLength(1);
      expect(due[0].report.tool_ran).toBe(expected);
    },
  );

  it("a continuation stopped before it started keeps its chain's tool use", () => {
    const { request } = agentRequest();
    const [first, queued] = chain(request, [true, undefined]);
    // The project stopped while the continuation was still queued.
    acpTestInternals.reportFailedAgentMessageTurn(
      queued,
      decodeAcpJobRequest(queued),
      "stopped",
      { version: 1, state: "never-started", reason: "project-stopped" },
    );
    const due = reports();
    expect(due).toHaveLength(1);
    expect(due[0].report).toMatchObject({
      kind: "project-stopped",
      tool_ran: true,
    });
    expect(first).toBeTruthy();
  });

  it("a chain whose last attempt has no outcome yet keeps its tool use", () => {
    const { request } = agentRequest();
    const [, last] = chain(request, [true, false]);
    getAcpDatabase()
      .prepare("UPDATE acp_jobs SET outcome_json = NULL WHERE op_id = ?")
      .run(last.op_id);
    acpTestInternals.reportFailedAgentMessageTurn(
      getAcpJobByOpId(last.op_id),
      decodeAcpJobRequest(last),
      "lost",
    );
    expect(reports()[0].report.tool_ran).toBe(true);
  });

  it("when its turn cannot even be prepared", async () => {
    const { request, execution } = agentRequest();
    const job = enqueueAcpJob(request);
    jest
      .mocked(chatServer.acquireChatSyncDB)
      .mockRejectedValueOnce(new Error("chat unavailable"));
    const claimed = claimNextQueuedAcpJobForThread({
      project_id: job.project_id,
      path: job.path,
      thread_id: job.thread_id,
    })!;
    await acpTestInternals.runQueuedAcpJob(claimed);
    expect(getAcpJobByOpId(job.op_id)?.state).toBe("canceled");
    expect(
      parseTurnOutcome(getAcpJobByOpId(job.op_id)?.outcome_json),
    ).toMatchObject({ state: "failed", tool_ran: false });
    const due = reports();
    expect(due).toHaveLength(1);
    expect(due[0].report).toMatchObject({
      attempt_id: execution.attempt_id,
      tool_ran: false,
    });
  });

  it("a cancel of a message a fence already canceled reports nothing", async () => {
    const { request } = agentRequest();
    const job = enqueueAcpJob(request);
    getAcpDatabase()
      .prepare("UPDATE acp_jobs SET state='canceled' WHERE op_id=?")
      .run(job.op_id);
    await acpTestInternals.handleAcpControlRequest({
      action: "cancel",
      account_id: request.account_id,
      project_id: job.project_id,
      path: job.path,
      thread_id: job.thread_id,
      user_message_id: job.user_message_id,
    } as any);
    expect(reports()).toHaveLength(0);
    expect(getAcpJobByOpId(job.op_id)?.outcome_json).toBeNull();
  });
});
