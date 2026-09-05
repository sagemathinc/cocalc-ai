import type { Client } from "@cocalc/conat/core/client";
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
import { decodeAcpJobRequest, listQueuedAcpJobs } from "../../sqlite/acp-jobs";
import { listRunningAcpTurnLeases } from "../../sqlite/acp-turns";
import {
  decodeAcpSteerRequest,
  listPendingAcpSteers,
} from "../../sqlite/acp-steers";
import type { AcpAttentionStoredRecord } from "../../sqlite/acp-attention";

const mockSteer = jest.fn();
jest.mock("@cocalc/ai/acp", () => ({
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
    await acpTestInternals.deliverAsyncAttentionAnswer(record);
    expect(listQueuedAcpJobs()).toHaveLength(1);
    expect(rows[2].parent_message_id).toBe("original-assistant");
  },
);

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
  ).toMatchObject({ state: "steered" });
  expect(listQueuedAcpJobs()).toEqual([]);
  expect(listPendingAcpSteers()).toHaveLength(1);
  expect(decodeAcpSteerRequest(listPendingAcpSteers()[0]).chat).toMatchObject({
    sender_id: "gpt-6-astra",
    parent_message_id: rows[2].message_id,
  });
  expect(rows[2].acp_guidance_delivered_at_ms).toBeUndefined();
  await acpTestInternals.deliverAsyncAttentionAnswer(record);
  expect(listPendingAcpSteers()).toHaveLength(1);
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
