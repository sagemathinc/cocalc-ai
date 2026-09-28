import type { Client } from "@cocalc/conat/core/client";
import { acquireChatSyncDB } from "@cocalc/chat/server";
import {
  acpTestInternals,
  configureAcpDetachedWorkerRunning,
  disposeAcpAgents,
} from "../index";
import { createCodexAttentionHandler } from "../codex-attention";
import { buildAttentionResponseProjection } from "../attention-response-projection";
import {
  getAcpAttention,
  markAcpSyncAttentionStale,
  upsertAcpAttention,
} from "../../sqlite/acp-attention";
import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import { listQueuedAcpJobs } from "../../sqlite/acp-jobs";

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
const ownerDate = "2026-09-05T07:51:32.212Z";
const client = { sync: { akv: () => ({}) } } as unknown as Client;
let rows: any[];
let saved: any[];
let save: jest.Mock;
let record: ReturnType<typeof upsertAcpAttention>;

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
  acpTestInternals.initializeAcpRuntime(client);
  rows = [
    {
      event: "chat",
      message_id: "assistant-1",
      thread_id: "thread-1",
      date: ownerDate,
      sender_id: "gpt-6-astra",
    },
  ];
  saved = [];
  save = jest.fn(async () => {
    saved = JSON.parse(JSON.stringify(rows));
  });
  const matches = (row: any, where: any) =>
    Object.entries(where ?? {}).every(([key, value]) =>
      key === "date"
        ? new Date(row[key]).valueOf() === new Date(value as any).valueOf()
        : row[key] === value,
    );
  jest.mocked(acquireChatSyncDB).mockResolvedValue({
    isReady: () => true,
    get: (where: any) => rows.filter((row) => matches(row, where)),
    get_one: (where: any) => rows.find((row) => matches(row, where)),
    set: (value: any) => {
      // Model the real chat primary keys, not just message_id.
      const existing = rows.find((row) =>
        matches(
          row,
          Object.fromEntries(
            ["event", "date", "sender_id", "message_id", "thread_id"].map(
              (key) => [key, value[key]],
            ),
          ),
        ),
      );
      if (existing) Object.assign(existing, value);
      else rows.push(value);
    },
    commit() {},
    save,
    versions: () => [],
  } as any);
  record = upsertAcpAttention({
    project_id: projectId,
    account_id: accountId,
    path: "agent.chat",
    thread_id: "thread-1",
    turn_id: "turn-1",
    source_kind: "codex_sync_question",
    source_id: "thread-1:turn-1:request-1",
    attention_kind: "question",
    is_blocking: true,
    title: "Choose a region",
    questions: [
      { id: "region", header: "Region", question: "Where should this run?" },
    ],
    chat: {
      project_id: projectId,
      path: "agent.chat",
      thread_id: "thread-1",
      message_id: "assistant-1",
      message_date: ownerDate,
      sender_id: "gpt-6-astra",
    },
  });
});

afterEach(async () => {
  await disposeAcpAgents();
});

function respond(responseId = "response-1", answer = "EU") {
  return acpTestInternals.handleAcpAttentionRequest({
    action: "respond",
    project_id: projectId,
    account_id: accountId,
    attention_id: record.attention_id,
    response_id: responseId,
    answers: { region: [answer] },
  });
}

it("saves canonical sync Q&A at submission time and restores it without attention drafts or a new turn", async () => {
  const result = await respond();
  expect(result.ok).toBe(true);
  expect(listQueuedAcpJobs()).toEqual([]);
  expect(saved).toHaveLength(2);
  const projected = saved[1];
  expect(projected).toMatchObject({
    parent_message_id: "assistant-1",
    post_only: true,
    generating: false,
    date: new Date(result.record!.response_submitted_at!).toISOString(),
    acp_attention_response: {
      attention_id: record.attention_id,
      response_id: "response-1",
    },
  });
  expect(projected.history[0]).toMatchObject({
    date: projected.date,
    content:
      "Response to agent questions:\n\nRegion: Where should this run?\nEU",
  });
  expect(projected.acp_guidance_delivered_at_ms).toBeUndefined();
  rows = JSON.parse(JSON.stringify(saved)); // Reopen from durable chat, no local draft.
  await respond();
  await respond("another-tab", "US");
  expect(saved).toHaveLength(2);
  expect(saved[1]).toEqual(projected);
});

it("updates receipt only on confirmed runtime acceptance, preserving original date and edited history", async () => {
  await respond();
  const originalDate = rows[1].date;
  rows[1].history.unshift({
    author_id: accountId,
    content: "User annotation",
    date: "2026-10-01T00:00:00.000Z",
  });
  const history = JSON.parse(JSON.stringify(rows[1].history));
  const onResolved = jest.fn(
    acpTestInternals.persistAttentionResponseProjection,
  );
  const handler = createCodexAttentionHandler(client, {
    onSyncResponseResolved: onResolved,
  });
  handler.serverRequestResolved!({
    requestId: "request-1",
    context: {
      projectId,
      accountId,
      threadId: "thread-1",
      turnId: "turn-1",
      chat: record.chat,
      stream: async () => {},
    },
  });
  expect(onResolved).toHaveBeenCalledTimes(1);
  await onResolved.mock.results[0].value;
  expect(saved).toHaveLength(2);
  expect(saved[1].date).toBe(originalDate);
  expect(saved[1].history).toEqual(history);
  expect(saved[1].acp_guidance_delivered_at_ms).toBeGreaterThan(0);
});

it("promotes a saved sync answer to a dispatchable queued continuation without replacing its history", async () => {
  const originalDetached = process.env.COCALC_LITE_ACP_DETACHED_WORKER;
  process.env.COCALC_LITE_ACP_DETACHED_WORKER = "1";
  configureAcpDetachedWorkerRunning(jest.fn(async () => undefined) as any);
  mockSteer.mockResolvedValue({ state: "not_steerable" });
  try {
    await respond();
    expect(saved[1].post_only).toBe(true);
    rows[1].history.unshift({
      author_id: accountId,
      content: "An annotation to preserve",
      date: new Date().toISOString(),
    });
    const original = JSON.parse(JSON.stringify(rows[1]));
    markAcpSyncAttentionStale({
      project_id: projectId,
      thread_id: record.thread_id,
      turn_id: record.turn_id,
      reason: "Codex runtime closed before the request was resolved",
    });
    expect(getAcpAttention(record.attention_id)?.state).toBe("stale");

    const continued = await acpTestInternals.handleAcpAttentionRequest({
      action: "continue",
      project_id: projectId,
      account_id: accountId,
      attention_id: record.attention_id,
    });
    expect(continued.error).toBeUndefined();
    expect(continued).toMatchObject({ ok: true, state: "answered" });
    expect(listQueuedAcpJobs()).toHaveLength(1);
    expect(listQueuedAcpJobs()[0].user_message_id).toBe(original.message_id);
    const answer = saved.find((row) => row.message_id === original.message_id);
    expect(answer).toMatchObject({
      ...original,
      post_only: false,
    });
    expect(answer.acp_guidance_delivered_at_ms).toBeUndefined();
    expect(
      saved.filter((row) => row.message_id === original.message_id),
    ).toHaveLength(1);

    // Reopen and refresh attention history: projection repair must not turn
    // this queued message back into a post-only row and hide its controls.
    rows = JSON.parse(JSON.stringify(saved));
    await acpTestInternals.handleAcpAttentionRequest({
      action: "list",
      project_id: projectId,
      account_id: accountId,
      path: record.path,
      state: "all",
    });
    expect(
      saved.find((row) => row.message_id === original.message_id),
    ).toMatchObject({
      ...original,
      post_only: false,
    });
    expect(listQueuedAcpJobs()).toHaveLength(1);
  } finally {
    configureAcpDetachedWorkerRunning(undefined);
    if (originalDetached === undefined)
      delete process.env.COCALC_LITE_ACP_DETACHED_WORKER;
    else process.env.COCALC_LITE_ACP_DETACHED_WORKER = originalDetached;
  }
});

it.each(["Codex", "ACP"])(
  "projects an explicitly accepted %s sync response as received",
  async (runtime) => {
    await respond();
    const stored = getAcpAttention(record.attention_id)!;
    const projection = buildAttentionResponseProjection({
      ...stored,
      state: "answered",
      resolution_reason: `${runtime} accepted the response`,
      resolved_at: 12345,
    });
    expect(projection?.acp_guidance_delivered_at_ms).toBe(12345);
    expect(projection?.post_only).toBe(true);
  },
);

it("never interprets an async answered/queued state as model receipt", async () => {
  await respond();
  const stored = getAcpAttention(record.attention_id)!;
  for (const override of [
    {
      source_kind: "codex_async_question" as const,
      state: "answered" as const,
    },
    { state: "answered" as const, resolution_reason: "Queued for Codex" },
    {
      state: "answered" as const,
      dispatch_as_async: true,
      resolution_reason: "Codex accepted the response",
    },
    {
      state: "answered" as const,
      dispatch_as_async: true,
      resolution_reason: "ACP accepted the response",
    },
  ]) {
    expect(
      buildAttentionResponseProjection({ ...stored, ...override })
        ?.acp_guidance_delivered_at_ms,
    ).toBeUndefined();
  }
});

it("reports projection failure honestly and repairs from the canonical saved answer on retry", async () => {
  save.mockRejectedValueOnce(new Error("storage unavailable"));
  const failed = await respond();
  expect(failed).toMatchObject({
    ok: false,
    record: { response_submitted_at: expect.any(Number) },
  });
  rows = rows.slice(0, 1); // Failed chat save did not survive reopen.
  const retried = await respond("response-1", "Changed draft");
  expect(retried.ok).toBe(true);
  expect(saved).toHaveLength(2);
  expect(saved[1].history[0].content).toContain("\nEU");
  expect(saved[1].history[0].content).not.toContain("Changed draft");
});

it("repairs a missing projection when authenticated attention history is listed", async () => {
  await respond();
  rows = rows.slice(0, 1);
  await acpTestInternals.handleAcpAttentionRequest({
    action: "list",
    project_id: projectId,
    account_id: accountId,
    path: "agent.chat",
    state: "all",
  });
  expect(saved).toHaveLength(2);
  expect(saved[1].history[0].content).toContain("Where should this run?\nEU");
});

it("does not project another account's response", async () => {
  expect(
    await acpTestInternals.handleAcpAttentionRequest({
      action: "respond",
      project_id: projectId,
      account_id: "other-account",
      attention_id: record.attention_id,
      response_id: "unauthorized",
      answers: { region: ["US"] },
    }),
  ).toMatchObject({ ok: false, state: "missing" });
  expect(save).not.toHaveBeenCalled();
});
