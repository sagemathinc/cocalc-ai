import type { Client } from "@cocalc/conat/core/client";
import type { AcpRequest, AcpSteerRequest } from "@cocalc/conat/ai/acp/types";
import { acquireChatSyncDB } from "@cocalc/chat/server";
import {
  acpTestInternals,
  configureAcpDetachedWorkerRunning,
  disposeAcpAgents,
  disposeAllChatWritersForTests,
} from "../index";
import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import {
  claimNextQueuedAcpJobForThread,
  decodeAcpJobRequest,
  enqueueAcpJob,
  getAcpJobByOpId,
  listQueuedAcpJobs,
  setAcpJobState,
} from "../../sqlite/acp-jobs";
import { listRunningAcpTurnLeases } from "../../sqlite/acp-turns";
import {
  claimAcpSteer,
  decodeAcpSteerRequest,
  enqueueAcpSteer,
  getAcpSteer,
  listPendingAcpSteers,
  markAcpSteerError,
} from "../../sqlite/acp-steers";
import type { AcpAttentionStoredRecord } from "../../sqlite/acp-attention";
import {
  pinCodexCredentialAtAdmission,
  setCodexCredentialAdmissionResolver,
} from "../codex-credential-admission";
import { setHarnessLauncher } from "../harness-runtime";
import { hubApi } from "../../api";
import { HarnessAgent } from "@cocalc/ai/acp/harness";

const mockSteer = jest.fn();
// The worker test injects a client; protocol transport is covered in ai/acp.
jest.mock("@agentclientprotocol/sdk-v1", () => ({}), { virtual: true });
const mockAuthorizeRpcExecution = jest.fn();
const originalAuthorizeRpcExecution = hubApi.agent.authorizeRpcExecution;
jest.mock("@cocalc/ai/acp", () => ({
  ...jest.requireActual("@cocalc/ai/acp"),
  CodexAppServerAgent: {
    create: async () => ({ steer: mockSteer }),
  },
}));
jest.mock("@cocalc/conat/ai/acp/server", () => ({ init: async () => {} }));
jest.mock("@cocalc/chat/server", () => ({
  acquireChatSyncDB: jest.fn(),
  releaseChatSyncDB: jest.fn(),
}));
jest.mock("../../sqlite/acp-turns", () => ({
  ...jest.requireActual("../../sqlite/acp-turns"),
  listRunningAcpTurnLeases: jest.fn(() => []),
}));
jest.mock("../workspace-root", () => ({
  preferContainerExecutor: () => false,
  resolveWorkspaceRoot: () => "/tmp",
}));
jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  getLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));
jest.mock("@cocalc/project/logger", () => {
  const logger = () => ({
    debug() {},
    info() {},
    warn() {},
    error() {},
    extend: () => logger(),
  });
  return {
    __esModule: true,
    default: logger,
    getLogger: logger,
    rootLogger: logger(),
  };
});

const projectId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const sessionId = "01a01361-c4fe-7da1-b9f5-4c44a15a479a";
const record = {
  attention_id: "attention-1",
  response_id: "response-1",
  response_submitted_at: Date.parse("2026-09-05T13:56:15.277Z"),
  project_id: projectId,
  account_id: accountId,
  path: "agent.chat",
  thread_id: "thread-1",
  questions: [{ id: "choice", header: "Choice", question: "Proceed?" }],
  response: { choice: ["Go ahead"] },
  chat: {
    notify_on_turn_finish: false,
    completion_notification_enabled: false,
  },
} as AcpAttentionStoredRecord;

let rows: any[];
const originalDetached = process.env.COCALC_LITE_ACP_DETACHED_WORKER;

function turnRequest(config: AcpRequest["config"]): AcpRequest {
  return {
    project_id: projectId,
    account_id: accountId,
    prompt: "Ask a question",
    config,
    chat: {
      project_id: projectId,
      path: record.path,
      thread_id: record.thread_id,
      parent_message_id: "original-user",
      message_id: "original-assistant",
      message_date: "2026-09-05T07:51:32.212Z",
      sender_id: "gpt-6-astra",
    },
  };
}

function startRunningTurn(request: AcpRequest) {
  enqueueAcpJob(request);
  return claimNextQueuedAcpJobForThread({
    project_id: projectId,
    path: record.path,
    thread_id: record.thread_id,
  })!;
}

function claudeTurnRequest(): AcpRequest {
  return {
    ...turnRequest(undefined),
    runtime: {
      version: 1,
      kind: "acp",
      profile: {
        version: 2,
        kind: "acp",
        id: "claude-code",
        revision: "0.81.1",
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
      claudeAiConnectors: false,
    },
  };
}

function rpcTurnRequest(config: AcpRequest["config"]): AcpRequest {
  const request = turnRequest(config);
  request.chat!.agent_rpc_execution = {
    version: 3,
    source: { agent_id: "source-agent", project_id: projectId },
    target: { agent_id: "target-agent", project_id: projectId },
    target_path: record.path,
    target_thread_id: record.thread_id,
    agent_network_id: "network",
    network_generation: "generation",
    account_generation: 0,
    configured_delivery: "queued",
    principal_account_id: accountId,
    guidance: false,
  };
  return request;
}

function mockLiveRuntime(config: AcpRequest["config"]) {
  const { CodexAppServerAgent } = jest.requireActual("@cocalc/ai/acp");
  const runtime = {
    opts: {},
    running: new Map([
      [
        sessionId,
        {
          executionAccountId: accountId,
          paymentSource: config?.paymentSource,
          credentialId: config?.credentialId,
          turnId: "live-turn",
          client: { request: jest.fn(async () => ({ turnId: "live-turn" })) },
        },
      ],
    ]),
  };
  mockSteer.mockImplementation((id, request) =>
    CodexAppServerAgent.prototype.steer.call(runtime, id, request),
  );
  return runtime;
}

beforeAll(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
});

afterAll(() => closeAcpDatabase());

beforeEach(() => {
  mockAuthorizeRpcExecution.mockReset().mockResolvedValue({});
  hubApi.agent.authorizeRpcExecution = mockAuthorizeRpcExecution;
  const db = getAcpDatabase();
  for (const { name } of db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'acp_%'",
    )
    .all()) {
    db.prepare(`DELETE FROM "${name.replace(/"/g, '""')}"`).run();
  }
  process.env.COCALC_LITE_ACP_DETACHED_WORKER = "1";
  configureAcpDetachedWorkerRunning(jest.fn(async () => undefined) as any);
  acpTestInternals.initializeAcpRuntime({
    sync: { akv: () => ({}) },
  } as unknown as Client);
  mockSteer.mockReset();
  jest.mocked(listRunningAcpTurnLeases).mockReturnValue([]);
  rows = [
    {
      event: "chat-thread-config",
      thread_id: record.thread_id,
      agent_model: "gpt-6-astra",
      acp_config: { model: "gpt-6-astra", sessionId },
    },
    {
      event: "chat",
      thread_id: record.thread_id,
      message_id: "original-assistant",
      date: "2026-09-05T07:51:32.212Z",
      sender_id: "gpt-6-astra",
    },
  ];
  const matches = (row: any, where: any) =>
    !where || Object.entries(where).every(([key, value]) => row[key] === value);
  jest.mocked(acquireChatSyncDB).mockResolvedValue({
    isReady: () => true,
    get: (where: any) => rows.filter((row) => matches(row, where)),
    get_one: (where: any) => rows.find((row) => matches(row, where)),
    set: (value: any) => {
      const existing = rows.find((row) => row.message_id === value.message_id);
      if (existing) Object.assign(existing, value);
      else rows.push(value);
    },
    commit() {},
    save: async () => {},
    versions: () => [],
  } as any);
});

afterEach(async () => {
  await disposeAllChatWritersForTests();
  if (originalAuthorizeRpcExecution === undefined)
    delete hubApi.agent.authorizeRpcExecution;
  else hubApi.agent.authorizeRpcExecution = originalAuthorizeRpcExecution;
  setCodexCredentialAdmissionResolver();
  await disposeAcpAgents();
  configureAcpDetachedWorkerRunning(undefined);
  if (originalDetached === undefined)
    delete process.env.COCALC_LITE_ACP_DETACHED_WORKER;
  else process.env.COCALC_LITE_ACP_DETACHED_WORKER = originalDetached;
});

it("does not deliver a harness answer through Codex when its runtime is missing", async () => {
  await expect(
    acpTestInternals.deliverAsyncAttentionAnswer({
      ...record,
      chat: { ...record.chat, sender_id: "acp-harness" },
    }),
  ).rejects.toThrow(/execution configuration is unavailable/);
  expect(mockSteer).not.toHaveBeenCalled();
  expect(listQueuedAcpJobs()).toHaveLength(0);
});

it.each([true, false])(
  "delivers Claude answers with private funding (running=%s)",
  async (running) => {
    const previous = process.env.COCALC_ACP_HARNESSES;
    process.env.COCALC_ACP_HARNESSES = "1";
    setHarnessLauncher(async () => {
      throw Error("must not launch during delivery");
    });
    const source = claudeTurnRequest();
    rows[0].agent_runtime = source.runtime;
    rows[0].agent_session_id = "claude-session";
    const job = startRunningTurn(source);
    if (!running) setAcpJobState({ op_id: job.op_id, state: "done" });
    const steer = jest.fn(async (id) => ({
      state: id === "claude-session" && running ? "steered" : "missing",
      threadId: id,
    }));
    const unregister = acpTestInternals.registerInterruptAgentForTests(
      "claude",
      projectId,
      { steer } as any,
      true,
    );
    const claudeRecord = {
      ...record,
      chat: {
        ...source.chat!,
        ...record.chat,
        harness_session_id: "claude-session",
      },
    };
    try {
      const result =
        await acpTestInternals.deliverAsyncAttentionAnswer(claudeRecord);
      expect(result.state).toBe(running ? "steered" : "queued");
      expect(mockSteer).not.toHaveBeenCalled();
      if (running) {
        expect(steer).toHaveBeenCalledWith(
          "claude-session",
          expect.objectContaining({
            runtime: source.runtime,
            harness_credential: source.harness_credential,
          }),
        );
        expect(
          steer.mock.calls.find(([id]) => id === "claude-session")?.[1]?.config,
        ).toBeUndefined();
      } else {
        const queued = listQueuedAcpJobs();
        expect(queued).toHaveLength(1);
        expect(decodeAcpJobRequest(queued[0])).toMatchObject({
          runtime: source.runtime,
          harness_credential: source.harness_credential,
          session_id: "claude-session",
        });
      }
      const count = steer.mock.calls.length;
      await acpTestInternals.deliverAsyncAttentionAnswer(claudeRecord);
      expect(steer).toHaveBeenCalledTimes(count);
      expect(JSON.stringify(rows)).not.toContain(
        source.harness_credential!.mode,
      );
    } finally {
      unregister();
      setHarnessLauncher();
      if (previous === undefined) delete process.env.COCALC_ACP_HARNESSES;
      else process.env.COCALC_ACP_HARNESSES = previous;
    }
  },
);

it.each([false, true])(
  "refreshes cold queued ACP context without replacing admitted choices (RPC=%s)",
  async (rpc) => {
    const source = claudeTurnRequest();
    source.runtime!.settings = { configOptions: [{ id: "model", value: "a" }] };
    if (rpc)
      source.chat!.agent_rpc_execution =
        rpcTurnRequest(undefined).chat!.agent_rpc_execution;
    // Admission happened before the preceding turn created its native session.
    const job = enqueueAcpJob(source);
    rows[0].agent_runtime = {
      ...source.runtime,
      settings: { configOptions: [{ id: "model", value: "b" }] },
    };
    rows[0].agent_session_id = sessionId;
    const admitted = decodeAcpJobRequest(job);
    const prepared =
      await acpTestInternals.prepareQueuedUserMessageForExecution({
        client: {} as Client,
        project_id: projectId,
        path: record.path,
        thread_id: record.thread_id,
        user_message_id: job.user_message_id,
        request: admitted,
      });
    expect(prepared.currentAgentSessionId).toBe(sessionId);
    expect(prepared.currentAgentConfig).toBeUndefined();
    expect(admitted).toMatchObject({
      runtime: source.runtime,
      harness_credential: source.harness_credential,
    });
    expect(decodeAcpJobRequest(job)).not.toHaveProperty("session_id");
  },
);

it("preserves the explicit reset marker instead of inferring old history", async () => {
  const source = claudeTurnRequest();
  rows[0].agent_runtime = source.runtime;
  rows[0].agent_session_id = "";
  rows[1].acp_thread_id = sessionId;
  const job = enqueueAcpJob(source);
  const prepare = () =>
    acpTestInternals.prepareQueuedUserMessageForExecution({
      client: {} as Client,
      project_id: projectId,
      path: record.path,
      thread_id: record.thread_id,
      user_message_id: job.user_message_id,
      request: decodeAcpJobRequest(job),
    });
  expect((await prepare()).currentAgentSessionId).toBe("");
  // A second queued unbound message follows the first post-reset turn, rather
  // than resetting it again or restoring the pre-reset history.
  rows[0].agent_session_id = "replacement-session";
  expect((await prepare()).currentAgentSessionId).toBe("replacement-session");
});

it.each(["", "replacement-session"])(
  "rejects late first-turn Claude answers after context changed to %j",
  async (currentSession) => {
    const source = claudeTurnRequest();
    rows[0].agent_runtime = source.runtime;
    rows[0].agent_session_id = currentSession;
    enqueueAcpJob(source);
    await expect(
      acpTestInternals.deliverAsyncAttentionAnswer({
        ...record,
        chat: { ...source.chat!, harness_session_id: "original-session" },
      }),
    ).rejects.toThrow("context was reset or replaced");
    expect(listPendingAcpSteers()).toHaveLength(0);
    expect(listQueuedAcpJobs()).toHaveLength(1); // Only the source job.
    expect(mockSteer).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
  },
);

it("does not guess a legacy first-turn question's session from current context", async () => {
  const source = claudeTurnRequest();
  rows[0].agent_runtime = source.runtime;
  rows[0].agent_session_id = "replacement-session";
  enqueueAcpJob(source);
  await expect(
    acpTestInternals.deliverAsyncAttentionAnswer({
      ...record,
      chat: source.chat!,
    }),
  ).rejects.toThrow("question's ACP context is unavailable");
  expect(listPendingAcpSteers()).toHaveLength(0);
});

it.each(["", "replacement-session"])(
  "rechecks durable Claude guidance at dispatch after context changed to %j",
  async (currentSession) => {
    const source = claudeTurnRequest();
    rows[0].agent_runtime = source.runtime;
    const request = { ...source, session_id: sessionId, chat: source.chat! };
    enqueueAcpSteer({ request, candidate_ids: [sessionId] });
    // The response was accepted before reset; it must neither inject into a
    // retained old client nor fall back to a new queued turn after reset.
    rows[0].agent_session_id = currentSession;
    const steer = jest.fn(async () => ({ state: "steered" }));
    const unregister = acpTestInternals.registerInterruptAgentForTests(
      "stale-claude",
      projectId,
      { steer } as any,
      true,
    );
    try {
      await acpTestInternals.processPendingAcpSteersOnce();
      expect(
        getAcpSteer({
          project_id: projectId,
          path: record.path,
          user_message_id: source.chat!.parent_message_id!,
        }),
      ).toMatchObject({
        state: "error",
        error: expect.stringContaining("context was reset or replaced"),
      });
      expect(steer).not.toHaveBeenCalled();
      expect(mockSteer).not.toHaveBeenCalled();
      expect(listQueuedAcpJobs()).toHaveLength(0);
    } finally {
      unregister();
    }
  },
);

it("does not route current Claude guidance through stale writer/lease aliases", async () => {
  const source = claudeTurnRequest();
  rows[0].agent_runtime = source.runtime;
  rows[0].agent_session_id = "current-session";
  jest.mocked(listRunningAcpTurnLeases).mockReturnValue([
    {
      project_id: projectId,
      path: record.path,
      thread_id: record.thread_id,
      session_id: "stale-session",
    } as any,
  ]);
  enqueueAcpSteer({
    request: { ...source, session_id: "current-session", chat: source.chat! },
    candidate_ids: ["stale-session"],
  });
  const steer = jest.fn(async (id) => ({
    state: id === record.thread_id ? "missing" : "steered",
    threadId: id,
  }));
  const unregister = acpTestInternals.registerInterruptAgentForTests(
    "alias-claude",
    projectId,
    { steer } as any,
    true,
  );
  try {
    await acpTestInternals.processPendingAcpSteersOnce();
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith("current-session", expect.anything());
    expect(mockSteer).not.toHaveBeenCalled();
  } finally {
    unregister();
  }
});

it("cancels a queued Claude answer if reset happens after steer fallback", async () => {
  const source = claudeTurnRequest();
  rows[0].agent_runtime = source.runtime;
  rows[0].agent_session_id = "";
  const job = startRunningTurn({ ...source, session_id: sessionId });
  await acpTestInternals.runQueuedAcpJob(job);
  expect(getAcpJobByOpId(job.op_id)).toMatchObject({
    state: "canceled",
    error: expect.stringContaining("context was reset or replaced"),
  });
  expect(rows[0].agent_session_id).toBe("");
  expect(mockSteer).not.toHaveBeenCalled();
});

it("steers an active turn and records the human answer as delivered", async () => {
  mockSteer.mockResolvedValue({ state: "steered", threadId: sessionId });
  expect(
    await acpTestInternals.deliverAsyncAttentionAnswer(record),
  ).toMatchObject({
    state: "steered",
  });
  expect(listQueuedAcpJobs()).toEqual([]);
  expect(mockSteer).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      account_id: accountId,
      session_id: sessionId,
      prompt: "Answer to the earlier Codex question:\n\nChoice: Go ahead",
      chat: expect.objectContaining({
        sender_id: "gpt-6-astra",
        send_mode: "immediate",
      }),
    }),
  );
  expect(rows.filter((row) => row.event === "chat")).toHaveLength(2);
  expect(rows[2]).toMatchObject({
    sender_id: accountId,
    parent_message_id: "original-assistant",
    history: [expect.objectContaining({ author_id: accountId })],
    acp_state: "sent",
    acp_send_mode: "immediate",
    acp_guidance_delivered_at_ms: expect.any(Number),
  });
  const calls = mockSteer.mock.calls.length;
  await acpTestInternals.deliverAsyncAttentionAnswer(record);
  expect(mockSteer).toHaveBeenCalledTimes(calls);
  expect(rows[2].parent_message_id).toBe("original-assistant");
});

it.each(["subscription", "auto", "account-api-key"])(
  "answers inherit the active credential rather than the thread's %s preference",
  async (paymentSource) => {
    rows[0].acp_config.paymentSource = paymentSource;
    rows[0].acp_config.credentialId = "a-different-next-turn-credential";
    const runningConfig = {
      model: "gpt-6-astra",
      sessionId,
      paymentSource: "subscription-credential" as const,
      credentialId: "credential-pinned-when-the-turn-started",
    };
    enqueueAcpJob({
      project_id: projectId,
      account_id: accountId,
      prompt: "Keep working and ask me a question",
      config: runningConfig,
      chat: {
        project_id: projectId,
        path: record.path,
        thread_id: record.thread_id,
        parent_message_id: "original-user",
        message_id: "original-assistant",
        message_date: "2026-09-05T07:51:32.212Z",
        sender_id: "gpt-6-astra",
      },
    });
    expect(
      claimNextQueuedAcpJobForThread({
        project_id: projectId,
        path: record.path,
        thread_id: record.thread_id,
      }),
    ).toBeDefined();
    mockSteer.mockImplementation(async (_id, request) => {
      // Match the app-server's invariant: live guidance must not change funding.
      if (
        request.config?.paymentSource !== runningConfig.paymentSource ||
        request.config?.credentialId !== runningConfig.credentialId
      ) {
        throw Error(
          "Send Immediately cannot change the active turn's credential",
        );
      }
      return { state: "steered", threadId: sessionId };
    });

    await expect(
      acpTestInternals.deliverAsyncAttentionAnswer(record),
    ).resolves.toMatchObject({ state: "steered" });
    expect(listQueuedAcpJobs()).toEqual([]);
    expect(rows[2]).toMatchObject({
      acp_state: "sent",
      acp_send_mode: "immediate",
      acp_guidance_delivered_at_ms: expect.any(Number),
    });
    expect(rows[0].acp_config.paymentSource).toBe(paymentSource);
    expect(rows[0].acp_config.credentialId).toBe(
      "a-different-next-turn-credential",
    );
  },
);

it.each(["missing", "not_steerable"])(
  "queues a correctly attributed turn when steering returns %s",
  async (state) => {
    mockSteer.mockResolvedValue({ state });
    expect(["queued", "running"]).toContain(
      (await acpTestInternals.deliverAsyncAttentionAnswer(record)).state,
    );
    const jobs = listQueuedAcpJobs();
    expect(jobs).toHaveLength(1);
    expect(decodeAcpJobRequest(jobs[0])).toMatchObject({
      account_id: accountId,
      chat: {
        sender_id: "gpt-6-astra",
        parent_message_id: rows[2].message_id,
        notify_on_turn_finish: false,
        completion_notification_enabled: false,
      },
    });
    expect(rows[2]).toMatchObject({ sender_id: accountId });
    const calls = mockSteer.mock.calls.length;
    mockSteer.mockResolvedValue({ state: "steered", threadId: sessionId });
    await acpTestInternals.deliverAsyncAttentionAnswer(record);
    expect(mockSteer).toHaveBeenCalledTimes(calls);
    expect(listQueuedAcpJobs()).toHaveLength(1);
    expect(rows[2].parent_message_id).toBe("original-assistant");
  },
);

it.each(["auto", "subscription", "subscription-credential"])(
  "preserves the admitted RPC subscription pin while refreshing %s preferences",
  async (paymentSource) => {
    setCodexCredentialAdmissionResolver(async () => ({
      source: "subscription",
      credentialId: "admitted-credential",
    }));
    const admitted = await pinCodexCredentialAtAdmission(
      rpcTurnRequest({
        paymentSource: "subscription",
        workingDirectory: "/old",
        sessionId: "01a01361-c4fe-7da1-b9f5-4c44a15a479b",
      }),
    );
    const job = startRunningTurn(admitted);
    rows[0].acp_config = {
      model: "gpt-6-astra",
      workingDirectory: "/new",
      sessionId,
      paymentSource,
      ...(paymentSource === "subscription-credential"
        ? { credentialId: "next-credential" }
        : {}),
    };
    const prepared =
      await acpTestInternals.prepareQueuedUserMessageForExecution({
        client: {} as Client,
        project_id: projectId,
        path: record.path,
        thread_id: record.thread_id,
        user_message_id: job.user_message_id,
        request: decodeAcpJobRequest(job),
      });
    expect(prepared.currentAgentConfig).toMatchObject({
      workingDirectory: "/new",
      sessionId,
      model: "gpt-6-astra",
      paymentSource: "subscription-credential",
      credentialId: "admitted-credential",
    });
    expect(prepared.currentAgentSessionId).toBe(sessionId);
    expect(decodeAcpJobRequest(job).config?.workingDirectory).toBe("/old");
    mockLiveRuntime(prepared.currentAgentConfig);
    await expect(
      acpTestInternals.deliverAsyncAttentionAnswer(record),
    ).resolves.toMatchObject({ state: "steered" });
    expect(listQueuedAcpJobs()).toEqual([]);
  },
);

it.each([
  undefined,
  "auto",
  "subscription",
  "account-api-key",
  "site-api-key",
] as const)(
  "preserves admitted non-pinned RPC funding %s instead of new thread funding",
  async (paymentSource) => {
    const job = startRunningTurn(rpcTurnRequest({ paymentSource }));
    rows[0].acp_config = {
      sessionId,
      workingDirectory: "/new",
      paymentSource: "subscription-credential",
      credentialId: "next-credential",
    };
    const prepared =
      await acpTestInternals.prepareQueuedUserMessageForExecution({
        client: {} as Client,
        project_id: projectId,
        path: record.path,
        thread_id: record.thread_id,
        user_message_id: job.user_message_id,
        request: decodeAcpJobRequest(job),
      });
    expect(prepared.currentAgentConfig?.paymentSource).toBe(paymentSource);
    expect(prepared.currentAgentConfig?.credentialId).toBeUndefined();
    expect(prepared.currentAgentConfig?.workingDirectory).toBe("/new");
    mockLiveRuntime(prepared.currentAgentConfig);
    await expect(
      acpTestInternals.deliverAsyncAttentionAnswer(record),
    ).resolves.toMatchObject({ state: "steered" });
    expect(listQueuedAcpJobs()).toEqual([]);
    expect(rows[0].acp_config.credentialId).toBe("next-credential");
  },
);

it.each(["missing", "not_steerable", "detached"])(
  "uses next-turn funding after %s delivery instead of the old live pin",
  async (state) => {
    const job = startRunningTurn(
      turnRequest({
        paymentSource: "subscription-credential",
        credentialId: "revoked-old-credential",
      }),
    );
    rows[0].acp_config.paymentSource = "subscription";
    const resolve = jest.fn(async ({ credential_id }) => {
      if (credential_id === "revoked-old-credential")
        throw Error("Old credential revoked");
      return { source: "subscription", credentialId: "next-credential" };
    });
    setCodexCredentialAdmissionResolver(resolve);
    mockSteer.mockResolvedValue({
      state: state === "detached" ? "missing" : state,
    });
    if (state === "detached") {
      jest.mocked(listRunningAcpTurnLeases).mockReturnValue([
        {
          project_id: projectId,
          path: record.path,
          thread_id: record.thread_id,
          session_id: sessionId,
          owner_instance_id: "other-worker",
        } as any,
      ]);
      await expect(
        acpTestInternals.deliverAsyncAttentionAnswer(record),
      ).resolves.toMatchObject({ state: "pending" });
      expect(resolve).not.toHaveBeenCalled();
      expect(
        decodeAcpSteerRequest(listPendingAcpSteers()[0]).config?.credentialId,
      ).toBe("revoked-old-credential");
      setAcpJobState({ op_id: job.op_id, state: "completed" });
      jest.mocked(listRunningAcpTurnLeases).mockReturnValue([]);
      await acpTestInternals.processPendingAcpSteersOnce();
    } else {
      await expect(
        acpTestInternals.deliverAsyncAttentionAnswer(record),
      ).resolves.toMatchObject({ state: "queued" });
    }
    expect(listQueuedAcpJobs()).toHaveLength(1);
    expect(decodeAcpJobRequest(listQueuedAcpJobs()[0]).config).toMatchObject({
      paymentSource: "subscription-credential",
      credentialId: "next-credential",
    });
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: accountId,
        preference: "subscription",
        credential_id: undefined,
      }),
    );
  },
);

it("does not bypass a different running principal when answering", async () => {
  startRunningTurn({ ...turnRequest({}), account_id: "another-account" });
  await expect(
    acpTestInternals.deliverAsyncAttentionAnswer(record),
  ).rejects.toThrow();
  expect(mockSteer).not.toHaveBeenCalled();
  expect(listQueuedAcpJobs()).toEqual([]);
});

it("keeps the runtime funding guard if the active credential changes before delivery", async () => {
  startRunningTurn(
    turnRequest({
      paymentSource: "subscription-credential",
      credentialId: "old",
    }),
  );
  mockLiveRuntime({
    paymentSource: "subscription-credential",
    credentialId: "new",
  });
  await expect(
    acpTestInternals.deliverAsyncAttentionAnswer(record),
  ).rejects.toThrow("cannot change the active turn's credential");
  expect(listQueuedAcpJobs()).toEqual([]);
});

it("forwards guidance to the detached owner instead of creating a follow-up job", async () => {
  mockSteer.mockResolvedValue({ state: "missing" });
  jest.mocked(listRunningAcpTurnLeases).mockReturnValue([
    {
      project_id: projectId,
      path: record.path,
      thread_id: record.thread_id,
      session_id: sessionId,
      owner_instance_id: "other-worker",
    } as any,
  ]);
  expect(
    await acpTestInternals.deliverAsyncAttentionAnswer(record),
  ).toMatchObject({ state: "pending" });
  expect(listQueuedAcpJobs()).toEqual([]);
  expect(listPendingAcpSteers()).toHaveLength(1);
  expect(decodeAcpSteerRequest(listPendingAcpSteers()[0]).chat).toMatchObject({
    sender_id: "gpt-6-astra",
    parent_message_id: rows[2].message_id,
  });
  expect(rows[2].acp_guidance_delivered_at_ms).toBeUndefined();
  await acpTestInternals.deliverAsyncAttentionAnswer(record);
  expect(listPendingAcpSteers()).toHaveLength(1);
  mockSteer.mockResolvedValue({ state: "steered", threadId: sessionId });
  await acpTestInternals.processPendingAcpSteersOnce();
  expect(listPendingAcpSteers()).toHaveLength(0);
  expect(rows[2].acp_guidance_delivered_at_ms).toEqual(expect.any(Number));
  await expect(
    acpTestInternals.deliverAsyncAttentionAnswer(record),
  ).resolves.toMatchObject({ state: "steered" });
});

it("retries a failed durable steer only through the explicit continue path", async () => {
  mockSteer.mockResolvedValue({ state: "missing" });
  jest.mocked(listRunningAcpTurnLeases).mockReturnValue([
    {
      project_id: projectId,
      path: record.path,
      thread_id: record.thread_id,
      session_id: sessionId,
      owner_instance_id: "other-worker",
    } as any,
  ]);
  await acpTestInternals.deliverAsyncAttentionAnswer(record);
  const steer = getAcpSteer({
    project_id: projectId,
    path: record.path,
    user_message_id: rows[2].message_id,
  })!;
  const claimToken = claimAcpSteer({ id: steer.id });
  expect(claimToken).toEqual(expect.any(String));
  markAcpSteerError({
    id: steer.id,
    claim_token: claimToken!,
    error: "worker stopped",
  });
  await expect(
    acpTestInternals.deliverAsyncAttentionAnswer(record),
  ).rejects.toThrow("worker stopped");

  jest.mocked(listRunningAcpTurnLeases).mockReturnValue([]);
  mockSteer.mockResolvedValue({ state: "steered", threadId: sessionId });
  await expect(
    acpTestInternals.deliverAsyncAttentionAnswer(record, { retryFailed: true }),
  ).resolves.toMatchObject({ state: "steered" });
  expect(rows[2].acp_guidance_delivered_at_ms).toEqual(expect.any(Number));
});

it("uses the generic agent identity if the thread has no model", async () => {
  delete rows[0].agent_model;
  delete rows[0].acp_config.model;
  mockSteer.mockResolvedValue({ state: "missing" });
  await acpTestInternals.deliverAsyncAttentionAnswer(record);
  expect(decodeAcpJobRequest(listQueuedAcpJobs()[0]).chat?.sender_id).toBe(
    "openai-codex-agent",
  );
});

describe("Claude network worker delivery", () => {
  it.each([
    ["direct", "allowed"],
    ["direct", "network revoked"],
    ["direct", "subscription revoked"],
    ["durable", "allowed"],
    ["durable", "network revoked"],
    ["durable", "subscription revoked"],
  ])(
    "%s guidance checks %s before adapter injection",
    async (path, outcome) => {
      const previous = process.env.COCALC_ACP_HARNESSES;
      process.env.COCALC_ACP_HARNESSES = "1";
      setHarnessLauncher(async () => {
        throw Error("guidance must not launch a second harness");
      });
      const source = claudeTurnRequest();
      rows[0].agent_runtime = source.runtime;
      rows[0].agent_session_id = sessionId;
      startRunningTurn(source);
      const request: AcpSteerRequest = {
        ...rpcTurnRequest(undefined),
        runtime: source.runtime,
        session_id: sessionId,
        chat: {
          ...rpcTurnRequest(undefined).chat!,
          parent_message_id: "network-guidance",
          message_id: "network-assistant",
        },
      };
      request.chat.agent_rpc_execution!.guidance = true;
      request.chat.agent_rpc_execution!.configured_delivery = "live";
      request.chat.agent_rpc_execution!.source.project_id =
        "44444444-4444-4444-8444-444444444444";
      const originalAuthorize = hubApi.agent.authorizeRpcExecution;
      const authorize = jest.fn(async () => {
        if (outcome === "network revoked") throw Error(outcome);
        return {} as any;
      });
      hubApi.agent.authorizeRpcExecution = authorize;
      const validateAuthority = jest.fn(async () => {
        if (outcome === "subscription revoked") throw Error(outcome);
      });
      const client = {
        sessionId,
        running: true,
        supportsSteering: true,
        steer: jest.fn(async () => "injected"),
      };
      const runtime = {
        binding: {
          accountId,
          projectId,
          profile: source.runtime!.profile,
          credential: source.harness_credential,
        },
        conversation: { path: record.path, threadId: record.thread_id },
        busy: true,
        client,
        validateAuthority,
      };
      const steer = jest.fn((id, incoming) =>
        HarnessAgent.prototype.steer.call(runtime as any, id, incoming),
      );
      const unregister = acpTestInternals.registerInterruptAgentForTests(
        "claude-network",
        projectId,
        { steer } as any,
        true,
      );
      try {
        if (path === "direct") {
          const delivery = acpTestInternals.handleAcpSteerRequest(request);
          if (outcome === "allowed")
            await expect(delivery).resolves.toMatchObject({ state: "steered" });
          else await expect(delivery).rejects.toThrow(outcome);
        } else {
          // Admission happened before the queued delivery authorization check.
          enqueueAcpSteer({
            request: await pinCodexCredentialAtAdmission(request),
            candidate_ids: [sessionId],
          });
          await acpTestInternals.processPendingAcpSteersOnce();
          expect(
            getAcpSteer({
              project_id: projectId,
              path: record.path,
              user_message_id: "network-guidance",
            }),
          ).toMatchObject({
            state: outcome === "allowed" ? "handled" : "error",
          });
        }
        expect(authorize).toHaveBeenCalledWith({
          account_id: accountId,
          authorization: request.chat.agent_rpc_execution,
        });
        expect(mockSteer).not.toHaveBeenCalled();
        expect(listQueuedAcpJobs()).toEqual([]);
        if (outcome === "allowed") {
          expect(client.steer).toHaveBeenCalledTimes(1);
          expect(validateAuthority).toHaveBeenCalledWith(runtime.binding);
          expect(
            steer.mock.calls.find(([id]) => id === sessionId)?.[1],
          ).toMatchObject({
            harness_credential: source.harness_credential,
            account_id: accountId,
          });
        } else {
          expect(client.steer).not.toHaveBeenCalled();
          if (outcome === "network revoked")
            expect(steer).not.toHaveBeenCalled();
        }
      } finally {
        unregister();
        if (originalAuthorize === undefined)
          delete hubApi.agent.authorizeRpcExecution;
        else hubApi.agent.authorizeRpcExecution = originalAuthorize;
        setHarnessLauncher();
        if (previous === undefined) delete process.env.COCALC_ACP_HARNESSES;
        else process.env.COCALC_ACP_HARNESSES = previous;
      }
    },
  );
});

describe("agent RPC live guidance funding", () => {
  const liveConfig: AcpRequest["config"] = {
    paymentSource: "subscription-credential",
    credentialId: "actual-live-credential",
  };
  const nextConfig: AcpRequest["config"] = {
    model: "gpt-6-astra",
    sessionId,
    paymentSource: "subscription-credential",
    credentialId: "next-turn-credential",
  };

  function guidanceRequest(config = nextConfig): AcpSteerRequest {
    const request = rpcTurnRequest({ ...config });
    request.chat!.agent_rpc_execution!.guidance = true;
    request.chat!.agent_rpc_execution!.configured_delivery = "live";
    request.chat!.send_mode = "immediate";
    request.chat!.parent_message_id = "rpc-guidance";
    request.chat!.message_id = "rpc-assistant";
    rows.push({
      event: "chat",
      thread_id: record.thread_id,
      message_id: "rpc-guidance",
      sender_id: accountId,
      date: "2026-09-05T13:56:15.277Z",
    });
    return { ...request, session_id: sessionId, chat: request.chat! };
  }

  function storedSteer(request: AcpSteerRequest) {
    return getAcpSteer({
      project_id: projectId,
      path: request.chat.path,
      user_message_id: request.chat.parent_message_id!,
    })!;
  }

  it.each([
    ["direct", "network generation changed"],
    ["direct", "account generation changed"],
    ["direct", "network membership revoked"],
    ["durable", "network generation changed"],
    ["durable", "account generation changed"],
    ["durable", "network membership revoked"],
  ])("rejects %s native guidance after %s", async (delivery, reason) => {
    const request = guidanceRequest();
    startRunningTurn(turnRequest(liveConfig));
    if (delivery === "durable") {
      mockLiveRuntime(liveConfig).running.clear();
      jest.mocked(listRunningAcpTurnLeases).mockReturnValue([
        {
          project_id: projectId,
          path: record.path,
          thread_id: record.thread_id,
          session_id: sessionId,
          owner_instance_id: "other-worker",
        } as any,
      ]);
      await acpTestInternals.handleAcpSteerRequest(request);
      expect(storedSteer(request).state).toBe("pending");
    }
    // Revoke after admission/forwarding but before the owner injects guidance.
    mockAuthorizeRpcExecution.mockRejectedValue(new Error(reason));
    const runtime = mockLiveRuntime(liveConfig);
    const send = runtime.running.get(sessionId)!.client.request;
    mockSteer.mockClear();
    if (delivery === "direct") {
      await expect(
        acpTestInternals.handleAcpSteerRequest(request),
      ).rejects.toThrow(reason);
    } else {
      await acpTestInternals.processPendingAcpSteersOnce();
      expect(storedSteer(request)).toMatchObject({
        state: "error",
        error: reason,
      });
      const attempts = mockAuthorizeRpcExecution.mock.calls.length;
      await acpTestInternals.processPendingAcpSteersOnce();
      expect(mockAuthorizeRpcExecution).toHaveBeenCalledTimes(attempts);
    }
    expect(mockAuthorizeRpcExecution).toHaveBeenLastCalledWith({
      account_id: accountId,
      authorization: request.chat.agent_rpc_execution,
    });
    expect(mockSteer).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(listQueuedAcpJobs()).toEqual([]);
    expect(rows[2].acp_guidance_delivered_at_ms).toBeUndefined();
  });

  it.each(["direct", "durable"])(
    "keeps %s human guidance independent of Agent Network authorization",
    async (delivery) => {
      const request = guidanceRequest(liveConfig);
      delete request.chat.agent_rpc_execution;
      mockAuthorizeRpcExecution.mockRejectedValue(
        new Error("not a network turn"),
      );
      const runtime = mockLiveRuntime(liveConfig);
      if (delivery === "direct") {
        await expect(
          acpTestInternals.handleAcpSteerRequest(request),
        ).resolves.toMatchObject({ state: "steered" });
      } else {
        enqueueAcpSteer({ request });
        await acpTestInternals.processPendingAcpSteersOnce();
        expect(storedSteer(request).state).toBe("handled");
      }
      expect(mockAuthorizeRpcExecution).not.toHaveBeenCalled();
      expect(
        runtime.running.get(sessionId)!.client.request,
      ).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["direct", "durable"])(
    "rejects %s legacy agent guidance before native injection",
    async (delivery) => {
      const request = guidanceRequest(liveConfig);
      delete request.chat.agent_rpc_execution;
      request.chat.agent_delivery_id = "retired-delivery";
      const runtime = mockLiveRuntime(liveConfig);
      if (delivery === "direct") {
        await expect(
          acpTestInternals.handleAcpSteerRequest(request),
        ).rejects.toThrow("Legacy agent delivery is retired");
      } else {
        enqueueAcpSteer({ request });
        await acpTestInternals.processPendingAcpSteersOnce();
        expect(storedSteer(request)).toMatchObject({
          state: "error",
          error: expect.stringContaining("Legacy agent delivery is retired"),
        });
      }
      expect(mockAuthorizeRpcExecution).not.toHaveBeenCalled();
      expect(
        runtime.running.get(sessionId)!.client.request,
      ).not.toHaveBeenCalled();
      expect(listQueuedAcpJobs()).toEqual([]);
    },
  );

  it.each(["auto", "subscription", "subscription-credential"] as const)(
    "inherits live funding instead of the next-turn %s config",
    async (paymentSource) => {
      // Durable admission metadata may lag the actual active runtime.
      startRunningTurn(
        turnRequest({ ...liveConfig, credentialId: "older-admission-pin" }),
      );
      const runtime = mockLiveRuntime(liveConfig);
      const running = runtime.running.get(sessionId)!;
      const request = guidanceRequest({ ...nextConfig, paymentSource });
      const original = JSON.stringify(request);
      Object.freeze(request.config);
      Object.freeze(request);

      await expect(
        acpTestInternals.handleAcpSteerRequest(request),
      ).resolves.toMatchObject({ state: "steered" });
      expect(running.client.request).toHaveBeenCalledTimes(1);
      expect(running.client.request).toHaveBeenCalledWith("turn/steer", {
        threadId: sessionId,
        expectedTurnId: "live-turn",
        input: expect.any(Array),
      });
      const delivered = mockSteer.mock.calls.find(
        ([id]) => id === sessionId,
      )![1];
      expect(delivered).not.toBe(request);
      expect(delivered.config).toEqual({
        ...request.config,
        paymentSource: undefined,
        credentialId: undefined,
      });
      expect(delivered.account_id).toBe(accountId);
      expect(delivered.chat).toBe(request.chat);
      expect(JSON.stringify(request)).toBe(original);
      expect(running.credentialId).toBe(liveConfig.credentialId);
      expect(rows[2].acp_guidance_delivered_at_ms).toEqual(expect.any(Number));
      expect(listQueuedAcpJobs()).toEqual([]);
    },
  );

  it("inherits the live credential at detached poll time without rewriting the durable request", async () => {
    const request = guidanceRequest();
    mockLiveRuntime(liveConfig).running.clear();
    jest.mocked(listRunningAcpTurnLeases).mockReturnValue([
      {
        project_id: projectId,
        path: record.path,
        thread_id: record.thread_id,
        session_id: sessionId,
        owner_instance_id: "other-worker",
      } as any,
    ]);
    await acpTestInternals.handleAcpSteerRequest(request);
    const pending = storedSteer(request);
    expect(pending.state).toBe("pending");
    expect(decodeAcpSteerRequest(pending)).toEqual(request);
    expect(rows[2].acp_guidance_delivered_at_ms).toBeUndefined();

    const runtime = mockLiveRuntime({
      ...liveConfig,
      credentialId: "credential-changed-before-poll",
    });
    const running = runtime.running.get(sessionId)!;
    await acpTestInternals.processPendingAcpSteersOnce();
    expect(storedSteer(request)).toMatchObject({
      state: "handled",
      request_json: pending.request_json,
    });
    expect(rows[2].acp_guidance_delivered_at_ms).toEqual(expect.any(Number));
    expect(listQueuedAcpJobs()).toEqual([]);
    await acpTestInternals.processPendingAcpSteersOnce();
    expect(running.client.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["direct", "missing"],
    ["direct", "not_steerable"],
    ["durable", "missing"],
    ["durable", "not_steerable"],
  ])(
    "retains next-turn funding for %s %s fallback",
    async (delivery, state) => {
      const request = guidanceRequest();
      const original = JSON.stringify(request);
      const runtime = mockLiveRuntime(liveConfig);
      if (state === "missing") runtime.running.clear();
      else {
        runtime.running
          .get(sessionId)!
          .client.request.mockRejectedValue(
            new Error("cannot steer a review turn"),
          );
      }
      const resolve = jest.fn(async () => ({
        source: "subscription",
        credentialId: nextConfig.credentialId,
      }));
      setCodexCredentialAdmissionResolver(resolve);

      if (delivery === "durable") {
        const pending = enqueueAcpSteer({ request });
        await acpTestInternals.processPendingAcpSteersOnce();
        expect(storedSteer(request)).toMatchObject({
          state: "handled",
          request_json: pending.request_json,
        });
      } else {
        expect(["queued", "running"]).toContain(
          (await acpTestInternals.handleAcpSteerRequest(request)).state,
        );
      }
      expect(listQueuedAcpJobs()).toHaveLength(1);
      expect(decodeAcpJobRequest(listQueuedAcpJobs()[0]).config).toEqual(
        nextConfig,
      );
      expect(resolve).toHaveBeenCalledWith({
        account_id: accountId,
        project_id: projectId,
        preference: "subscription",
        credential_id: nextConfig.credentialId,
      });
      expect(JSON.stringify(request)).toBe(original);
      expect(rows[2].acp_guidance_delivered_at_ms).toBeUndefined();
    },
  );

  it.each(["job", "runtime"])(
    "rejects guidance from a different %s principal",
    async (boundary) => {
      const request = guidanceRequest();
      const runtime = mockLiveRuntime(liveConfig);
      const running = runtime.running.get(sessionId)!;
      if (boundary === "job") {
        startRunningTurn({ ...turnRequest(liveConfig), account_id: "other" });
      } else {
        running.executionAccountId = "other";
      }
      await expect(
        acpTestInternals.handleAcpSteerRequest(request),
      ).rejects.toMatchObject({ code: "principal_mismatch" });
      expect(running.client.request).not.toHaveBeenCalled();
      if (boundary === "job") expect(mockSteer).not.toHaveBeenCalled();
      expect(listQueuedAcpJobs()).toEqual([]);
      expect(listPendingAcpSteers()).toEqual([]);
    },
  );

  it.each(["human", "non-guidance RPC"])(
    "keeps explicit credential mismatch rejection for %s Send Immediately",
    async (kind) => {
      const request = guidanceRequest();
      if (kind === "human") delete request.chat.agent_rpc_execution;
      else request.chat.agent_rpc_execution!.guidance = false;
      const runtime = mockLiveRuntime(liveConfig);
      await expect(
        acpTestInternals.handleAcpSteerRequest(request),
      ).rejects.toThrow("cannot change the active turn's credential");
      expect(
        runtime.running.get(sessionId)!.client.request,
      ).not.toHaveBeenCalled();
      expect(mockSteer.mock.calls.every(([, value]) => value === request)).toBe(
        true,
      );
      expect(listQueuedAcpJobs()).toEqual([]);
    },
  );

  it("does not retry or queue after an uncertain durable delivery error", async () => {
    const request = guidanceRequest();
    const runtime = mockLiveRuntime(liveConfig);
    const send = runtime.running.get(sessionId)!.client.request;
    send.mockRejectedValue(new Error("transport disconnected after send"));
    enqueueAcpSteer({ request });
    await acpTestInternals.processPendingAcpSteersOnce();
    expect(storedSteer(request)).toMatchObject({
      state: "error",
      error: "transport disconnected after send",
    });
    await acpTestInternals.processPendingAcpSteersOnce();
    expect(send).toHaveBeenCalledTimes(1);
    expect(listQueuedAcpJobs()).toEqual([]);
    expect(rows[2].acp_guidance_delivered_at_ms).toBeUndefined();
  });
});
