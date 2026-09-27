import type { Client } from "@cocalc/conat/core/client";
import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import { acquireChatSyncDB } from "@cocalc/chat/server";
import {
  acpTestInternals,
  configureAcpDetachedWorkerRunning,
  disposeAcpAgents,
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
  listQueuedAcpJobs,
  setAcpJobState,
} from "../../sqlite/acp-jobs";
import { listRunningAcpTurnLeases } from "../../sqlite/acp-turns";
import {
  claimAcpSteer,
  decodeAcpSteerRequest,
  getAcpSteer,
  listPendingAcpSteers,
  markAcpSteerError,
} from "../../sqlite/acp-steers";
import type { AcpAttentionStoredRecord } from "../../sqlite/acp-attention";
import {
  pinCodexCredentialAtAdmission,
  setCodexCredentialAdmissionResolver,
} from "../codex-credential-admission";

const mockSteer = jest.fn();
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
}

beforeAll(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
});

afterAll(() => closeAcpDatabase());

beforeEach(() => {
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
  setCodexCredentialAdmissionResolver();
  await disposeAcpAgents();
  configureAcpDetachedWorkerRunning(undefined);
  if (originalDetached === undefined)
    delete process.env.COCALC_LITE_ACP_DETACHED_WORKER;
  else process.env.COCALC_LITE_ACP_DETACHED_WORKER = originalDetached;
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
