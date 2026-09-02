import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { DEFAULT_SITE_FUNDED_CODEX_POLICY } from "@cocalc/util/ai/site-funded-codex";
const getCodexSiteKeyGovernorMock: jest.Mock<any, []> = jest.fn(() => null);
const loggerMock = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock("../codex-site-key-governor", () => ({
  getCodexSiteKeyGovernor: () => getCodexSiteKeyGovernorMock(),
  setCodexSiteKeyGovernor: jest.fn(),
}));

jest.mock("@cocalc/backend/logger", () => () => loggerMock);

import {
  CodexAppServerAgent,
  forkCodexAppServerSession,
  getCodexAppServerAccountStatus,
  setCodexProjectSpawner,
} from "..";

class FakeCodexAppServerProc extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly stdin = new PassThrough();
  public exitCode: number | null = null;
  public killed = false;
  private inputBuffer = "";

  constructor(
    private readonly onMessage: (
      proc: FakeCodexAppServerProc,
      message: any,
    ) => void,
  ) {
    super();
    this.stdin.on("data", (chunk) => {
      this.inputBuffer += chunk.toString("utf8");
      while (true) {
        const newline = this.inputBuffer.indexOf("\n");
        if (newline === -1) break;
        const line = this.inputBuffer.slice(0, newline);
        this.inputBuffer = this.inputBuffer.slice(newline + 1);
        if (!line.trim()) continue;
        this.onMessage(this, JSON.parse(line));
      }
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode != null) return true;
    this.killed = true;
    this.exitCode = signal === "SIGKILL" ? 137 : 0;
    setImmediate(() => this.emit("exit", this.exitCode, signal));
    return true;
  }

  sendResponse(id: number, result: any): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  sendError(id: number, message: string): void {
    this.stdout.write(`${JSON.stringify({ id, error: { message } })}\n`);
  }

  sendNotification(method: string, params: any): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  sendRequest(id: number, method: string, params: any): void {
    this.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
  }
}

function createCodexGoalsDb(codexHome: string): string {
  mkdirSync(codexHome, { recursive: true });
  const dbPath = path.join(codexHome, "goals_1.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY NOT NULL,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'active',
        'paused',
        'blocked',
        'usage_limited',
        'budget_limited',
        'complete'
      )),
      token_budget INTEGER,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      time_used_seconds INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `);
  db.prepare(
    `INSERT INTO thread_goals(
      thread_id,
      goal_id,
      objective,
      status,
      token_budget,
      tokens_used,
      time_used_seconds,
      created_at_ms,
      updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "thr-old-goal",
    "goal-1",
    "Old hidden objective",
    "active",
    null,
    10,
    5,
    1,
    2,
  );
  db.close();
  return dbPath;
}

function countCodexGoals(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM thread_goals")
      .get() as { count?: number };
    return Number(row?.count ?? 0);
  } finally {
    db.close();
  }
}

describe("CodexAppServerAgent", () => {
  const originalCompactRetryLimit =
    process.env.COCALC_CODEX_REMOTE_COMPACT_MAX_RETRIES;
  const originalCompactRetryDelay =
    process.env.COCALC_CODEX_REMOTE_COMPACT_RETRY_DELAY_MS;
  const originalTimeoutRetryLimit =
    process.env.COCALC_CODEX_TIMEOUT_MAX_RETRIES;
  const originalTimeoutRetryDelay =
    process.env.COCALC_CODEX_TIMEOUT_RETRY_DELAY_MS;
  const originalStreamDisconnectRetryLimit =
    process.env.COCALC_CODEX_STREAM_DISCONNECT_MAX_RETRIES;
  const originalStreamDisconnectRetryDelay =
    process.env.COCALC_CODEX_STREAM_DISCONNECT_RETRY_DELAY_MS;
  const originalTurnReconcileFailureLimit =
    process.env.COCALC_CODEX_TURN_RECONCILE_FAILURE_LIMIT;
  const originalTurnNotificationIdleTimeout =
    process.env.COCALC_CODEX_TURN_NOTIFICATION_IDLE_TIMEOUT_MS;

  afterEach(async () => {
    setCodexProjectSpawner(null);
    getCodexSiteKeyGovernorMock.mockReset();
    getCodexSiteKeyGovernorMock.mockReturnValue(null);
    loggerMock.debug.mockReset();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
    loggerMock.error.mockReset();
    if (originalCompactRetryLimit == null) {
      delete process.env.COCALC_CODEX_REMOTE_COMPACT_MAX_RETRIES;
    } else {
      process.env.COCALC_CODEX_REMOTE_COMPACT_MAX_RETRIES =
        originalCompactRetryLimit;
    }
    if (originalCompactRetryDelay == null) {
      delete process.env.COCALC_CODEX_REMOTE_COMPACT_RETRY_DELAY_MS;
    } else {
      process.env.COCALC_CODEX_REMOTE_COMPACT_RETRY_DELAY_MS =
        originalCompactRetryDelay;
    }
    if (originalTimeoutRetryLimit == null) {
      delete process.env.COCALC_CODEX_TIMEOUT_MAX_RETRIES;
    } else {
      process.env.COCALC_CODEX_TIMEOUT_MAX_RETRIES = originalTimeoutRetryLimit;
    }
    if (originalTimeoutRetryDelay == null) {
      delete process.env.COCALC_CODEX_TIMEOUT_RETRY_DELAY_MS;
    } else {
      process.env.COCALC_CODEX_TIMEOUT_RETRY_DELAY_MS =
        originalTimeoutRetryDelay;
    }
    if (originalStreamDisconnectRetryLimit == null) {
      delete process.env.COCALC_CODEX_STREAM_DISCONNECT_MAX_RETRIES;
    } else {
      process.env.COCALC_CODEX_STREAM_DISCONNECT_MAX_RETRIES =
        originalStreamDisconnectRetryLimit;
    }
    if (originalStreamDisconnectRetryDelay == null) {
      delete process.env.COCALC_CODEX_STREAM_DISCONNECT_RETRY_DELAY_MS;
    } else {
      process.env.COCALC_CODEX_STREAM_DISCONNECT_RETRY_DELAY_MS =
        originalStreamDisconnectRetryDelay;
    }
    if (originalTurnReconcileFailureLimit == null) {
      delete process.env.COCALC_CODEX_TURN_RECONCILE_FAILURE_LIMIT;
    } else {
      process.env.COCALC_CODEX_TURN_RECONCILE_FAILURE_LIMIT =
        originalTurnReconcileFailureLimit;
    }
    if (originalTurnNotificationIdleTimeout == null) {
      delete process.env.COCALC_CODEX_TURN_NOTIFICATION_IDLE_TIMEOUT_MS;
    } else {
      process.env.COCALC_CODEX_TURN_NOTIFICATION_IDLE_TIMEOUT_MS =
        originalTurnNotificationIdleTimeout;
    }
  });

  it("streams app-server events and returns the upstream thread id", async () => {
    const loginRequests: any[] = [];
    const threadStartRequests: any[] = [];
    const turnStartRequests: any[] = [];
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "account/login/start":
          loginRequests.push(message.params);
          fake.sendResponse(message.id, { type: "apiKey" });
          break;
        case "thread/start":
          threadStartRequests.push(message.params);
          fake.sendResponse(message.id, {
            thread: { id: "thr-shared-1" },
          });
          break;
        case "turn/start":
          turnStartRequests.push(message.params);
          fake.sendResponse(message.id, { turn: { id: "turn-1" } });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-1", status: "inProgress" },
            });
            fake.sendNotification("item/reasoning/summaryTextDelta", {
              threadId: "thr-shared-1",
              turnId: "turn-1",
              itemId: "reasoning-1",
              delta: "thinking",
              summaryIndex: 0,
            });
            fake.sendNotification("item/started", {
              threadId: "thr-shared-1",
              turnId: "turn-1",
              item: {
                type: "commandExecution",
                id: "cmd-1",
                command: "echo hi",
                cwd: "/tmp/project",
                processId: null,
                status: "inProgress",
                commandActions: [],
                aggregatedOutput: null,
                exitCode: null,
                durationMs: null,
              },
            });
            fake.sendNotification("item/commandExecution/outputDelta", {
              threadId: "thr-shared-1",
              turnId: "turn-1",
              itemId: "cmd-1",
              delta: "hi\n",
            });
            fake.sendNotification("item/completed", {
              threadId: "thr-shared-1",
              turnId: "turn-1",
              item: {
                type: "commandExecution",
                id: "cmd-1",
                command: "echo hi",
                cwd: "/tmp/project",
                processId: null,
                status: "completed",
                commandActions: [],
                aggregatedOutput: "hi\n",
                exitCode: 0,
                durationMs: 5,
              },
            });
            fake.sendNotification("item/updated", {
              threadId: "thr-shared-1",
              turnId: "turn-1",
              item: {
                type: "collabAgentToolCall",
                id: "spawn-1",
                tool: "spawnAgent",
                status: "completed",
                senderThreadId: "thr-shared-1",
                receiverThreadIds: ["thr-child-1"],
                prompt: "Review the adapter",
                model: "gpt-5.6-sol",
                reasoningEffort: "high",
                agentsStates: {
                  "thr-child-1": { status: "running" },
                },
              },
            });
            fake.sendNotification("item/updated", {
              threadId: "thr-shared-1",
              turnId: "turn-1",
              item: {
                type: "collabAgentToolCall",
                id: "spawn-1",
                tool: "spawnAgent",
                status: "completed",
                senderThreadId: "thr-shared-1",
                receiverThreadIds: ["thr-child-1"],
                prompt: "Review the adapter",
                model: "gpt-5.6-sol",
                reasoningEffort: "high",
                agentsStates: {
                  "thr-child-1": { status: "running" },
                },
              },
            });
            fake.sendNotification("thread/tokenUsage/updated", {
              threadId: "thr-shared-1",
              turnId: "turn-1",
              tokenUsage: {
                last: {
                  inputTokens: 10,
                  cachedInputTokens: 1,
                  outputTokens: 3,
                  reasoningOutputTokens: 2,
                  totalTokens: 13,
                },
                total: {
                  inputTokens: 10,
                  cachedInputTokens: 1,
                  outputTokens: 3,
                  reasoningOutputTokens: 2,
                  totalTokens: 13,
                },
                modelContextWindow: 1234,
              },
            });
            fake.sendNotification("item/agentMessage/delta", {
              threadId: "thr-shared-1",
              turnId: "turn-1",
              itemId: "msg-1",
              delta: "Hello",
            });
            fake.sendNotification("item/completed", {
              threadId: "thr-shared-1",
              turnId: "turn-1",
              item: {
                type: "agentMessage",
                id: "msg-1",
                text: "Rewritten response",
                phase: null,
              },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-1", status: "completed" },
            });
          });
          break;
        case "thread/list":
          fake.sendResponse(message.id, {
            data: [
              {
                id: "thr-child-1",
                parentThreadId: "thr-shared-1",
                status: { type: "active", activeFlags: [] },
              },
            ],
            nextCursor: null,
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
        appServerLogin: {
          type: "apiKey",
          apiKey: "secret-key",
        },
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "say hello",
      stream: async (payload) => {
        if (payload) {
          streamPayloads.push(payload);
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(streamPayloads).toEqual(
      expect.arrayContaining([
        { type: "status", state: "queued" },
        { type: "status", state: "init", threadId: "thr-shared-1" },
        { type: "status", state: "running" },
        {
          type: "event",
          event: { type: "thinking", text: "thinking" },
        },
        {
          type: "event",
          event: {
            type: "terminal",
            terminalId: "cmd-1",
            phase: "start",
            command: "echo hi",
            cwd: "/tmp/project",
          },
        },
        {
          type: "event",
          event: {
            type: "terminal",
            terminalId: "cmd-1",
            phase: "data",
            cwd: "/tmp/project",
            chunk: "hi\n",
          },
        },
        {
          type: "event",
          event: {
            type: "subagent",
            operationId: "spawn-1",
            threadId: "thr-child-1",
            parentThreadId: "thr-shared-1",
            state: "running",
            tool: "spawn",
            task: "Review the adapter",
            message: undefined,
            model: "gpt-5.6-sol",
            reasoning: "high",
          },
        },
        {
          type: "event",
          event: { type: "message", text: "Hello", delta: true },
        },
        {
          type: "usage",
          usage: {
            input_tokens: 10,
            cached_input_tokens: 1,
            output_tokens: 3,
            reasoning_output_tokens: 2,
            total_tokens: 13,
            model_context_window: 1234,
          },
        },
        {
          type: "summary",
          finalResponse: "Rewritten response",
          usage: {
            input_tokens: 10,
            cached_input_tokens: 1,
            output_tokens: 3,
            reasoning_output_tokens: 2,
            total_tokens: 13,
            model_context_window: 1234,
          },
          threadId: "thr-shared-1",
        },
      ]),
    );
    expect(streamPayloads).not.toContainEqual({
      type: "event",
      event: {
        type: "message",
        text: "Rewritten response",
        delta: false,
      },
    });
    expect(
      streamPayloads.filter(
        (payload) =>
          payload.type === "event" && payload.event?.type === "subagent",
      ),
    ).toHaveLength(1);
    expect(loginRequests).toEqual([
      {
        type: "apiKey",
        apiKey: "secret-key",
      },
    ]);
    expect(threadStartRequests).toEqual([
      expect.objectContaining({
        serviceTier: null,
      }),
    ]);
    expect(turnStartRequests).toEqual([
      expect.objectContaining({
        serviceTier: null,
      }),
    ]);
  });

  it("publishes retained runtime ownership until the app-server is disposed", async () => {
    const ownershipChanged = jest.fn(async () => {});
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, { thread: { id: "thr-owned" } });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-owned" } });
          setImmediate(() => {
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-owned", status: "completed" },
            });
          });
          break;
        case "thread/list":
        case "thread/backgroundTerminals/list":
          fake.sendResponse(message.id, { data: [], nextCursor: null });
          break;
        default:
          if (typeof message.id === "number") fake.sendResponse(message.id, {});
      }
    });
    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent({
      onRuntimeOwnershipChanged: ownershipChanged,
    });
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "say hello",
      stream: async () => {},
      chat: { path: "a.chat" } as any,
      config: { workingDirectory: "/tmp/project" },
    });

    expect(ownershipChanged).toHaveBeenCalledWith({
      state: "owned",
      sessionId: "thr-owned",
      projectId: "00000000-0000-4000-8000-000000000000",
      accountId: "00000000-0000-4000-8000-000000000001",
      path: "a.chat",
    });
    await agent.dispose();
    expect(ownershipChanged).toHaveBeenLastCalledWith({
      state: "released",
      sessionId: "thr-owned",
      projectId: "00000000-0000-4000-8000-000000000000",
      accountId: "00000000-0000-4000-8000-000000000001",
      path: "a.chat",
    });
  });

  it("reconciles started subagent activity when the manager turn completes", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, { thread: { id: "thr-manager" } });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-manager" } });
          setImmediate(() => {
            fake.sendNotification("item/started", {
              threadId: "thr-manager",
              turnId: "turn-manager",
              item: {
                type: "subAgentActivity",
                id: "subagent-started",
                kind: "started",
                agentThreadId: "thr-child",
                agentPath: "/root/reviewer",
              },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-manager", status: "completed" },
            });
          });
          break;
        case "thread/list":
          // Completed descendants may no longer be included in this listing.
          fake.sendResponse(message.id, { data: [], nextCursor: null });
          break;
        case "thread/read":
          fake.sendResponse(message.id, {
            thread: {
              id: "thr-child",
              turns: [{ id: "turn-child", status: "completed" }],
            },
          });
          break;
        case "thread/backgroundTerminals/list":
          fake.sendResponse(message.id, { data: [], nextCursor: null });
          break;
        default:
          if (typeof message.id === "number") fake.sendResponse(message.id, {});
      }
    });
    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const streamPayloads: any[] = [];
    await new CodexAppServerAgent().evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "delegate this task",
      stream: async (payload) => {
        if (payload) streamPayloads.push(payload);
      },
      config: { workingDirectory: "/tmp/project" },
    });

    expect(
      streamPayloads
        .filter(
          (payload) =>
            payload.type === "event" && payload.event?.type === "subagent",
        )
        .map((payload) => payload.event.state),
    ).toEqual(["pending", "completed"]);
  });

  it("streams completed app-server agent messages when no delta was emitted", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-completed-message-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-message-1" } });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-message-1", status: "inProgress" },
            });
            fake.sendNotification("item/completed", {
              threadId: "thr-completed-message-1",
              turnId: "turn-message-1",
              item: {
                type: "agentMessage",
                id: "msg-completed-1",
                text: "Manager progress update",
                phase: "commentary",
              },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-message-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "say progress",
      stream: async (payload) => {
        if (payload) {
          streamPayloads.push(payload);
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(streamPayloads).toEqual(
      expect.arrayContaining([
        {
          type: "event",
          event: {
            type: "message",
            text: "Manager progress update",
            delta: false,
          },
        },
        {
          type: "summary",
          finalResponse: "Manager progress update",
          usage: undefined,
          threadId: "thr-completed-message-1",
        },
      ]),
    );
  });

  it("clears persisted Codex goals before normal chat turns", async () => {
    const rootHostPath = mkdtempSync(path.join(tmpdir(), "codex-root-"));
    const codexHome = path.join(rootHostPath, ".codex");
    const goalsDbPath = createCodexGoalsDb(codexHome);
    const appServerCalls: Array<{ method: string; params: any }> = [];
    const proc = new FakeCodexAppServerProc((fake, message) => {
      appServerCalls.push({ method: message.method, params: message.params });
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/resume":
          fake.sendResponse(message.id, {
            thread: { id: "thr-goal-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-goal-1" } });
          setImmediate(() => {
            fake.sendNotification("item/agentMessage/delta", {
              threadId: "thr-goal-1",
              turnId: "turn-goal-1",
              itemId: "msg-goal-1",
              delta: "Fresh response",
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-goal-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
        containerPathMap: {
          rootHostPath,
        },
      }),
    });

    try {
      const agent = new CodexAppServerAgent();
      await agent.evaluate({
        project_id: "00000000-0000-4000-8000-000000000000",
        account_id: "00000000-0000-4000-8000-000000000001",
        session_id: "chat-thread-goal",
        prompt: "hi",
        stream: async () => {},
        config: {
          workingDirectory: "/tmp/project",
        } as any,
        chat: {
          project_id: "00000000-0000-4000-8000-000000000000",
          path: "/tmp/project/test.chat",
          message_date: "2026-06-06T00:00:01.000Z",
          sender_id: "openai-codex-agent",
          thread_id: "thread-goal-1",
          message_id: "assistant-goal-1",
          parent_message_id: "user-goal-1",
        },
      });

      expect(countCodexGoals(goalsDbPath)).toBe(0);
      expect(appServerCalls.map((call) => call.method)).toEqual(
        expect.arrayContaining(["thread/resume", "turn/start"]),
      );
      expect(appServerCalls.map((call) => call.method)).not.toContain(
        "thread/goal/get",
      );
      expect(appServerCalls.map((call) => call.method)).not.toContain(
        "thread/goal/clear",
      );
    } finally {
      rmSync(rootHostPath, { recursive: true, force: true });
    }
  });

  it("clears persisted Codex goals before automation turns", async () => {
    const rootHostPath = mkdtempSync(path.join(tmpdir(), "codex-root-"));
    const codexHome = path.join(rootHostPath, ".codex");
    const goalsDbPath = createCodexGoalsDb(codexHome);
    const appServerCalls: Array<{ method: string; params: any }> = [];
    const proc = new FakeCodexAppServerProc((fake, message) => {
      appServerCalls.push({ method: message.method, params: message.params });
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/resume":
          fake.sendResponse(message.id, {
            thread: { id: "thr-automation-goal-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, {
            turn: { id: "turn-automation-goal-1" },
          });
          setImmediate(() => {
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-automation-goal-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
        containerPathMap: {
          rootHostPath,
        },
      }),
    });

    try {
      const agent = new CodexAppServerAgent();
      await agent.evaluate({
        project_id: "00000000-0000-4000-8000-000000000000",
        account_id: "00000000-0000-4000-8000-000000000001",
        session_id: "automation-thread-goal",
        prompt: "continue automation",
        stream: async () => {},
        config: {
          workingDirectory: "/tmp/project",
        } as any,
        chat: {
          project_id: "00000000-0000-4000-8000-000000000000",
          path: "/tmp/project/test.chat",
          message_date: "2026-06-06T00:00:01.000Z",
          sender_id: "openai-codex-agent",
          thread_id: "thread-goal-1",
          message_id: "assistant-goal-1",
          parent_message_id: "user-goal-1",
          automation_id: "automation-goal-1",
        },
      });

      expect(countCodexGoals(goalsDbPath)).toBe(0);
      expect(appServerCalls.map((call) => call.method)).not.toContain(
        "thread/goal/get",
      );
      expect(appServerCalls.map((call) => call.method)).not.toContain(
        "thread/goal/clear",
      );
    } finally {
      rmSync(rootHostPath, { recursive: true, force: true });
    }
  });

  it("passes explicit Codex Fast mode service tier to app-server", async () => {
    const threadStartRequests: any[] = [];
    const turnStartRequests: any[] = [];
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          threadStartRequests.push(message.params);
          fake.sendResponse(message.id, {
            thread: { id: "thr-fast-1" },
          });
          break;
        case "turn/start":
          turnStartRequests.push(message.params);
          fake.sendResponse(message.id, { turn: { id: "turn-fast-1" } });
          setImmediate(() => {
            fake.sendNotification("item/agentMessage/delta", {
              threadId: "thr-fast-1",
              turnId: "turn-fast-1",
              itemId: "msg-fast-1",
              delta: "Fast",
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-fast-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "say hello",
      stream: async (payload) => {
        if (payload) {
          streamPayloads.push(payload);
        }
      },
      config: {
        serviceTier: "fast",
        reasoning: "low",
        sessionMode: "full-access",
        workingDirectory: "/tmp/project",
      },
    });

    expect(threadStartRequests).toEqual([
      expect.objectContaining({
        model: "gpt-5.6-sol",
        serviceTier: "fast",
      }),
    ]);
    expect(turnStartRequests).toEqual([
      expect.objectContaining({
        model: "gpt-5.6-sol",
        serviceTier: "fast",
      }),
    ]);
    expect(streamPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "event",
          event: expect.objectContaining({
            type: "config",
            model: "gpt-5.6-sol",
            reasoning: "low",
            serviceTier: "fast",
            appServerServiceTier: "fast",
            sessionMode: "full-access",
            sandbox: "danger-full-access",
            workingDirectory: "/tmp/project",
          }),
        }),
      ]),
    );
  });

  it("summarizes expired ChatGPT auth failures", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-auth-expired" },
          });
          break;
        case "turn/start": {
          const turnId = "turn-auth-expired";
          fake.sendResponse(message.id, { turn: { id: turnId } });
          setImmediate(() => {
            fake.stderr.write(
              "2026-04-02T14:32:45Z ERROR codex_app_server: unrelated stderr\n",
            );
            fake.sendNotification("error", {
              threadId: "thr-auth-expired",
              turnId,
              error: {
                message:
                  "unexpected status 401 Unauthorized: Encountered invalidated oauth token for user, failing request, url: https://chatgpt.com/backend-api/codex/responses, cf-ray: test, auth error: identity_edge_internal_error",
              },
            });
            fake.sendNotification("turn/completed", {
              turn: {
                id: turnId,
                status: "failed",
                error: {
                  message: "HTTP error: 401 Unauthorized",
                },
              },
            });
          });
          break;
        }
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "say hello",
      stream: async (payload) => {
        if (payload) {
          streamPayloads.push(payload);
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    const error = streamPayloads.find((payload) => payload.type === "error");
    expect(error?.error).toBe(
      "Codex authentication expired.\n\nSign in again with your ChatGPT Plan or update your OpenAI API key, then retry this message.",
    );
    expect(error?.error).not.toContain("cf-ray");
    expect(error?.error).not.toContain("unrelated stderr");
  });

  it("includes stderr tail when the app-server process exits during startup", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      if (message.method !== "initialize") return;
      fake.stderr.write("/opt/cocalc/bin2/codex: not found\n");
      fake.exitCode = 127;
      setImmediate(() => fake.emit("exit", 127, null));
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "say hello",
      stream: async (payload) => {
        if (payload) {
          streamPayloads.push(payload);
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    const error = streamPayloads.find((payload) => payload.type === "error");
    expect(error?.error).toContain("codex app-server exited unexpectedly: 127");
    expect(error?.error).toContain("/opt/cocalc/bin2/codex: not found");
  });

  it.each<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>([
    { code: 137, signal: null },
    { code: null, signal: "SIGKILL" },
  ])(
    "explains that a $signal/$code app-server exit is usually out of memory",
    async ({ code, signal }) => {
      const proc = new FakeCodexAppServerProc((fake, message) => {
        if (message.method !== "initialize") return;
        fake.exitCode = code;
        setImmediate(() => fake.emit("exit", code, signal));
      });

      setCodexProjectSpawner({
        spawnCodexExec: async () => {
          throw new Error("unexpected codex exec spawn");
        },
        spawnCodexAppServer: async () => ({
          proc: proc as any,
          cmd: "fake-codex",
          args: ["app-server"],
          cwd: "/tmp/project",
        }),
      });

      const agent = new CodexAppServerAgent();
      const streamPayloads: any[] = [];
      await agent.evaluate({
        project_id: "00000000-0000-4000-8000-000000000000",
        account_id: "00000000-0000-4000-8000-000000000001",
        prompt: "say hello",
        stream: async (payload) => {
          if (payload) streamPayloads.push(payload);
        },
        config: { workingDirectory: "/tmp/project" } as any,
      });

      const error = streamPayloads.find((payload) => payload.type === "error");
      expect(error?.error).toContain(
        "Codex was killed by SIGKILL (exit code 137).",
      );
      expect(error?.error).toContain(
        "usually caused by the project running out of RAM",
      );
      expect(error?.error).toContain("Increase the project's RAM");
      expect(error?.code).toBe("codex_resource_killed");
      expect(error?.retryable).toBe(true);
    },
  );

  it("fails immediately when the app-server exits while a turn is running", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "account/login/start":
          fake.sendResponse(message.id, { type: "apiKey" });
          break;
        case "thread/start":
          fake.sendResponse(message.id, { thread: { id: "thr-exit" } });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-exit" } });
          setImmediate(() => {
            fake.stderr.write("provider transport unavailable\n");
            fake.exitCode = 255;
            fake.emit("exit", 255, null);
          });
          break;
        default:
          if (typeof message.id === "number") fake.sendResponse(message.id, {});
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
        appServerLogin: { type: "apiKey", apiKey: "secret-key" },
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    const startedAt = Date.now();
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "say hello",
      stream: async (payload) => {
        if (payload) streamPayloads.push(payload);
      },
      config: { workingDirectory: "/tmp/project" } as any,
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const error = streamPayloads.find((payload) => payload.type === "error");
    expect(error?.error).toContain("codex app-server exited unexpectedly: 255");
    expect(error?.error).toContain("provider transport unavailable");
    expect(error?.code).toBe("codex_app_server_exited");
    expect(error?.retryable).toBe(true);
    expect(loggerMock.warn).not.toHaveBeenCalledWith(
      "codex app-server: turn reconciliation failed",
      expect.anything(),
    );
  });

  it("keeps waiting when a paginated thread is active but omits its live turn", async () => {
    process.env.COCALC_CODEX_TURN_NOTIFICATION_IDLE_TIMEOUT_MS = "50";
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, { thread: { id: "thr-paginated" } });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-paginated" } });
          break;
        case "thread/read":
          fake.sendResponse(message.id, {
            thread: {
              id: "thr-paginated",
              historyMode: "paginated",
              status: { type: "active", activeFlags: [] },
              turns: [],
            },
          });
          setImmediate(() => {
            fake.sendNotification("item/agentMessage/delta", {
              threadId: "thr-paginated",
              turnId: "turn-paginated",
              itemId: "message-paginated",
              delta: "Recovered live turn",
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-paginated", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") fake.sendResponse(message.id, {});
      }
    });
    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const streamPayloads: any[] = [];
    await new CodexAppServerAgent().evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "continue",
      stream: async (payload) => {
        if (payload) streamPayloads.push(payload);
      },
      config: { workingDirectory: "/tmp/project" } as any,
    });

    expect(streamPayloads).toContainEqual(
      expect.objectContaining({
        type: "summary",
        finalResponse: "Recovered live turn",
      }),
    );
    expect(streamPayloads.some((payload) => payload.type === "error")).toBe(
      false,
    );
  }, 15_000);

  it("classifies an idle thread with no durable active turn as lost", async () => {
    process.env.COCALC_CODEX_TURN_NOTIFICATION_IDLE_TIMEOUT_MS = "50";
    process.env.COCALC_CODEX_TURN_RECONCILE_FAILURE_LIMIT = "1";
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, { thread: { id: "thr-lost" } });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-lost" } });
          break;
        case "thread/read":
          fake.sendResponse(message.id, {
            thread: {
              id: "thr-lost",
              status: { type: "idle" },
              turns: [],
            },
          });
          break;
        default:
          if (typeof message.id === "number") fake.sendResponse(message.id, {});
      }
    });
    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const streamPayloads: any[] = [];
    await new CodexAppServerAgent().evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "continue",
      stream: async (payload) => {
        if (payload) streamPayloads.push(payload);
      },
      config: { workingDirectory: "/tmp/project" } as any,
    });

    expect(streamPayloads).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "codex_turn_lost",
        retryable: true,
      }),
    );
  }, 15_000);

  it("surfaces a command rejection instead of the routine bubblewrap warning", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      if (message.method !== "initialize") return;
      fake.stderr.write(
        "ERROR codex_app_server: Codex could not find bubblewrap on PATH. Codex will use the bundled bubblewrap in the meantime.\n",
      );
      fake.stderr.write(
        'ERROR codex_core::tools::router: CreateProcess { message: "command rejected: rm -f style commands are not permitted. Use a safer approach" }\n',
      );
      fake.stderr.write(
        "Error: no container with ID test-container found in database\n",
      );
      fake.exitCode = 255;
      setImmediate(() => fake.emit("exit", 255, null));
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "run a command",
      stream: async (payload) => {
        if (payload) streamPayloads.push(payload);
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    const error = streamPayloads.find((payload) => payload.type === "error");
    expect(error?.error).toContain(
      "Codex blocked a command: rm -f style commands are not permitted. Use a safer approach",
    );
    expect(error?.code).toBe("codex_command_blocked");
    expect(error?.retryable).toBe(true);
    expect(error?.error).not.toContain("bubblewrap");
    expect(error?.error).not.toContain("no container with ID");
  });

  it("summarizes missing API authentication failures", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-auth-missing" },
          });
          break;
        case "turn/start": {
          const turnId = "turn-auth-missing";
          fake.sendResponse(message.id, { turn: { id: turnId } });
          setImmediate(() => {
            fake.sendNotification("error", {
              threadId: "thr-auth-missing",
              turnId,
              error: {
                message:
                  "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, request id: req-test",
              },
            });
            fake.sendNotification("turn/completed", {
              turn: {
                id: turnId,
                status: "failed",
                error: {
                  message: "HTTP error: 401 Unauthorized",
                },
              },
            });
          });
          break;
        }
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "say hello",
      stream: async (payload) => {
        if (payload) {
          streamPayloads.push(payload);
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    const error = streamPayloads.find((payload) => payload.type === "error");
    expect(error?.error).toBe(
      "Codex is not configured.\n\nConnect a ChatGPT Plan or add an OpenAI API key, then retry this message.",
    );
    expect(error?.error).not.toContain("request id");
  });

  it("summarizes direct app-server request auth failures", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-direct-auth" },
          });
          break;
        case "turn/start":
          fake.stdout.write(
            `${JSON.stringify({
              id: message.id,
              error: {
                message:
                  "unexpected status 401 Unauthorized: Provided authentication token is expired. Please try signing in again.",
              },
            })}\n`,
          );
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "say hello",
      stream: async (payload) => {
        if (payload) {
          streamPayloads.push(payload);
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    const error = streamPayloads.find((payload) => payload.type === "error");
    expect(error?.error).toBe(
      "Codex authentication expired.\n\nSign in again with your ChatGPT Plan or update your OpenAI API key, then retry this message.",
    );
  });

  it("backfills terminal command metadata when output arrives before item start", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-out-of-order-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, {
            turn: { id: "turn-out-of-order-1" },
          });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-out-of-order-1", status: "inProgress" },
            });
            fake.sendNotification("item/commandExecution/outputDelta", {
              threadId: "thr-out-of-order-1",
              turnId: "turn-out-of-order-1",
              itemId: "cmd-out-of-order-1",
              delta: "hi\n",
            });
            fake.sendNotification("item/started", {
              threadId: "thr-out-of-order-1",
              turnId: "turn-out-of-order-1",
              item: {
                type: "commandExecution",
                id: "cmd-out-of-order-1",
                command: "echo hi",
                cwd: "/tmp/project",
                processId: null,
                status: "inProgress",
                commandActions: [],
                aggregatedOutput: null,
                exitCode: null,
                durationMs: null,
              },
            });
            fake.sendNotification("item/completed", {
              threadId: "thr-out-of-order-1",
              turnId: "turn-out-of-order-1",
              item: {
                type: "commandExecution",
                id: "cmd-out-of-order-1",
                command: "echo hi",
                cwd: "/tmp/project",
                processId: null,
                status: "completed",
                commandActions: [],
                aggregatedOutput: "hi\n",
                exitCode: 0,
                durationMs: 5,
              },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-out-of-order-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "say hello",
      stream: async (payload) => {
        if (payload) {
          streamPayloads.push(payload);
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    const terminalStarts = streamPayloads.filter(
      (payload) =>
        payload?.type === "event" &&
        payload.event?.type === "terminal" &&
        payload.event?.terminalId === "cmd-out-of-order-1" &&
        payload.event?.phase === "start",
    );

    expect(terminalStarts).toEqual([
      {
        type: "event",
        event: {
          type: "terminal",
          terminalId: "cmd-out-of-order-1",
          phase: "start",
          command: undefined,
          cwd: "/tmp/project",
        },
      },
      {
        type: "event",
        event: {
          type: "terminal",
          terminalId: "cmd-out-of-order-1",
          phase: "start",
          command: "echo hi",
          cwd: "/tmp/project",
        },
      },
    ]);
  });

  it("streams completed image-generation metadata without raw image data", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-image-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, {
            turn: { id: "turn-image-1" },
          });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-image-1", status: "inProgress" },
            });
            fake.sendNotification("item/updated", {
              threadId: "thr-image-1",
              turnId: "turn-image-1",
              item: {
                type: "imageGeneration",
                id: "img-1",
                status: "inProgress",
                revisedPrompt: "A clean diagram of a reconnect pipeline",
                result: "base64-image-data-that-must-not-be-streamed",
              },
            });
            const completedItem = {
              type: "imageGeneration",
              id: "img-1",
              status: "completed",
              revisedPrompt: "A clean diagram of a reconnect pipeline",
              savedPath: "/tmp/project/.codex/generated_images/img-1.png",
              result: "base64-image-data-that-must-not-be-streamed",
            };
            fake.sendNotification("item/updated", {
              threadId: "thr-image-1",
              turnId: "turn-image-1",
              item: completedItem,
            });
            fake.sendNotification("item/completed", {
              threadId: "thr-image-1",
              turnId: "turn-image-1",
              item: completedItem,
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-image-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const uploadCalls: any[] = [];
    const agent = new CodexAppServerAgent({
      uploadGeneratedImage: async (opts) => {
        uploadCalls.push(opts);
        return {
          uuid: "blob-1",
          filename: "img-1.png",
          url: "/blobs/img-1.png?uuid=blob-1",
        };
      },
    });
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "make an image",
      stream: async (payload) => {
        if (payload) {
          streamPayloads.push(payload);
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    const imageEvents = streamPayloads.filter(
      (payload) => payload?.type === "event" && payload.event?.type === "image",
    );
    expect(imageEvents).toEqual([
      {
        type: "event",
        event: {
          type: "image",
          id: "img-1",
          status: "completed",
          revisedPrompt: "A clean diagram of a reconnect pipeline",
          savedPath: "/tmp/project/.codex/generated_images/img-1.png",
          blob: {
            uuid: "blob-1",
            filename: "img-1.png",
            url: "/blobs/img-1.png?uuid=blob-1",
          },
        },
      },
    ]);
    expect(uploadCalls).toEqual([
      expect.objectContaining({
        savedPath: "/tmp/project/.codex/generated_images/img-1.png",
        hostPath: "/tmp/project/.codex/generated_images/img-1.png",
        filename: "img-1.png",
        imageId: "img-1",
        revisedPrompt: "A clean diagram of a reconnect pipeline",
        cwd: "/tmp/project",
        projectId: "00000000-0000-4000-8000-000000000000",
        accountId: "00000000-0000-4000-8000-000000000001",
        threadId: "thr-image-1",
        turnId: "turn-image-1",
      }),
    ]);
    expect(JSON.stringify(streamPayloads)).not.toContain("base64-image-data");
  });

  it("retries remote compaction timeouts before visible turn side effects", async () => {
    process.env.COCALC_CODEX_REMOTE_COMPACT_MAX_RETRIES = "1";
    process.env.COCALC_CODEX_REMOTE_COMPACT_RETRY_DELAY_MS = "1";

    const appServerCalls: Array<{
      spawn: number;
      method: string;
      params: any;
    }> = [];
    let spawnCount = 0;

    const compactTimeout =
      "Error running remote compact task: timeout waiting for child process to exit 2026-04-07T18:20:13.638249Z ERROR codex_core::compact_remote: remote compaction failed compact_error=timeout waiting for child process to exit";

    const makeProc = (spawn: number) =>
      new FakeCodexAppServerProc((fake, message) => {
        appServerCalls.push({
          spawn,
          method: message.method,
          params: message.params,
        });
        switch (message.method) {
          case "initialize":
            fake.sendResponse(message.id, { ok: true });
            break;
          case "thread/resume":
            if (spawn === 1) {
              fake.stdout.write(
                `${JSON.stringify({
                  id: message.id,
                  error: { message: "thread not found" },
                })}\n`,
              );
            } else {
              fake.sendResponse(message.id, {
                thread: { id: "thr-compact-1" },
              });
            }
            break;
          case "thread/start":
            fake.sendResponse(message.id, {
              thread: { id: "thr-compact-1" },
            });
            break;
          case "turn/start": {
            const turnId = `turn-compact-${spawn}`;
            fake.sendResponse(message.id, { turn: { id: turnId } });
            setImmediate(() => {
              fake.sendNotification("turn/started", {
                turn: { id: turnId, status: "inProgress" },
              });
              if (spawn === 1) {
                fake.sendNotification("error", {
                  turnId,
                  error: { message: compactTimeout },
                });
                fake.sendNotification("turn/completed", {
                  turn: {
                    id: turnId,
                    status: "failed",
                    error: { message: compactTimeout },
                  },
                });
              } else {
                fake.sendNotification("item/agentMessage/delta", {
                  threadId: "thr-compact-1",
                  turnId,
                  itemId: "msg-compact-1",
                  delta: "Recovered",
                });
                fake.sendNotification("turn/completed", {
                  turn: { id: turnId, status: "completed" },
                });
              }
            });
            break;
          }
          default:
            if (typeof message.id === "number") {
              fake.sendResponse(message.id, {});
            }
        }
      });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: makeProc(++spawnCount) as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      session_id: "chat-thread-compact",
      prompt: "continue",
      stream: async (payload) => {
        if (payload) {
          streamPayloads.push(payload);
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(spawnCount).toBe(2);
    expect(
      appServerCalls.filter((call) => call.method === "turn/start"),
    ).toHaveLength(2);
    expect(
      appServerCalls.filter((call) => call.method === "thread/resume"),
    ).toEqual([
      expect.objectContaining({
        spawn: 1,
        params: expect.objectContaining({
          threadId: "chat-thread-compact",
        }),
      }),
      expect.objectContaining({
        spawn: 2,
        params: expect.objectContaining({
          threadId: "thr-compact-1",
        }),
      }),
    ]);
    expect(streamPayloads).toEqual(
      expect.arrayContaining([
        {
          type: "event",
          event: {
            type: "thinking",
            text: "Remote context compaction timed out. Retrying (1/1)...",
          },
        },
        {
          type: "summary",
          finalResponse: "Recovered",
          usage: undefined,
          threadId: "thr-compact-1",
        },
      ]),
    );
    expect(
      streamPayloads.find((payload) => payload.type === "error"),
    ).toBeUndefined();
  });

  it("retries short-form remote compaction timeout errors", async () => {
    process.env.COCALC_CODEX_REMOTE_COMPACT_MAX_RETRIES = "1";
    process.env.COCALC_CODEX_REMOTE_COMPACT_RETRY_DELAY_MS = "1";

    let spawnCount = 0;
    const compactTimeout =
      "Error running remote compact task: timeout waiting for child process to exit";

    const makeProc = (spawn: number) =>
      new FakeCodexAppServerProc((fake, message) => {
        switch (message.method) {
          case "initialize":
            fake.sendResponse(message.id, { ok: true });
            break;
          case "thread/start":
            fake.sendResponse(message.id, {
              thread: { id: "thr-compact-short-1" },
            });
            break;
          case "turn/start": {
            const turnId = `turn-compact-short-${spawn}`;
            fake.sendResponse(message.id, { turn: { id: turnId } });
            setImmediate(() => {
              fake.sendNotification("turn/started", {
                turn: { id: turnId, status: "inProgress" },
              });
              if (spawn === 1) {
                fake.sendNotification("error", {
                  turnId,
                  error: { message: compactTimeout },
                });
                fake.sendNotification("turn/completed", {
                  turn: {
                    id: turnId,
                    status: "failed",
                    error: { message: compactTimeout },
                  },
                });
              } else {
                fake.sendNotification("item/agentMessage/delta", {
                  threadId: "thr-compact-short-1",
                  turnId,
                  itemId: "msg-compact-short-1",
                  delta: "Recovered",
                });
                fake.sendNotification("turn/completed", {
                  turn: { id: turnId, status: "completed" },
                });
              }
            });
            break;
          }
          default:
            if (typeof message.id === "number") {
              fake.sendResponse(message.id, {});
            }
        }
      });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: makeProc(++spawnCount) as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "continue",
      stream: async (payload) => {
        if (payload) {
          streamPayloads.push(payload);
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(spawnCount).toBe(2);
    expect(streamPayloads).toEqual(
      expect.arrayContaining([
        {
          type: "event",
          event: {
            type: "thinking",
            text: "Remote context compaction timed out. Retrying (1/1)...",
          },
        },
        {
          type: "summary",
          finalResponse: "Recovered",
          usage: undefined,
          threadId: "thr-compact-short-1",
        },
      ]),
    );
  });

  it("stops after bounded remote compaction retries and adds guidance", async () => {
    process.env.COCALC_CODEX_REMOTE_COMPACT_MAX_RETRIES = "1";
    process.env.COCALC_CODEX_REMOTE_COMPACT_RETRY_DELAY_MS = "1";

    let spawnCount = 0;
    const compactTimeout =
      "Error running remote compact task: timeout waiting for child process to exit 2026-04-07T18:20:13.638249Z ERROR codex_core::compact_remote: remote compaction failed compact_error=timeout waiting for child process to exit";

    const makeProc = (spawn: number) =>
      new FakeCodexAppServerProc((fake, message) => {
        switch (message.method) {
          case "initialize":
            fake.sendResponse(message.id, { ok: true });
            break;
          case "thread/resume":
            if (spawn === 1) {
              fake.stdout.write(
                `${JSON.stringify({
                  id: message.id,
                  error: { message: "thread not found" },
                })}\n`,
              );
            } else {
              fake.sendResponse(message.id, {
                thread: { id: "thr-compact-1" },
              });
            }
            break;
          case "thread/start":
            fake.sendResponse(message.id, {
              thread: { id: `thr-compact-${spawn}` },
            });
            break;
          case "turn/start": {
            const turnId = `turn-compact-${spawn}`;
            fake.sendResponse(message.id, { turn: { id: turnId } });
            setImmediate(() => {
              fake.sendNotification("turn/started", {
                turn: { id: turnId, status: "inProgress" },
              });
              fake.sendNotification("error", {
                turnId,
                error: { message: compactTimeout },
              });
              fake.sendNotification("turn/completed", {
                turn: {
                  id: turnId,
                  status: "failed",
                  error: { message: compactTimeout },
                },
              });
            });
            break;
          }
          default:
            if (typeof message.id === "number") {
              fake.sendResponse(message.id, {});
            }
        }
      });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => {
        const spawn = ++spawnCount;
        return {
          proc: makeProc(spawn) as any,
          cmd: "fake-codex",
          args: ["app-server"],
          cwd: "/tmp/project",
        };
      },
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      session_id: "chat-thread-compact",
      prompt: "continue",
      stream: async (payload) => {
        if (payload) streamPayloads.push(payload);
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(spawnCount).toBe(2);
    const errorPayload = streamPayloads.find(
      (payload) => payload.type === "error",
    );
    expect(errorPayload?.error).toContain("Error running remote compact task");
    expect(errorPayload?.error).toContain(
      "starting a fresh chat to reduce history size",
    );
  });

  it("classifies model-capacity failures for durable recovery", async () => {
    let spawnCount = 0;
    const capacityError =
      "Selected model is at capacity. Please try a different model.";

    const makeProc = () =>
      new FakeCodexAppServerProc((fake, message) => {
        switch (message.method) {
          case "initialize":
            fake.sendResponse(message.id, { ok: true });
            break;
          case "thread/start":
            fake.sendResponse(message.id, {
              thread: { id: "thr-capacity-1" },
            });
            break;
          case "turn/start": {
            const turnId = "turn-capacity-1";
            fake.sendResponse(message.id, { turn: { id: turnId } });
            setImmediate(() => {
              fake.sendNotification("turn/started", {
                turn: { id: turnId, status: "inProgress" },
              });
              fake.sendNotification("error", {
                turnId,
                error: { message: capacityError },
              });
              fake.sendNotification("turn/completed", {
                turn: {
                  id: turnId,
                  status: "failed",
                  error: { message: capacityError },
                },
              });
            });
            break;
          }
          default:
            if (typeof message.id === "number") {
              fake.sendResponse(message.id, {});
            }
        }
      });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => {
        spawnCount += 1;
        return {
          proc: makeProc() as any,
          cmd: "fake-codex",
          args: ["app-server"],
          cwd: "/tmp/project",
        };
      },
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "continue",
      stream: async (payload) => {
        if (payload) streamPayloads.push(payload);
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(spawnCount).toBe(1);
    expect(streamPayloads).toContainEqual({
      type: "error",
      error: capacityError,
      code: "codex_model_capacity",
      retryable: true,
    });
  });

  it("recognizes plural model-capacity failures", async () => {
    let spawnCount = 0;
    const capacityError = "Models are at capacity. Please try again later.";

    const makeProc = () =>
      new FakeCodexAppServerProc((fake, message) => {
        switch (message.method) {
          case "initialize":
            fake.sendResponse(message.id, { ok: true });
            break;
          case "thread/start":
            fake.sendResponse(message.id, {
              thread: { id: `thr-capacity-${spawnCount}` },
            });
            break;
          case "turn/start": {
            const turnId = `turn-capacity-${spawnCount}`;
            fake.sendResponse(message.id, { turn: { id: turnId } });
            setImmediate(() => {
              fake.sendNotification("turn/started", {
                turn: { id: turnId, status: "inProgress" },
              });
              fake.sendNotification("error", {
                turnId,
                error: { message: capacityError },
              });
              fake.sendNotification("turn/completed", {
                turn: {
                  id: turnId,
                  status: "failed",
                  error: { message: capacityError },
                },
              });
            });
            break;
          }
          default:
            if (typeof message.id === "number") {
              fake.sendResponse(message.id, {});
            }
        }
      });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => {
        spawnCount += 1;
        return {
          proc: makeProc() as any,
          cmd: "fake-codex",
          args: ["app-server"],
          cwd: "/tmp/project",
        };
      },
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "continue",
      stream: async (payload) => {
        if (payload) streamPayloads.push(payload);
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(spawnCount).toBe(1);
    const errorPayload = streamPayloads.find(
      (payload) => payload.type === "error",
    );
    expect(errorPayload).toEqual({
      type: "error",
      error: capacityError,
      code: "codex_model_capacity",
      retryable: true,
    });
  });

  it("does not retry remote compaction failures after visible turn output", async () => {
    process.env.COCALC_CODEX_REMOTE_COMPACT_MAX_RETRIES = "1";
    process.env.COCALC_CODEX_REMOTE_COMPACT_RETRY_DELAY_MS = "1";

    let spawnCount = 0;
    const compactTimeout =
      "Error running remote compact task: timeout waiting for child process to exit 2026-04-07T18:20:13.638249Z ERROR codex_core::compact_remote: remote compaction failed compact_error=timeout waiting for child process to exit";

    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-side-effects-1" },
          });
          break;
        case "turn/start": {
          fake.sendResponse(message.id, {
            turn: { id: "turn-side-effects-1" },
          });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-side-effects-1", status: "inProgress" },
            });
            fake.sendNotification("item/started", {
              threadId: "thr-side-effects-1",
              turnId: "turn-side-effects-1",
              item: {
                type: "commandExecution",
                id: "cmd-side-effects-1",
                command: "echo hi",
                cwd: "/tmp/project",
                processId: null,
                status: "inProgress",
                commandActions: [],
                aggregatedOutput: null,
                exitCode: null,
                durationMs: null,
              },
            });
            fake.sendNotification("error", {
              turnId: "turn-side-effects-1",
              error: { message: compactTimeout },
            });
            fake.sendNotification("turn/completed", {
              turn: {
                id: "turn-side-effects-1",
                status: "failed",
                error: { message: compactTimeout },
              },
            });
          });
          break;
        }
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => {
        spawnCount += 1;
        return {
          proc: proc as any,
          cmd: "fake-codex",
          args: ["app-server"],
          cwd: "/tmp/project",
        };
      },
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "continue",
      stream: async (payload) => {
        if (payload) streamPayloads.push(payload);
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(spawnCount).toBe(1);
    expect(
      streamPayloads.find(
        (payload) =>
          payload.type === "event" &&
          payload.event?.type === "thinking" &&
          `${payload.event?.text ?? ""}`.includes("Retrying"),
      ),
    ).toBeUndefined();
    expect(
      streamPayloads.find((payload) => payload.type === "error")?.error,
    ).toContain("Error running remote compact task");
  });

  it("retries bare timeout failures with a visible retry message", async () => {
    process.env.COCALC_CODEX_TIMEOUT_MAX_RETRIES = "1";
    process.env.COCALC_CODEX_TIMEOUT_RETRY_DELAY_MS = "1000";

    let spawnCount = 0;
    const makeProc = (spawn: number) =>
      new FakeCodexAppServerProc((fake, message) => {
        switch (message.method) {
          case "initialize":
            fake.sendResponse(message.id, { ok: true });
            break;
          case "thread/start":
            fake.sendResponse(message.id, {
              thread: { id: "thr-timeout-1" },
            });
            break;
          case "turn/start": {
            const turnId = `turn-timeout-${spawn}`;
            fake.sendResponse(message.id, { turn: { id: turnId } });
            setImmediate(() => {
              fake.sendNotification("turn/started", {
                turn: { id: turnId, status: "inProgress" },
              });
              if (spawn === 1) {
                fake.sendNotification("error", {
                  turnId,
                  error: { message: "timeout" },
                });
                fake.sendNotification("turn/completed", {
                  turn: {
                    id: turnId,
                    status: "failed",
                    error: { message: "timeout" },
                  },
                });
              } else {
                fake.sendNotification("item/agentMessage/delta", {
                  threadId: "thr-timeout-1",
                  turnId,
                  itemId: "msg-timeout-1",
                  delta: "Recovered",
                });
                fake.sendNotification("turn/completed", {
                  turn: { id: turnId, status: "completed" },
                });
              }
            });
            break;
          }
          default:
            if (typeof message.id === "number") {
              fake.sendResponse(message.id, {});
            }
        }
      });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: makeProc(++spawnCount) as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "continue",
      stream: async (payload) => {
        if (payload) streamPayloads.push(payload);
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(spawnCount).toBe(2);
    expect(streamPayloads).toEqual(
      expect.arrayContaining([
        {
          type: "event",
          event: {
            type: "thinking",
            text: "Codex returned a transient timeout. Retrying in 1 second (1/1)... If this repeats, check the project-host ACP logs.",
          },
        },
        {
          type: "summary",
          finalResponse: "Recovered",
          usage: undefined,
          threadId: "thr-timeout-1",
        },
      ]),
    );
  });

  it("retries stream disconnect failures with a visible retry message", async () => {
    process.env.COCALC_CODEX_STREAM_DISCONNECT_MAX_RETRIES = "1";
    process.env.COCALC_CODEX_STREAM_DISCONNECT_RETRY_DELAY_MS = "1000";

    let spawnCount = 0;
    const streamDisconnect =
      "stream disconnected before completion: An error occurred while processing your request. Please include the request ID fdc4007d-d11f-4707-bd1a-2a06d40c3479 in your message.";
    const makeProc = (spawn: number) =>
      new FakeCodexAppServerProc((fake, message) => {
        switch (message.method) {
          case "initialize":
            fake.sendResponse(message.id, { ok: true });
            break;
          case "thread/start":
            fake.sendResponse(message.id, {
              thread: { id: "thr-stream-disconnect-1" },
            });
            break;
          case "turn/start": {
            const turnId = `turn-stream-disconnect-${spawn}`;
            fake.sendResponse(message.id, { turn: { id: turnId } });
            setImmediate(() => {
              fake.sendNotification("turn/started", {
                turn: { id: turnId, status: "inProgress" },
              });
              if (spawn === 1) {
                fake.sendNotification("error", {
                  turnId,
                  error: { message: streamDisconnect },
                });
                fake.sendNotification("turn/completed", {
                  turn: {
                    id: turnId,
                    status: "failed",
                    error: { message: streamDisconnect },
                  },
                });
              } else {
                fake.sendNotification("item/agentMessage/delta", {
                  threadId: "thr-stream-disconnect-1",
                  turnId,
                  itemId: "msg-stream-disconnect-1",
                  delta: "Recovered",
                });
                fake.sendNotification("turn/completed", {
                  turn: { id: turnId, status: "completed" },
                });
              }
            });
            break;
          }
          default:
            if (typeof message.id === "number") {
              fake.sendResponse(message.id, {});
            }
        }
      });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: makeProc(++spawnCount) as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "continue",
      stream: async (payload) => {
        if (payload) streamPayloads.push(payload);
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(spawnCount).toBe(2);
    expect(streamPayloads).toEqual(
      expect.arrayContaining([
        {
          type: "event",
          event: {
            type: "thinking",
            text: "Codex stream disconnected before completion. Retrying in 1 second (1/1)...",
          },
        },
        {
          type: "summary",
          finalResponse: "Recovered",
          usage: undefined,
          threadId: "thr-stream-disconnect-1",
        },
      ]),
    );
  });

  it("keeps stderr tail out of user-facing stream disconnect errors", async () => {
    process.env.COCALC_CODEX_STREAM_DISCONNECT_MAX_RETRIES = "0";

    const streamDisconnect =
      "stream disconnected before completion: include request ID fdc4007d-d11f-4707-bd1a-2a06d40c3479";
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-stream-disconnect-no-retry" },
          });
          break;
        case "turn/start": {
          fake.sendResponse(message.id, {
            turn: { id: "turn-stream-disconnect-no-retry" },
          });
          setImmediate(() => {
            fake.stderr.write(
              "apply_patch verification failed: Failed to find expected lines\n",
            );
            fake.sendNotification("turn/started", {
              turn: {
                id: "turn-stream-disconnect-no-retry",
                status: "inProgress",
              },
            });
            fake.sendNotification("error", {
              turnId: "turn-stream-disconnect-no-retry",
              error: { message: streamDisconnect },
            });
            fake.sendNotification("turn/completed", {
              turn: {
                id: "turn-stream-disconnect-no-retry",
                status: "failed",
                error: { message: streamDisconnect },
              },
            });
          });
          break;
        }
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "continue",
      stream: async (payload) => {
        if (payload) streamPayloads.push(payload);
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    const errorPayload = streamPayloads.find(
      (payload) => payload.type === "error",
    );
    expect(errorPayload?.error).toContain(
      "stream disconnected before completion",
    );
    expect(errorPayload?.error).not.toContain(
      "apply_patch verification failed",
    );
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "codex app-server evaluate failed",
      expect.objectContaining({
        stderrTail: expect.arrayContaining([
          "apply_patch verification failed: Failed to find expected lines",
        ]),
      }),
    );
  });

  it("retries bare timeout failures after terminal start without output", async () => {
    process.env.COCALC_CODEX_TIMEOUT_MAX_RETRIES = "1";
    process.env.COCALC_CODEX_TIMEOUT_RETRY_DELAY_MS = "1000";

    let spawnCount = 0;
    const makeProc = (spawn: number) =>
      new FakeCodexAppServerProc((fake, message) => {
        switch (message.method) {
          case "initialize":
            fake.sendResponse(message.id, { ok: true });
            break;
          case "thread/start":
            fake.sendResponse(message.id, {
              thread: { id: "thr-timeout-side-effects-1" },
            });
            break;
          case "turn/start": {
            const turnId = `turn-timeout-side-effects-${spawn}`;
            fake.sendResponse(message.id, { turn: { id: turnId } });
            setImmediate(() => {
              fake.sendNotification("turn/started", {
                turn: { id: turnId, status: "inProgress" },
              });
              if (spawn === 1) {
                fake.sendNotification("item/started", {
                  threadId: "thr-timeout-side-effects-1",
                  turnId,
                  item: {
                    type: "commandExecution",
                    id: "cmd-timeout-side-effects-1",
                    command: "sleep 60",
                    cwd: "/tmp/project",
                    processId: null,
                    status: "inProgress",
                    commandActions: [],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                  },
                });
                fake.sendNotification("error", {
                  turnId,
                  error: { message: "timeout" },
                });
                fake.sendNotification("turn/completed", {
                  turn: {
                    id: turnId,
                    status: "failed",
                    error: { message: "timeout" },
                  },
                });
              } else {
                fake.sendNotification("item/agentMessage/delta", {
                  threadId: "thr-timeout-side-effects-1",
                  turnId,
                  itemId: "msg-timeout-side-effects-1",
                  delta: "Recovered",
                });
                fake.sendNotification("turn/completed", {
                  turn: { id: turnId, status: "completed" },
                });
              }
            });
            break;
          }
          default:
            if (typeof message.id === "number") {
              fake.sendResponse(message.id, {});
            }
        }
      });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: makeProc(++spawnCount) as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "continue",
      stream: async (payload) => {
        if (payload) streamPayloads.push(payload);
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(spawnCount).toBe(2);
    expect(streamPayloads).toEqual(
      expect.arrayContaining([
        {
          type: "event",
          event: {
            type: "thinking",
            text: "Codex returned a transient timeout. Retrying in 1 second (1/1)... If this repeats, check the project-host ACP logs.",
          },
        },
        {
          type: "summary",
          finalResponse: "Recovered",
          usage: undefined,
          threadId: "thr-timeout-side-effects-1",
        },
      ]),
    );
  });

  it("adds timeout guidance after retries are exhausted", async () => {
    process.env.COCALC_CODEX_TIMEOUT_MAX_RETRIES = "1";
    process.env.COCALC_CODEX_TIMEOUT_RETRY_DELAY_MS = "1000";

    let spawnCount = 0;
    const makeProc = () =>
      new FakeCodexAppServerProc((fake, message) => {
        switch (message.method) {
          case "initialize":
            fake.sendResponse(message.id, { ok: true });
            break;
          case "thread/start":
            fake.sendResponse(message.id, {
              thread: { id: `thr-timeout-${spawnCount}` },
            });
            break;
          case "turn/start": {
            const turnId = `turn-timeout-${spawnCount}`;
            fake.sendResponse(message.id, { turn: { id: turnId } });
            setImmediate(() => {
              fake.sendNotification("turn/started", {
                turn: { id: turnId, status: "inProgress" },
              });
              fake.sendNotification("error", {
                turnId,
                error: { message: "timeout" },
              });
              fake.sendNotification("turn/completed", {
                turn: {
                  id: turnId,
                  status: "failed",
                  error: { message: "timeout" },
                },
              });
            });
            break;
          }
          default:
            if (typeof message.id === "number") {
              fake.sendResponse(message.id, {});
            }
        }
      });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => {
        spawnCount += 1;
        return {
          proc: makeProc() as any,
          cmd: "fake-codex",
          args: ["app-server"],
          cwd: "/tmp/project",
        };
      },
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "continue",
      stream: async (payload) => {
        if (payload) streamPayloads.push(payload);
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(spawnCount).toBe(2);
    const errorPayload = streamPayloads.find(
      (payload) => payload.type === "error",
    );
    expect(errorPayload?.error).toContain(
      "Codex kept returning a transient timeout after automatic retries.",
    );
    expect(errorPayload?.error).toContain(
      "Check the project-host ACP logs for the failed turn payload and stderr tail",
    );
  });

  it("resumes the actual Codex thread when repeated turns use the chat-thread alias", async () => {
    const appServerCalls: Array<{
      spawn: number;
      method: string;
      params: any;
    }> = [];
    let spawnCount = 0;

    const makeProc = (spawn: number) =>
      new FakeCodexAppServerProc((fake, message) => {
        appServerCalls.push({
          spawn,
          method: message.method,
          params: message.params,
        });
        switch (message.method) {
          case "initialize":
            fake.sendResponse(message.id, { ok: true });
            break;
          case "thread/start":
            fake.sendResponse(message.id, {
              thread: { id: "thr-live-1" },
            });
            break;
          case "thread/resume":
            if (spawn === 1) {
              fake.stdout.write(
                `${JSON.stringify({
                  id: message.id,
                  error: { message: "thread not found" },
                })}\n`,
              );
            } else {
              fake.sendResponse(message.id, {
                thread: { id: message.params?.threadId ?? "thr-live-1" },
              });
            }
            break;
          case "turn/start": {
            const turnId = `turn-${spawn}`;
            fake.sendResponse(message.id, { turn: { id: turnId } });
            setImmediate(() => {
              fake.sendNotification("turn/started", {
                turn: { id: turnId, status: "inProgress" },
              });
              fake.sendNotification("item/agentMessage/delta", {
                threadId: "thr-live-1",
                turnId,
                itemId: `msg-${spawn}`,
                delta: `hello-${spawn}`,
              });
              fake.sendNotification("item/completed", {
                threadId: "thr-live-1",
                turnId,
                item: {
                  type: "agentMessage",
                  id: `msg-${spawn}`,
                  text: `hello-${spawn}`,
                  phase: null,
                },
              });
              fake.sendNotification("turn/completed", {
                turn: { id: turnId, status: "completed" },
              });
            });
            break;
          }
          default:
            if (typeof message.id === "number") {
              fake.sendResponse(message.id, {});
            }
        }
      });

    const setAgentSessionKey = jest.fn(async () => {});
    const spawnCodexAppServer = jest.fn(async () => ({
      proc: makeProc(++spawnCount) as any,
      cmd: "fake-codex",
      args: ["app-server"],
      cwd: "/tmp/project",
      setAgentSessionKey,
    }));
    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer,
    });

    const agent = new CodexAppServerAgent();
    const baseRequest = {
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      session_id: "chat-thread-1",
      config: {
        workingDirectory: "/tmp/project",
      } as any,
      chat: {
        project_id: "00000000-0000-4000-8000-000000000000",
        path: "research.chat",
        message_date: "2026-08-14T12:00:00.001Z",
        user_message_date: "2026-08-14T12:00:00.000Z",
        sender_id: "00000000-0000-4000-8000-000000000001",
        thread_id: "research-thread",
      },
      stream: async () => {},
    };

    await agent.evaluate({
      ...baseRequest,
      prompt: "first turn",
    });
    await agent.evaluate({
      ...baseRequest,
      prompt: "second turn",
      chat: {
        ...baseRequest.chat,
        message_date: "2026-08-14T12:05:00.001Z",
        user_message_date: "2026-08-14T12:05:00.000Z",
      },
    });

    expect(
      appServerCalls.filter((call) => call.method === "thread/start"),
    ).toHaveLength(1);
    expect(
      appServerCalls.filter((call) => call.method === "thread/resume"),
    ).toEqual([
      expect.objectContaining({
        spawn: 1,
        params: expect.objectContaining({
          threadId: "chat-thread-1",
        }),
      }),
    ]);
    expect(spawnCount).toBe(1);
    expect(spawnCodexAppServer).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionKey: "research-thread\u00002026-08-14T12:00:00.000Z",
      }),
    );
    expect(setAgentSessionKey).toHaveBeenCalledWith(
      "research-thread\u00002026-08-14T12:05:00.000Z",
    );
  });

  it("reports and retains background terminals and subagents after a turn", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const outstandingWorkChanged = jest.fn();
    const proc = new FakeCodexAppServerProc((fake, message) => {
      requests.push({ method: message.method, params: message.params });
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, { thread: { id: "thr-background" } });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-background" } });
          setImmediate(() => {
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-background", status: "completed" },
            });
          });
          break;
        case "thread/backgroundTerminals/list":
          fake.sendResponse(message.id, {
            data: [
              {
                itemId: "item-build",
                processId: "42",
                command: "pnpm build",
                cwd: "/tmp/project",
              },
            ],
            nextCursor: null,
          });
          break;
        case "thread/list":
          fake.sendResponse(message.id, {
            data: [
              {
                id: "thr-child-background",
                parentThreadId: "thr-background",
                status: { type: "active", activeFlags: ["waiting"] },
              },
            ],
            nextCursor: null,
          });
          break;
        case "thread/read":
          fake.sendResponse(message.id, {
            thread: {
              id: "thr-child-background",
              turns: [{ id: "turn-child", status: "inProgress" }],
            },
          });
          break;
        default:
          if (typeof message.id === "number") fake.sendResponse(message.id, {});
      }
    });
    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });
    const agent = new CodexAppServerAgent({
      onOutstandingWorkChanged: outstandingWorkChanged,
    });

    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      session_id: "chat-background",
      prompt: "start a build",
      stream: async () => {},
      config: { workingDirectory: "/tmp/project" },
    });

    expect(agent.getRuntimeStatus()).toEqual({
      liveRuntimes: 1,
      activeTurns: 0,
      backgroundTerminals: 1,
      activeDescendants: 1,
    });
    expect(outstandingWorkChanged).toHaveBeenCalledWith({
      sessionId: "chat-background",
      projectId: "00000000-0000-4000-8000-000000000000",
      accountId: "00000000-0000-4000-8000-000000000001",
      chat: undefined,
      managerState: "completed",
      activeDescendantThreadIds: ["thr-child-background"],
      activeDescendants: 1,
      backgroundTerminals: 1,
      maxConcurrentSubagents: undefined,
    });
    await expect(
      agent.evaluate({
        project_id: "00000000-0000-4000-8000-000000000000",
        account_id: "00000000-0000-4000-8000-000000000001",
        session_id: "chat-background",
        prompt: "continue managing the outstanding work",
        stream: async () => {},
        config: {
          workingDirectory: "/tmp/project",
          maxConcurrentSubagents: 10,
        },
      }),
    ).resolves.toBeUndefined();
    expect(
      requests.filter(({ method }) => method === "initialize"),
    ).toHaveLength(1);
    expect(
      requests.filter(({ method }) => method === "turn/start"),
    ).toHaveLength(2);
    expect(proc.killed).toBe(false);
    await expect(agent.interruptOutstanding("chat-background")).resolves.toBe(
      true,
    );
    expect(requests).toEqual(
      expect.arrayContaining([
        {
          method: "turn/interrupt",
          params: {
            threadId: "thr-child-background",
            turnId: "turn-child",
          },
        },
        {
          method: "thread/backgroundTerminals/clean",
          params: { threadId: "chat-background" },
        },
        {
          method: "thread/backgroundTerminals/clean",
          params: { threadId: "thr-child-background" },
        },
      ]),
    );
    expect(proc.killed).toBe(false);
    await agent.dispose();
    expect(proc.killed).toBe(true);
  });

  it("never replaces an established session when resume fails", async () => {
    const appServerCalls: string[] = [];
    const proc = new FakeCodexAppServerProc((fake, message) => {
      appServerCalls.push(message.method);
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/resume":
          fake.stdout.write(
            `${JSON.stringify({
              id: message.id,
              error: { message: "thread not found" },
            })}\n`,
          );
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      session_id: "chat-thread-established",
      prompt: "continue",
      stream: async (payload) => {
        if (payload) streamPayloads.push(payload);
      },
      config: {
        workingDirectory: "/tmp/project",
        sessionId: "thr-established",
      } as any,
    });

    expect(appServerCalls).toContain("thread/resume");
    expect(appServerCalls).not.toContain("thread/start");
    expect(
      streamPayloads.find((payload) => payload.type === "error")?.error,
    ).toContain("did not start a replacement session");
  });

  it("turns completed app-server file changes into diff activity events", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-file-diff-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-file-diff-1" } });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-file-diff-1", status: "inProgress" },
            });
            fake.sendNotification("item/completed", {
              threadId: "thr-file-diff-1",
              turnId: "turn-file-diff-1",
              item: {
                type: "fileChange",
                id: "file-change-1",
                status: "completed",
                changes: [
                  {
                    path: "src/app.ts",
                    kind: { type: "update", movePath: null },
                    diff: [
                      "--- a/src/app.ts",
                      "+++ b/src/app.ts",
                      "@@ -1 +1 @@",
                      "-const x = 1;",
                      "+const x = 2;",
                    ].join("\n"),
                  },
                ],
              },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-file-diff-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "change a file",
      stream: async (payload) => {
        if (payload) {
          streamPayloads.push(payload);
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(streamPayloads).toEqual(
      expect.arrayContaining([
        {
          type: "event",
          event: {
            type: "diff",
            path: "src/app.ts",
            diff: {
              lines: ["const x = 1;", "const x = 2;"],
              types: [-1, 1],
              gutters: ["     1         -", "            1  +"],
              chunkBoundaries: [1],
            },
          },
        },
      ]),
    );
    expect(
      streamPayloads.some(
        (payload) =>
          payload?.type === "event" && payload?.event?.type === "file",
      ),
    ).toBe(false);
  });

  it("turns in-progress app-server file changes into live diff activity events", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-file-diff-live-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, {
            turn: { id: "turn-file-diff-live-1" },
          });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-file-diff-live-1", status: "inProgress" },
            });
            fake.sendNotification("item/started", {
              threadId: "thr-file-diff-live-1",
              turnId: "turn-file-diff-live-1",
              item: {
                type: "fileChange",
                id: "file-change-live-1",
                status: "inProgress",
                changes: [
                  {
                    path: "primes.py",
                    kind: { type: "add" },
                    diff: [
                      "def count_primes_up_to(n):",
                      "    return 0",
                      "",
                    ].join("\n"),
                  },
                ],
              },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-file-diff-live-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "create a file",
      stream: async (payload) => {
        if (payload) {
          streamPayloads.push(payload);
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(streamPayloads).toEqual(
      expect.arrayContaining([
        {
          type: "event",
          event: {
            type: "diff",
            path: "primes.py",
            diff: {
              lines: ["def count_primes_up_to(n):", "    return 0"],
              types: [1, 1],
              gutters: ["            1  +", "            2  +"],
              chunkBoundaries: [1],
            },
          },
        },
      ]),
    );
  });

  it("falls back to the turn diff snapshot when file changes never complete", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-turn-diff-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-turn-diff-1" } });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-turn-diff-1", status: "inProgress" },
            });
            fake.sendNotification("turn/diff/updated", {
              threadId: "thr-turn-diff-1",
              turnId: "turn-turn-diff-1",
              diff: [
                "diff --git a/primes.py b/primes.py",
                "new file mode 100644",
                "index 0000000..1111111",
                "--- /dev/null",
                "+++ b/primes.py",
                "@@ -0,0 +1,3 @@",
                "+def count_primes_up_to(n):",
                "+    return 0",
                "+",
              ].join("\n"),
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-turn-diff-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "create a file",
      stream: async (payload) => {
        if (payload) {
          streamPayloads.push(payload);
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(streamPayloads).toEqual(
      expect.arrayContaining([
        {
          type: "event",
          event: {
            type: "diff",
            path: "primes.py",
            diff: {
              lines: ["def count_primes_up_to(n):", "    return 0", ""],
              types: [1, 1, 1],
              gutters: [
                "            1  +",
                "            2  +",
                "            3  +",
              ],
              chunkBoundaries: [2],
            },
          },
        },
      ]),
    );
  });

  it("does not duplicate turn diff fallback when completed file changes use absolute paths", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-turn-diff-dup-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, {
            turn: { id: "turn-turn-diff-dup-1" },
          });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-turn-diff-dup-1", status: "inProgress" },
            });
            fake.sendNotification("item/completed", {
              threadId: "thr-turn-diff-dup-1",
              turnId: "turn-turn-diff-dup-1",
              item: {
                type: "fileChange",
                id: "file-change-1",
                status: "completed",
                changes: [
                  {
                    path: "/tmp/project/squares.py",
                    kind: { type: "add" },
                    diff: 'print("hi")\n',
                  },
                ],
              },
            });
            fake.sendNotification("turn/diff/updated", {
              threadId: "thr-turn-diff-dup-1",
              turnId: "turn-turn-diff-dup-1",
              diff: [
                "diff --git a/squares.py b/squares.py",
                "new file mode 100644",
                "index 0000000..1111111",
                "--- /dev/null",
                "+++ b/squares.py",
                "@@ -0,0 +1 @@",
                '+print("hi")',
              ].join("\n"),
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-turn-diff-dup-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "create a file",
      stream: async (payload) => {
        if (payload) {
          streamPayloads.push(payload);
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    const squaresDiffEvents = streamPayloads.filter(
      (payload) =>
        payload?.type === "event" &&
        payload?.event?.type === "diff" &&
        (payload?.event?.path === "/tmp/project/squares.py" ||
          payload?.event?.path === "squares.py"),
    );

    expect(squaresDiffEvents).toHaveLength(1);
    expect(squaresDiffEvents[0]?.event?.path).toBe("/tmp/project/squares.py");
  });

  it("sends local images as LocalImage turn inputs", async () => {
    let turnStartParams: any;
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-images-1" },
          });
          break;
        case "turn/start":
          turnStartParams = message.params;
          fake.sendResponse(message.id, { turn: { id: "turn-images-1" } });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-images-1", status: "inProgress" },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-images-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "read the attached image",
      local_images: ["/tmp/one.png", "/tmp/two.png"],
      stream: async () => {},
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(turnStartParams?.input).toEqual([
      { type: "localImage", path: "/tmp/one.png" },
      { type: "localImage", path: "/tmp/two.png" },
      {
        type: "text",
        text: "read the attached image",
        textElements: [],
      },
    ]);
  });

  it("passes merged runtime env to turn/start and prompt guidance", async () => {
    let turnStartParams: any;
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-runtime-env-1" },
          });
          break;
        case "turn/start":
          turnStartParams = message.params;
          fake.sendResponse(message.id, {
            turn: { id: "turn-runtime-env-1" },
          });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-runtime-env-1", status: "inProgress" },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-runtime-env-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
        runtimeEnv: {
          COCALC_CLI_CMD: '"/root/.local/bin/cocalc"',
          COCALC_CLI_BIN: "/root/.local/bin/cocalc",
          COCALC_BEARER_TOKEN: "project-token",
          COCALC_AGENT_TOKEN: "project-token",
          PATH: "/root/.local/bin:/usr/bin",
        },
        appServerLogin: {
          type: "apiKey",
          apiKey: "site-key",
        },
      }),
    });

    const agent = new CodexAppServerAgent();
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "add a notebook cell",
      runtime_env: {
        COCALC_PROJECT_ID: "00000000-0000-4000-8000-000000000000",
        COCALC_BROWSER_ID: "browser-1",
        COCALC_API_URL: "https://lite3.cocalc.ai",
      },
      stream: async () => {},
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(turnStartParams?.env).toMatchObject({
      COCALC_PROJECT_ID: "00000000-0000-4000-8000-000000000000",
      COCALC_BROWSER_ID: "browser-1",
      COCALC_API_URL: "https://lite3.cocalc.ai",
      COCALC_CLI_CMD: '"/root/.local/bin/cocalc"',
      COCALC_CLI_BIN: "/root/.local/bin/cocalc",
      COCALC_BEARER_TOKEN: "project-token",
      COCALC_AGENT_TOKEN: "project-token",
      PATH: "/root/.local/bin:/usr/bin",
    });
    expect(turnStartParams?.approvalPolicy).toBe("never");
    expect(turnStartParams?.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: [],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(turnStartParams?.input?.[0]?.text).toContain(
      'When you need the CoCalc CLI, use this exact command: `"/root/.local/bin/cocalc"`.',
    );
    expect(turnStartParams?.input?.[0]?.text).toContain(
      "For live text editor content or edits, prefer backend exec with the live sync/session API",
    );
    expect(turnStartParams?.input?.[0]?.text).toContain(
      "api.text.open({ path:",
    );
    expect(turnStartParams?.input?.[0]?.text).toContain(
      "write/append/replace methods save to disk by default",
    );
    expect(turnStartParams?.input?.[0]?.text).toContain(
      "Project secret changes apply immediately to running projects",
    );
    expect(turnStartParams?.input?.[0]?.text).toContain(
      "browser files --project-id",
    );
  });

  it("adds project guidance without browser-only guidance", async () => {
    let turnStartParams: any;
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-project-guidance-1" },
          });
          break;
        case "turn/start":
          turnStartParams = message.params;
          fake.sendResponse(message.id, {
            turn: { id: "turn-project-guidance-1" },
          });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-project-guidance-1", status: "inProgress" },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-project-guidance-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
        runtimeEnv: {
          COCALC_CLI_CMD:
            '"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"',
        },
      }),
    });

    const agent = new CodexAppServerAgent();
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "build the paper",
      runtime_env: {
        COCALC_PROJECT_ID: "00000000-0000-4000-8000-000000000000",
        COCALC_API_URL: "https://lite3.cocalc.ai",
      },
      stream: async () => {},
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    const text = turnStartParams?.input?.[0]?.text;
    expect(text).toContain("project build -h");
    expect(text).toContain("project build <path>");
    expect(text).toContain("complete editor pipeline");
    expect(text).not.toContain("COCALC_BROWSER_ID");
    expect(text).not.toContain("browser files --project-id");
    expect(text).not.toContain("browser workspace-state");
    expect(text).toContain("build the paper");
  });

  it("passes full-access sandbox policy to turn/start", async () => {
    let turnStartParams: any;
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-full-access-1" },
          });
          break;
        case "turn/start":
          turnStartParams = message.params;
          fake.sendResponse(message.id, {
            turn: { id: "turn-full-access-1" },
          });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-full-access-1", status: "inProgress" },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-full-access-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "commit the change",
      stream: async () => {},
      config: {
        workingDirectory: "/tmp/project",
        sessionMode: "full-access",
      } as any,
    });

    expect(turnStartParams?.approvalPolicy).toBe("never");
    expect(turnStartParams?.sandboxPolicy).toEqual({
      type: "dangerFullAccess",
    });
  });

  it("uses full-access sandboxing for container-backed sessions by default", async () => {
    let threadStartParams: any;
    let turnStartParams: any;
    const rootHostPath = mkdtempSync(path.join(tmpdir(), "codex-home-"));
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          threadStartParams = message.params;
          fake.sendResponse(message.id, {
            thread: { id: "thr-container-1" },
          });
          break;
        case "turn/start":
          turnStartParams = message.params;
          fake.sendResponse(message.id, {
            turn: { id: "turn-container-1" },
          });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-container-1", status: "inProgress" },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-container-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    try {
      setCodexProjectSpawner({
        spawnCodexExec: async () => {
          throw new Error("unexpected codex exec spawn");
        },
        spawnCodexAppServer: async () => ({
          proc: proc as any,
          cmd: "fake-codex",
          args: ["app-server"],
          cwd: "/home/user/cocalc-ai",
          containerPathMap: {
            rootHostPath,
          },
        }),
      });

      const agent = new CodexAppServerAgent();
      await agent.evaluate({
        project_id: "00000000-0000-4000-8000-000000000000",
        account_id: "00000000-0000-4000-8000-000000000001",
        prompt: "commit the change",
        stream: async () => {},
        config: {
          workingDirectory: "/home/user/cocalc-ai",
        } as any,
      });
    } finally {
      rmSync(rootHostPath, { recursive: true, force: true });
    }

    expect(threadStartParams?.approvalPolicy).toBe("never");
    expect(threadStartParams?.sandbox).toBe("danger-full-access");
    expect(turnStartParams?.approvalPolicy).toBe("never");
    expect(turnStartParams?.sandboxPolicy).toEqual({
      type: "dangerFullAccess",
    });
  });

  it("passes resume overrides without rewriting the rollout", async () => {
    const originalCodexHome = process.env.COCALC_CODEX_HOME;
    const codexHome = mkdtempSync(path.join(tmpdir(), "codex-home-"));
    const sessionId = "019d0000-0000-7000-8000-000000000001";
    const sessionDir = path.join(codexHome, "sessions", "2026", "04", "08");
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(
      sessionDir,
      `rollout-2026-04-08T00-00-00-${sessionId}.jsonl`,
    );
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        timestamp: "2026-04-08T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: sessionId,
          cwd: "/tmp/old-project",
          approval_policy: "never",
          sandbox_policy: {
            type: "workspace-write",
            network_access: true,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
          },
        },
      })}\n`,
      "utf8",
    );
    process.env.COCALC_CODEX_HOME = codexHome;

    let persistedMeta: any;
    let resumeParams: any;
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/resume":
          resumeParams = message.params;
          persistedMeta = JSON.parse(
            readFileSync(sessionFile, "utf8").split("\n")[0],
          );
          fake.sendResponse(message.id, {
            thread: { id: sessionId },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, {
            turn: { id: "turn-resume-1" },
          });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-resume-1", status: "inProgress" },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-resume-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    try {
      setCodexProjectSpawner({
        spawnCodexExec: async () => {
          throw new Error("unexpected codex exec spawn");
        },
        spawnCodexAppServer: async () => ({
          proc: proc as any,
          cmd: "fake-codex",
          args: ["app-server"],
          cwd: "/tmp/project",
        }),
      });

      const agent = new CodexAppServerAgent();
      await agent.evaluate({
        project_id: "00000000-0000-4000-8000-000000000000",
        account_id: "00000000-0000-4000-8000-000000000001",
        prompt: "commit the change",
        stream: async () => {},
        config: {
          sessionId,
          workingDirectory: "/tmp/project",
          sessionMode: "full-access",
        } as any,
      });
    } finally {
      if (originalCodexHome == null) {
        delete process.env.COCALC_CODEX_HOME;
      } else {
        process.env.COCALC_CODEX_HOME = originalCodexHome;
      }
      rmSync(codexHome, { recursive: true, force: true });
    }

    expect(persistedMeta?.payload?.cwd).toBe("/tmp/old-project");
    expect(resumeParams).toMatchObject({
      threadId: sessionId,
      cwd: "/tmp/project",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      excludeTurns: true,
    });
  });

  it("passes container resume overrides without rewriting the rollout", async () => {
    const rootHostPath = mkdtempSync(path.join(tmpdir(), "codex-home-"));
    const sessionId = "019d0000-0000-7000-8000-000000000002";
    const sessionDir = path.join(
      rootHostPath,
      ".codex",
      "sessions",
      "2026",
      "04",
      "08",
    );
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(
      sessionDir,
      `rollout-2026-04-08T00-00-00-${sessionId}.jsonl`,
    );
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        timestamp: "2026-04-08T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: sessionId,
          cwd: "/tmp/old-project",
          approval_policy: "never",
          sandbox_policy: {
            type: "workspace-write",
            network_access: true,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
          },
        },
      })}\n`,
      "utf8",
    );

    let persistedMeta: any;
    let resumeParams: any;
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/resume":
          resumeParams = message.params;
          persistedMeta = JSON.parse(
            readFileSync(sessionFile, "utf8").split("\n")[0],
          );
          fake.sendResponse(message.id, {
            thread: { id: sessionId },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, {
            turn: { id: "turn-container-resume-1" },
          });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-container-resume-1", status: "inProgress" },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-container-resume-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    try {
      setCodexProjectSpawner({
        spawnCodexExec: async () => {
          throw new Error("unexpected codex exec spawn");
        },
        spawnCodexAppServer: async () => ({
          proc: proc as any,
          cmd: "fake-codex",
          args: ["app-server"],
          cwd: "/home/user/cocalc-ai",
          containerPathMap: {
            rootHostPath,
          },
        }),
      });

      const agent = new CodexAppServerAgent();
      await agent.evaluate({
        project_id: "00000000-0000-4000-8000-000000000000",
        account_id: "00000000-0000-4000-8000-000000000001",
        prompt: "commit the change",
        stream: async () => {},
        config: {
          sessionId,
          workingDirectory: "/home/user/cocalc-ai",
          sessionMode: "full-access",
        } as any,
      });
    } finally {
      rmSync(rootHostPath, { recursive: true, force: true });
    }

    expect(persistedMeta?.payload?.cwd).toBe("/tmp/old-project");
    expect(resumeParams).toMatchObject({
      threadId: sessionId,
      cwd: "/home/user/cocalc-ai",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      excludeTurns: true,
    });
  });

  it("resumes container-backed sessions with full access by default", async () => {
    const rootHostPath = mkdtempSync(path.join(tmpdir(), "codex-home-"));
    const sessionId = "019d0000-0000-7000-8000-000000000003";
    const sessionDir = path.join(
      rootHostPath,
      ".codex",
      "sessions",
      "2026",
      "04",
      "08",
    );
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(
      sessionDir,
      `rollout-2026-04-08T00-00-00-${sessionId}.jsonl`,
    );
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        timestamp: "2026-04-08T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: sessionId,
          cwd: "/tmp/old-project",
          approval_policy: "never",
          sandbox_policy: {
            type: "workspace-write",
            network_access: true,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
          },
        },
      })}\n`,
      "utf8",
    );

    let persistedMeta: any;
    let resumeParams: any;
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/resume":
          resumeParams = message.params;
          persistedMeta = JSON.parse(
            readFileSync(sessionFile, "utf8").split("\n")[0],
          );
          fake.sendResponse(message.id, {
            thread: { id: sessionId },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, {
            turn: { id: "turn-container-resume-2" },
          });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-container-resume-2", status: "inProgress" },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-container-resume-2", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    try {
      setCodexProjectSpawner({
        spawnCodexExec: async () => {
          throw new Error("unexpected codex exec spawn");
        },
        spawnCodexAppServer: async () => ({
          proc: proc as any,
          cmd: "fake-codex",
          args: ["app-server"],
          cwd: "/home/user/cocalc-ai",
          containerPathMap: {
            rootHostPath,
          },
        }),
      });

      const agent = new CodexAppServerAgent();
      await agent.evaluate({
        project_id: "00000000-0000-4000-8000-000000000000",
        account_id: "00000000-0000-4000-8000-000000000001",
        prompt: "commit the change",
        stream: async () => {},
        config: {
          sessionId,
          workingDirectory: "/home/user/cocalc-ai",
        } as any,
      });
    } finally {
      rmSync(rootHostPath, { recursive: true, force: true });
    }

    expect(persistedMeta?.payload?.cwd).toBe("/tmp/old-project");
    expect(resumeParams).toMatchObject({
      threadId: sessionId,
      cwd: "/home/user/cocalc-ai",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      excludeTurns: true,
    });
  });

  it("answers server auth-refresh requests during a turn", async () => {
    const refreshResponses: any[] = [];
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "account/login/start":
          fake.sendResponse(message.id, { type: "chatgptAuthTokens" });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-refresh-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-refresh-1" } });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-refresh-1", status: "inProgress" },
            });
            fake.sendRequest(91, "account/chatgptAuthTokens/refresh", {
              reason: "unauthorized",
              previousAccountId: "workspace-123",
            });
          });
          break;
        default:
          if (message.id === 91 && !message.method) {
            refreshResponses.push(message);
            setImmediate(() => {
              fake.sendNotification("item/agentMessage/delta", {
                threadId: "thr-refresh-1",
                turnId: "turn-refresh-1",
                itemId: "msg-refresh-1",
                delta: "Refreshed",
              });
              fake.sendNotification("turn/completed", {
                turn: { id: "turn-refresh-1", status: "completed" },
              });
            });
            return;
          }
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
        appServerLogin: {
          type: "chatgptAuthTokens",
          accessToken: "initial-token",
          chatgptAccountId: "workspace-123",
          chatgptPlanType: "pro",
        },
        handleAppServerRequest: async ({ method, params }) => {
          expect(method).toBe("account/chatgptAuthTokens/refresh");
          expect(params).toEqual({
            reason: "unauthorized",
            previousAccountId: "workspace-123",
          });
          return {
            accessToken: "refreshed-token",
            chatgptAccountId: "workspace-123",
            chatgptPlanType: "pro",
          };
        },
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "say hello",
      stream: async (payload) => {
        if (payload) {
          streamPayloads.push(payload);
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    expect(refreshResponses).toEqual([
      {
        id: 91,
        result: {
          accessToken: "refreshed-token",
          chatgptAccountId: "workspace-123",
          chatgptPlanType: "pro",
        },
      },
    ]);
    expect(streamPayloads).toEqual(
      expect.arrayContaining([
        {
          type: "summary",
          finalResponse: "Refreshed",
          usage: undefined,
          threadId: "thr-refresh-1",
        },
      ]),
    );
  });

  it("treats an intentional interrupt as a normal completion", async () => {
    let interrupted = false;
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-interrupt-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-interrupt-1" } });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-interrupt-1", status: "inProgress" },
            });
          });
          break;
        case "turn/interrupt":
          interrupted = true;
          fake.sendResponse(message.id, {});
          setImmediate(() => {
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-interrupt-1", status: "interrupted" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const streamPayloads: any[] = [];
    const pending = agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "interrupt me",
      stream: async (payload) => {
        if (payload) {
          streamPayloads.push(payload);
          if (payload.type === "status" && payload.state === "running") {
            setImmediate(() => {
              void agent.interrupt("thr-interrupt-1");
            });
          }
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    await expect(pending).resolves.toBeUndefined();
    expect(interrupted).toBe(true);
    expect(
      streamPayloads.find((payload) => payload.type === "error"),
    ).toBeUndefined();
  });

  it("interrupts a turn without killing its retained app-server", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-interrupt-wait-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, {
            turn: { id: "turn-interrupt-wait-1" },
          });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-interrupt-wait-1", status: "inProgress" },
            });
          });
          break;
        case "turn/interrupt":
          fake.sendResponse(message.id, {});
          setImmediate(() => {
            fake.sendNotification("turn/completed", {
              turn: {
                id: "turn-interrupt-wait-1",
                status: "interrupted",
              },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });
    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const pending = agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "interrupt me",
      stream: async () => {},
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    await expect(agent.interrupt("thr-interrupt-wait-1")).resolves.toBe(true);
    await expect(pending).resolves.toBeUndefined();
    expect(proc.killed).toBe(false);
    await agent.dispose();
    expect(proc.killed).toBe(true);
  });

  it("steers an active app-server turn without interrupting it", async () => {
    const steerRequests: any[] = [];
    let steerPromise: Promise<any> | undefined;
    let requested = false;
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-steer-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-steer-1" } });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-steer-1", status: "inProgress" },
            });
          });
          break;
        case "turn/steer":
          steerRequests.push(message.params);
          fake.sendResponse(message.id, { turnId: "turn-steer-1" });
          setImmediate(() => {
            fake.sendNotification("item/completed", {
              threadId: "thr-steer-1",
              turnId: "turn-steer-1",
              item: {
                type: "agentMessage",
                id: "msg-steer-1",
                text: "done",
                phase: null,
              },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-steer-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const pending = agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "keep working",
      stream: async (payload) => {
        if (
          !requested &&
          payload?.type === "status" &&
          payload.state === "running"
        ) {
          requested = true;
          steerPromise = agent.steer("thr-steer-1", {
            project_id: "00000000-0000-4000-8000-000000000000",
            account_id: "00000000-0000-4000-8000-000000000001",
            prompt: "focus on failing tests",
            chat: {
              project_id: "00000000-0000-4000-8000-000000000000",
              path: "x.chat",
              sender_id: "user-1",
              message_date: new Date().toISOString(),
              thread_id: "thread-1",
            },
          });
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    await expect(pending).resolves.toBeUndefined();
    await expect(steerPromise).resolves.toEqual({
      state: "steered",
      threadId: "thr-steer-1",
    });
    expect(steerRequests).toHaveLength(1);
    expect(steerRequests[0]).toMatchObject({
      threadId: "thr-steer-1",
      expectedTurnId: "turn-steer-1",
    });
    expect(steerRequests[0].input[0]).toMatchObject({
      type: "text",
      text: "focus on failing tests",
    });
  });

  it("retries steer once when the active turn id changed", async () => {
    const steerRequests: any[] = [];
    let steerPromise: Promise<any> | undefined;
    let requested = false;
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-steer-race-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-steer-old" } });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-steer-old", status: "inProgress" },
            });
          });
          break;
        case "turn/steer":
          steerRequests.push(message.params);
          if (steerRequests.length === 1) {
            fake.stdout.write(
              `${JSON.stringify({
                id: message.id,
                error: {
                  code: -32600,
                  message:
                    "expected active turn id `turn-steer-old` but found `turn-steer-new`",
                },
              })}\n`,
            );
            break;
          }
          fake.sendResponse(message.id, { turnId: "turn-steer-new" });
          setImmediate(() => {
            fake.sendNotification("item/completed", {
              threadId: "thr-steer-race-1",
              turnId: "turn-steer-old",
              item: {
                type: "agentMessage",
                id: "msg-steer-race-1",
                text: "done",
                phase: null,
              },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-steer-old", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    const agent = new CodexAppServerAgent();
    const pending = agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "keep working",
      stream: async (payload) => {
        if (
          !requested &&
          payload?.type === "status" &&
          payload.state === "running"
        ) {
          requested = true;
          steerPromise = agent.steer("thr-steer-race-1", {
            project_id: "00000000-0000-4000-8000-000000000000",
            account_id: "00000000-0000-4000-8000-000000000001",
            prompt: "actually focus on tests",
            chat: {
              project_id: "00000000-0000-4000-8000-000000000000",
              path: "x.chat",
              sender_id: "user-1",
              message_date: new Date().toISOString(),
              thread_id: "thread-1",
            },
          });
        }
      },
      config: {
        workingDirectory: "/tmp/project",
      } as any,
    });

    await expect(pending).resolves.toBeUndefined();
    await expect(steerPromise).resolves.toEqual({
      state: "steered",
      threadId: "thr-steer-race-1",
    });
    expect(steerRequests).toHaveLength(2);
    expect(steerRequests[0].expectedTurnId).toBe("turn-steer-old");
    expect(steerRequests[1].expectedTurnId).toBe("turn-steer-new");
  });

  it("forks an upstream app-server thread and returns the new thread id", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/fork":
          fake.sendResponse(message.id, {
            thread: { id: "thr-forked-2" },
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
      }),
    });

    await expect(
      forkCodexAppServerSession({
        projectId: "00000000-0000-4000-8000-000000000000",
        accountId: "00000000-0000-4000-8000-000000000001",
        sessionId: "thr-shared-1",
      }),
    ).resolves.toEqual({ sessionId: "thr-forked-2" });
  });

  it("reads account usage status through the project app-server", async () => {
    const seen: Array<{ method: string; params: any }> = [];
    const proc = new FakeCodexAppServerProc((fake, message) => {
      seen.push({ method: message.method, params: message.params });
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, {});
          break;
        case "initialized":
          break;
        case "account/login/start":
          fake.sendResponse(message.id, {});
          break;
        case "account/read":
          fake.sendResponse(message.id, {
            account: {
              type: "chatgpt",
              email: "user@example.com",
              planType: "pro",
            },
            requiresOpenaiAuth: false,
          });
          break;
        case "account/rateLimits/read":
          fake.sendResponse(message.id, {
            rateLimits: {
              limitId: "codex",
              primary: {
                usedPercent: 42,
                windowDurationMins: 300,
                resetsAt: 1_800_000_000,
              },
              planType: "pro",
            },
          });
          break;
        case "account/usage/read":
          fake.sendResponse(message.id, {
            summary: {
              lifetimeTokens: 12345,
            },
          });
          break;
        case "model/list":
          expect(message.params).toEqual({
            limit: 100,
            includeHidden: false,
          });
          fake.sendResponse(message.id, {
            data: [
              {
                id: "gpt-5.6-luna",
                model: "gpt-5.6-luna",
                displayName: "GPT-5.6 Luna",
                description: "Fast account model",
                supportedReasoningEfforts: [
                  {
                    reasoningEffort: "low",
                    description: "Fast responses",
                  },
                  {
                    reasoningEffort: "xhigh",
                    description: "Deep reasoning",
                  },
                ],
                defaultReasoningEffort: "xhigh",
                serviceTiers: [
                  {
                    id: "priority",
                    name: "Priority",
                    description: "Priority processing",
                  },
                ],
                additionalSpeedTiers: ["fast"],
                defaultServiceTier: "fast",
                isDefault: true,
              },
            ],
            nextCursor: null,
          });
          break;
        default:
          throw new Error(`unexpected method ${message.method}`);
      }
    });
    const spawnCodexAppServer = jest.fn(async () => ({
      proc: proc as any,
      args: ["app-server"],
      cmd: "codex",
      appServerLogin: {
        type: "chatgptAuthTokens" as const,
        accessToken: "token",
        chatgptAccountId: "account-1",
        chatgptPlanType: "pro",
      },
    }));
    setCodexProjectSpawner({
      spawnCodexExec: jest.fn() as any,
      spawnCodexAppServer,
    });

    const status = await getCodexAppServerAccountStatus({
      projectId: "project-1",
      accountId: "account-1",
      includeTokenUsage: true,
      includeModels: true,
    });

    expect(spawnCodexAppServer).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        accountId: "account-1",
        touchReason: false,
      }),
    );
    expect(status.errors).toBeUndefined();
    expect(status.authentication).toEqual({ status: "connected" });
    expect(status.account?.account?.email).toBe("user@example.com");
    expect(status.rateLimits?.rateLimits?.primary?.usedPercent).toBe(42);
    expect(status.tokenUsage?.summary?.lifetimeTokens).toBe(12345);
    expect(status.models).toEqual([
      {
        model: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        description: "Fast account model",
        reasoning: [
          {
            id: "low",
            description: "Fast responses",
          },
          {
            id: "extra_high",
            description: "Deep reasoning",
            default: true,
          },
        ],
        serviceTiers: [
          {
            id: "priority",
            label: "Priority",
            description: "Priority processing",
          },
          {
            id: "fast",
            label: "Fast",
            description: "",
            default: true,
          },
        ],
        default: true,
      },
    ]);
    expect(seen.map(({ method }) => method)).toEqual([
      "initialize",
      "initialized",
      "account/login/start",
      "account/read",
      "account/rateLimits/read",
      "account/usage/read",
      "model/list",
    ]);
  });

  it("keeps account status usable when model discovery is unsupported", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, {});
          break;
        case "initialized":
          break;
        case "account/read":
          fake.sendResponse(message.id, {
            account: { type: "chatgpt", planType: "basic" },
            requiresOpenaiAuth: false,
          });
          break;
        case "account/rateLimits/read":
          fake.sendResponse(message.id, { rateLimits: { limitId: "codex" } });
          break;
        case "model/list":
          fake.sendError(message.id, "Method not found: model/list");
          break;
        default:
          throw new Error(`unexpected method ${message.method}`);
      }
    });
    setCodexProjectSpawner({
      spawnCodexExec: jest.fn() as any,
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        args: ["app-server"],
        cmd: "codex",
      }),
    });

    const status = await getCodexAppServerAccountStatus({
      projectId: "project-1",
      accountId: "account-1",
      includeModels: true,
    });

    expect(status.authentication).toEqual({ status: "connected" });
    expect(status.rateLimits).toEqual({ rateLimits: { limitId: "codex" } });
    expect(status.models).toBeUndefined();
    expect(status.errors?.models).toContain("Method not found: model/list");
  });

  it("does not read token usage during the default account status check", async () => {
    const seen: Array<{ method: string; params: any }> = [];
    const proc = new FakeCodexAppServerProc((fake, message) => {
      seen.push({ method: message.method, params: message.params });
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, {});
          break;
        case "initialized":
          break;
        case "account/login/start":
          fake.sendResponse(message.id, {});
          break;
        case "account/read":
          fake.sendResponse(message.id, {
            account: {
              type: "chatgpt",
              email: "user@example.com",
              planType: "pro",
            },
            requiresOpenaiAuth: false,
          });
          break;
        case "account/rateLimits/read":
          fake.sendResponse(message.id, {
            rateLimits: {
              limitId: "codex",
              primary: {
                usedPercent: 42,
                windowDurationMins: 300,
                resetsAt: 1_800_000_000,
              },
              planType: "pro",
            },
          });
          break;
        case "account/usage/read":
          throw new Error("account/usage/read should not be requested");
        default:
          throw new Error(`unexpected method ${message.method}`);
      }
    });
    setCodexProjectSpawner({
      spawnCodexExec: jest.fn() as any,
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        args: ["app-server"],
        cmd: "codex",
        appServerLogin: {
          type: "chatgptAuthTokens" as const,
          accessToken: "token",
          chatgptAccountId: "account-1",
          chatgptPlanType: "pro",
        },
      }),
    });

    const status = await getCodexAppServerAccountStatus({
      projectId: "project-1",
      accountId: "account-1",
    });

    expect(status.errors).toBeUndefined();
    expect(status.account?.account?.email).toBe("user@example.com");
    expect(status.rateLimits?.rateLimits?.primary?.usedPercent).toBe(42);
    expect(status.tokenUsage).toBeUndefined();
    expect(seen.map(({ method }) => method)).toEqual([
      "initialize",
      "initialized",
      "account/login/start",
      "account/read",
      "account/rateLimits/read",
    ]);
  });

  it("reports when stored ChatGPT auth needs a new sign-in", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, {});
          break;
        case "initialized":
          break;
        case "account/login/start":
          fake.sendResponse(message.id, {});
          break;
        case "account/read":
          fake.sendResponse(message.id, {
            account: null,
            requiresOpenaiAuth: true,
          });
          break;
        case "account/rateLimits/read":
          fake.sendError(
            message.id,
            "codex account authentication required to read rate limits",
          );
          break;
        default:
          throw new Error(`unexpected method ${message.method}`);
      }
    });
    setCodexProjectSpawner({
      spawnCodexExec: jest.fn() as any,
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        args: ["app-server"],
        cmd: "codex",
        appServerLogin: {
          type: "chatgptAuthTokens" as const,
          accessToken: "expired-token",
          chatgptAccountId: "account-1",
          chatgptPlanType: "pro",
        },
      }),
    });

    const status = await getCodexAppServerAccountStatus({
      projectId: "project-1",
      accountId: "account-1",
    });

    expect(status.authentication).toEqual({
      status: "needs-sign-in",
      reason: expect.stringContaining("Sign in again"),
    });
  });

  it("keeps a verified account connected when usage is temporarily unavailable", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, {});
          break;
        case "initialized":
          break;
        case "account/login/start":
          fake.sendResponse(message.id, {});
          break;
        case "account/read":
          fake.sendResponse(message.id, {
            account: {
              type: "chatgpt",
              email: "user@example.com",
              planType: "pro",
            },
            requiresOpenaiAuth: true,
          });
          break;
        case "account/rateLimits/read":
          fake.sendError(message.id, "rate limit service unavailable");
          break;
        default:
          throw new Error(`unexpected method ${message.method}`);
      }
    });
    setCodexProjectSpawner({
      spawnCodexExec: jest.fn() as any,
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        args: ["app-server"],
        cmd: "codex",
        appServerLogin: {
          type: "chatgptAuthTokens" as const,
          accessToken: "token",
          chatgptAccountId: "account-1",
          chatgptPlanType: "pro",
        },
      }),
    });

    const status = await getCodexAppServerAccountStatus({
      projectId: "project-1",
      accountId: "account-1",
    });

    expect(status.authentication).toEqual({ status: "connected" });
    expect(status.errors?.rateLimits).toContain("service unavailable");
  });

  it("waits for account token refresh before reading rate limits", async () => {
    const seen: Array<{ method: string; params: any }> = [];
    let accountReads = 0;
    let accountRefreshCompleted = false;
    const proc = new FakeCodexAppServerProc((fake, message) => {
      seen.push({ method: message.method, params: message.params });
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, {});
          break;
        case "initialized":
          break;
        case "account/login/start":
          fake.sendResponse(message.id, {});
          break;
        case "account/read":
          accountReads += 1;
          if (accountReads === 1) {
            fake.sendResponse(message.id, {
              account: {
                type: "chatgpt",
                email: "user@example.com",
                planType: "pro",
              },
              requiresOpenaiAuth: true,
            });
            break;
          }
          expect(message.params).toEqual({ refreshToken: true });
          setImmediate(() => {
            accountRefreshCompleted = true;
            fake.sendResponse(message.id, {
              account: {
                type: "chatgpt",
                email: "user@example.com",
                planType: "pro",
              },
              requiresOpenaiAuth: true,
            });
          });
          break;
        case "account/rateLimits/read":
          if (!accountRefreshCompleted) {
            fake.sendError(
              message.id,
              "codex account authentication required to read rate limits",
            );
            break;
          }
          fake.sendResponse(message.id, {
            rateLimits: {
              limitId: "codex",
              primary: {
                usedPercent: 42,
                windowDurationMins: 300,
                resetsAt: 1_800_000_000,
              },
              planType: "pro",
            },
          });
          break;
        default:
          throw new Error(`unexpected method ${message.method}`);
      }
    });
    setCodexProjectSpawner({
      spawnCodexExec: jest.fn() as any,
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        args: ["app-server"],
        cmd: "codex",
        appServerLogin: {
          type: "chatgptAuthTokens" as const,
          accessToken: "token",
          chatgptAccountId: "account-1",
          chatgptPlanType: "pro",
        },
      }),
    });

    const status = await getCodexAppServerAccountStatus({
      projectId: "project-1",
      accountId: "account-1",
    });

    expect(status.errors).toBeUndefined();
    expect(status.rateLimits?.rateLimits?.primary?.usedPercent).toBe(42);
    expect(seen.map(({ method }) => method)).toEqual([
      "initialize",
      "initialized",
      "account/login/start",
      "account/read",
      "account/rateLimits/read",
      "account/read",
      "account/rateLimits/read",
    ]);
  });

  it("retries rate-limit reads after a stale app-server auth failure", async () => {
    const seen: Array<{ method: string; params: any }> = [];
    let rateLimitReads = 0;
    const proc = new FakeCodexAppServerProc((fake, message) => {
      seen.push({ method: message.method, params: message.params });
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, {});
          break;
        case "initialized":
          break;
        case "account/login/start":
          fake.sendResponse(message.id, {});
          break;
        case "account/read":
          fake.sendResponse(message.id, {
            account: {
              type: "chatgpt",
              email: "user@example.com",
              planType: "pro",
            },
            requiresOpenaiAuth: false,
          });
          break;
        case "account/rateLimits/read":
          rateLimitReads += 1;
          if (rateLimitReads === 1) {
            fake.sendError(
              message.id,
              "codex account authentication required to read rate limits",
            );
          } else {
            fake.sendResponse(message.id, {
              rateLimits: {
                limitId: "codex",
                primary: {
                  usedPercent: 42,
                  windowDurationMins: 300,
                  resetsAt: 1_800_000_000,
                },
                planType: "pro",
              },
            });
          }
          break;
        default:
          throw new Error(`unexpected method ${message.method}`);
      }
    });
    setCodexProjectSpawner({
      spawnCodexExec: jest.fn() as any,
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        args: ["app-server"],
        cmd: "codex",
        appServerLogin: {
          type: "chatgptAuthTokens" as const,
          accessToken: "token",
          chatgptAccountId: "account-1",
          chatgptPlanType: "pro",
        },
      }),
    });

    const status = await getCodexAppServerAccountStatus({
      projectId: "project-1",
      accountId: "account-1",
    });

    expect(status.errors).toBeUndefined();
    expect(status.account?.account?.email).toBe("user@example.com");
    expect(status.rateLimits?.rateLimits?.primary?.usedPercent).toBe(42);
    expect(seen.map(({ method }) => method)).toEqual([
      "initialize",
      "initialized",
      "account/login/start",
      "account/read",
      "account/rateLimits/read",
      "account/read",
      "account/rateLimits/read",
    ]);
  });

  it("reports site-key usage for app-server turns", async () => {
    const checkAllowed = jest.fn(async () => ({ allowed: true }));
    const reportUsage = jest.fn(async () => {});
    getCodexSiteKeyGovernorMock.mockReturnValue({
      pollIntervalMs: 60_000,
      checkAllowed,
      reportUsage,
    });

    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "account/login/start":
          fake.sendResponse(message.id, { type: "apiKey" });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-site-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-site-1" } });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-site-1", status: "inProgress" },
            });
            fake.sendNotification("thread/tokenUsage/updated", {
              threadId: "thr-site-1",
              turnId: "turn-site-1",
              tokenUsage: {
                last: {
                  inputTokens: 12,
                  cachedInputTokens: 3,
                  outputTokens: 5,
                  reasoningOutputTokens: 1,
                  totalTokens: 20,
                },
                total: {
                  inputTokens: 12,
                  cachedInputTokens: 3,
                  outputTokens: 5,
                  reasoningOutputTokens: 1,
                  totalTokens: 20,
                },
                modelContextWindow: 4096,
              },
            });
            fake.sendNotification("item/agentMessage/delta", {
              threadId: "thr-site-1",
              turnId: "turn-site-1",
              itemId: "msg-site-1",
              delta: "Metered",
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-site-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/tmp/project",
        authSource: "site-api-key",
        appServerLogin: {
          type: "apiKey",
          apiKey: "site-key",
        },
      }),
    });

    const agent = new CodexAppServerAgent();
    await agent.evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "say hello",
      stream: async () => {},
      chat: {
        path: "root/demo.chat",
        project_id: "00000000-0000-4000-8000-000000000000",
      } as any,
      config: {
        workingDirectory: "/tmp/project",
        model: "gpt-5.4",
      } as any,
    });

    expect(checkAllowed).toHaveBeenCalledWith({
      accountId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000000",
      model: "gpt-5.4",
      phase: "start",
    });
    expect(reportUsage).toHaveBeenCalledWith({
      accountId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000000",
      model: "gpt-5.4",
      usage: {
        input_tokens: 12,
        cached_input_tokens: 3,
        output_tokens: 5,
        total_tokens: 20,
      },
      totalTimeS: expect.any(Number),
      path: "root/demo.chat",
    });
  });

  it("forces site-funded policy and settles the reservation", async () => {
    const requests: any[] = [];
    const finish = jest.fn(async () => {});
    const proc = new FakeCodexAppServerProc((fake, message) => {
      requests.push(message);
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, { thread: { id: "thr-funded-1" } });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-funded-1" } });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-funded-1", status: "inProgress" },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-funded-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") fake.sendResponse(message.id, {});
      }
    });
    const spawnCodexAppServer = jest.fn(async () => ({
      proc: proc as any,
      cmd: "fake-codex",
      args: ["app-server"],
      cwd: "/tmp/project",
      authSource: "site-api-key",
      siteFundedTurn: {
        reservation: {
          reservationId: "reservation-1",
          fundedTurnId: "funded-turn-1",
          poolId: "site-funded-codex-free" as const,
          policy: DEFAULT_SITE_FUNDED_CODEX_POLICY,
          reservedMicrousd:
            DEFAULT_SITE_FUNDED_CODEX_POLICY.maxTurnCostMicrousd,
          poolReservedMicrousd: 400_000,
          committedMicrousd: 0,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          heartbeatIntervalMs: 10_000,
          status: "active" as const,
        },
        policy: DEFAULT_SITE_FUNDED_CODEX_POLICY,
        providerBaseUrl: "http://host.containers.internal:1234/v1",
        providerToken: "proxy-token",
        finish,
      },
    }));
    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer,
    });
    const streamPayloads: any[] = [];

    await new CodexAppServerAgent().evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "say hello",
      stream: async (payload) => streamPayloads.push(payload),
      config: {
        workingDirectory: "/tmp/project",
        model: "gpt-5.6-sol",
        reasoning: "high",
        serviceTier: "fast",
        maxConcurrentSubagents: 10,
      } as any,
    });

    expect(spawnCodexAppServer).toHaveBeenCalledWith(
      expect.objectContaining({
        siteFundedTurn: {
          fundedTurnId: expect.any(String),
          idempotencyKey: expect.any(String),
        },
      }),
    );
    expect(
      requests.find(({ method }) => method === "thread/start")?.params,
    ).toMatchObject({
      model: "gpt-5.6-luna",
      serviceTier: null,
      config: {
        "agents.max_concurrent_threads_per_session": 11,
        "features.multi_agent_v2.max_concurrent_threads_per_session": 11,
      },
    });
    expect(
      requests.find(({ method }) => method === "turn/start")?.params,
    ).toMatchObject({
      model: "gpt-5.6-luna",
      effort: "medium",
      serviceTier: null,
    });
    expect(streamPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "event",
          event: expect.objectContaining({
            type: "config",
            model: "gpt-5.6-luna",
            reasoning: "medium",
            serviceTier: "standard",
            siteFundedReservationId: "reservation-1",
          }),
        }),
      ]),
    );
    expect(finish).toHaveBeenCalledWith({
      status: "committed",
      outcome: "turn completed",
    });
  });

  it("reuses a funded app-server with a fresh reservation for each turn", async () => {
    let turnSequence = 0;
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/resume":
          fake.sendError(message.id, "thread not found");
          break;
        case "thread/start":
          fake.sendResponse(message.id, { thread: { id: "thr-funded-reuse" } });
          break;
        case "turn/start": {
          const turnId = `turn-funded-${++turnSequence}`;
          fake.sendResponse(message.id, { turn: { id: turnId } });
          setImmediate(() => {
            fake.sendNotification("turn/completed", {
              turn: { id: turnId, status: "completed" },
            });
          });
          break;
        }
        case "thread/backgroundTerminals/list":
          fake.sendResponse(message.id, { data: [], nextCursor: null });
          break;
        default:
          if (typeof message.id === "number") fake.sendResponse(message.id, {});
      }
    });
    const firstFinish = jest.fn(async () => {});
    const secondFinish = jest.fn(async () => {});
    const close = jest.fn(async () => {});
    const secondTurn: any = {
      reservation: {
        reservationId: "reservation-funded-2",
        fundedTurnId: "funded-turn-2",
        poolId: "site-funded-codex-free",
        policy: DEFAULT_SITE_FUNDED_CODEX_POLICY,
      },
      policy: DEFAULT_SITE_FUNDED_CODEX_POLICY,
      providerBaseUrl: "http://host.containers.internal:1234/v1",
      providerToken: "stable-proxy-token",
      finish: secondFinish,
      beginTurn: jest.fn(),
      close,
    };
    const beginTurn = jest.fn(async () => secondTurn);
    const firstTurn: any = {
      reservation: {
        reservationId: "reservation-funded-1",
        fundedTurnId: "funded-turn-1",
        poolId: "site-funded-codex-free",
        policy: DEFAULT_SITE_FUNDED_CODEX_POLICY,
      },
      policy: DEFAULT_SITE_FUNDED_CODEX_POLICY,
      providerBaseUrl: "http://host.containers.internal:1234/v1",
      providerToken: "stable-proxy-token",
      finish: firstFinish,
      beginTurn,
      close,
    };
    const spawnCodexAppServer = jest.fn(async () => ({
      proc: proc as any,
      cmd: "fake-codex",
      args: ["app-server"],
      cwd: "/tmp/project",
      authSource: "site-api-key",
      siteFundedTurn: firstTurn,
    }));
    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer,
    });
    const agent = new CodexAppServerAgent();
    const request = {
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      session_id: "chat-funded-reuse",
      stream: async () => {},
      config: {
        workingDirectory: "/tmp/project",
        paymentSource: "site-api-key" as const,
      },
    };

    await agent.evaluate({ ...request, prompt: "first" });
    await agent.evaluate({ ...request, prompt: "second" });

    expect(spawnCodexAppServer).toHaveBeenCalledTimes(1);
    expect(beginTurn).toHaveBeenCalledTimes(1);
    expect(firstFinish).toHaveBeenCalledWith({
      status: "committed",
      outcome: "turn completed",
    });
    expect(secondFinish).toHaveBeenCalledWith({
      status: "committed",
      outcome: "turn completed",
    });
    expect(proc.killed).toBe(false);
    await agent.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    expect(proc.killed).toBe(true);
  });

  it("falls back to persisted rollout usage when live usage is missing", async () => {
    const checkAllowed = jest.fn(async () => ({ allowed: true }));
    const reportUsage = jest.fn(async () => {});
    getCodexSiteKeyGovernorMock.mockReturnValue({
      pollIntervalMs: 60_000,
      checkAllowed,
      reportUsage,
    });

    const rootHostPath = mkdtempSync(path.join(tmpdir(), "codex-home-"));
    const codexHome = path.join(rootHostPath, ".codex");
    mkdirSync(path.join(codexHome, "sessions", "2026", "03", "15"), {
      recursive: true,
    });
    const rolloutPath = path.join(
      codexHome,
      "sessions",
      "2026",
      "03",
      "15",
      "rollout-test.jsonl",
    );
    writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-rollout-1",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 9642,
                cached_input_tokens: 9472,
                output_tokens: 21,
                reasoning_output_tokens: 0,
                total_tokens: 9663,
              },
              last_token_usage: {
                input_tokens: 9642,
                cached_input_tokens: 9472,
                output_tokens: 21,
                reasoning_output_tokens: 0,
                total_tokens: 9663,
              },
              model_context_window: 258400,
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-rollout-1",
          },
        }),
      ].join("\n"),
      "utf8",
    );
    const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
    db.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO threads(id, rollout_path) VALUES(?, ?)").run(
      "thr-rollout-1",
      "/root/.codex/sessions/2026/03/15/rollout-test.jsonl",
    );
    db.close();

    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "account/login/start":
          fake.sendResponse(message.id, { type: "apiKey" });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-rollout-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-rollout-1" } });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-rollout-1", status: "inProgress" },
            });
            fake.sendNotification("item/agentMessage/delta", {
              threadId: "thr-rollout-1",
              turnId: "turn-rollout-1",
              itemId: "msg-rollout-1",
              delta: "Hello",
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-rollout-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/home/user",
        authSource: "site-api-key",
        containerPathMap: {
          rootHostPath,
        },
        appServerLogin: {
          type: "apiKey",
          apiKey: "site-key",
        },
      }),
    });

    try {
      const agent = new CodexAppServerAgent();
      await agent.evaluate({
        project_id: "00000000-0000-4000-8000-000000000000",
        account_id: "00000000-0000-4000-8000-000000000001",
        prompt: "say hello",
        stream: async () => {},
        chat: {
          path: "root/demo.chat",
          project_id: "00000000-0000-4000-8000-000000000000",
        } as any,
        config: {
          workingDirectory: "/home/user",
          model: "gpt-5.4",
        } as any,
      });
    } finally {
      rmSync(rootHostPath, { recursive: true, force: true });
    }

    expect(reportUsage).toHaveBeenCalledWith({
      accountId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000000",
      model: "gpt-5.4",
      usage: {
        input_tokens: 9642,
        cached_input_tokens: 9472,
        output_tokens: 21,
        total_tokens: 19135,
      },
      totalTimeS: expect.any(Number),
      path: "root/demo.chat",
    });
  });

  it("surfaces persisted compaction markers in the ACP stream", async () => {
    const rootHostPath = mkdtempSync(path.join(tmpdir(), "codex-home-"));
    const codexHome = path.join(rootHostPath, ".codex");
    mkdirSync(path.join(codexHome, "sessions", "2026", "03", "15"), {
      recursive: true,
    });
    const rolloutPath = path.join(
      codexHome,
      "sessions",
      "2026",
      "03",
      "15",
      "rollout-compacted.jsonl",
    );
    writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-compacted-1",
          },
        }),
        JSON.stringify({
          type: "compacted",
          payload: {
            replacement_history: [{ type: "message", text: "older context" }],
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-compacted-1",
          },
        }),
      ].join("\n"),
      "utf8",
    );
    const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
    db.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO threads(id, rollout_path) VALUES(?, ?)").run(
      "thr-compacted-1",
      "/root/.codex/sessions/2026/03/15/rollout-compacted.jsonl",
    );
    db.close();

    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "account/login/start":
          fake.sendResponse(message.id, { type: "apiKey" });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-compacted-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, { turn: { id: "turn-compacted-1" } });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-compacted-1", status: "inProgress" },
            });
            fake.sendNotification("item/agentMessage/delta", {
              threadId: "thr-compacted-1",
              turnId: "turn-compacted-1",
              itemId: "msg-compacted-1",
              delta: "Hello",
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-compacted-1", status: "completed" },
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/home/user",
        containerPathMap: {
          rootHostPath,
        },
        appServerLogin: {
          type: "apiKey",
          apiKey: "secret-key",
        },
      }),
    });

    try {
      const agent = new CodexAppServerAgent();
      const streamPayloads: any[] = [];
      await agent.evaluate({
        project_id: "00000000-0000-4000-8000-000000000000",
        account_id: "00000000-0000-4000-8000-000000000001",
        prompt: "say hello",
        stream: async (payload) => {
          if (payload) streamPayloads.push(payload);
        },
        config: {
          workingDirectory: "/home/user",
        } as any,
      });

      expect(streamPayloads).toEqual(
        expect.arrayContaining([
          {
            type: "event",
            event: { type: "thinking", text: "Context compacted" },
          },
        ]),
      );
    } finally {
      rmSync(rootHostPath, { recursive: true, force: true });
    }
  });

  it("version-gates and answers synchronous attention requests", async () => {
    const threadStartRequests: any[] = [];
    const syncResponses: any[] = [];
    const requestSyncQuestion = jest.fn(async () => ({
      region: { answers: ["EU"] },
    }));
    const createAsyncQuestion = jest.fn(async () => {});
    const serverRequestResolved = jest.fn(async () => {});
    const proc = new FakeCodexAppServerProc((fake, message) => {
      if (message.id === 901 && message.result) {
        syncResponses.push(message);
        fake.sendNotification("serverRequest/resolved", { requestId: 901 });
        fake.sendNotification("turn/completed", {
          turn: { id: "turn-attention-1", status: "completed" },
        });
        return;
      }
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, {
            userAgent: "codex_cli_rs/0.151.0",
          });
          break;
        case "thread/start":
          threadStartRequests.push(message.params);
          fake.sendResponse(message.id, {
            thread: { id: "thr-attention-1" },
          });
          break;
        case "turn/start":
          fake.sendResponse(message.id, {
            turn: { id: "turn-attention-1" },
          });
          setImmediate(() => {
            fake.sendNotification("turn/started", {
              turn: { id: "turn-attention-1", status: "inProgress" },
            });
            fake.sendNotification("item/completed", {
              threadId: "thr-attention-1",
              turnId: "turn-attention-1",
              item: {
                id: "async-question-1",
                type: "agentMessage",
                delivery: "async",
                text: "I can continue after this question.",
                questions: [
                  {
                    title: "Which environment should I use?",
                    options: ["Staging", "Production"],
                  },
                ],
              },
            });
            fake.sendRequest(901, "item/tool/requestUserInput", {
              threadId: "thr-attention-1",
              turnId: "turn-attention-1",
              itemId: "question-attention-1",
              isBlocking: false,
              questions: [
                {
                  id: "region",
                  header: "Region",
                  question: "Which region?",
                  options: [{ label: "EU" }, { label: "US" }],
                },
              ],
            });
          });
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });

    setCodexProjectSpawner({
      spawnCodexExec: async () => {
        throw new Error("unexpected codex exec spawn");
      },
      spawnCodexAppServer: async () => ({
        proc: proc as any,
        cmd: "fake-codex",
        args: ["app-server"],
        cwd: "/home/user",
      }),
    });

    await new CodexAppServerAgent({
      attentionHandler: {
        requestSyncQuestion,
        createAsyncQuestion,
        serverRequestResolved,
      },
    }).evaluate({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "ask me",
      stream: async () => {},
      chat: {
        path: "root/demo.chat",
        project_id: "00000000-0000-4000-8000-000000000000",
      } as any,
      config: {
        workingDirectory: "/home/user",
      } as any,
    });

    expect(threadStartRequests).toHaveLength(1);
    expect(threadStartRequests[0].config).toEqual({
      "features.default_mode_request_user_input": true,
    });
    expect(requestSyncQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "901",
        itemId: "question-attention-1",
        isBlocking: false,
        questions: [
          {
            id: "region",
            header: "Region",
            question: "Which region?",
            options: [{ label: "EU" }, { label: "US" }],
          },
        ],
      }),
    );
    expect(createAsyncQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "async-question-1",
        questions: [
          {
            id: "question-1",
            header: "Question 1",
            question: "Which environment should I use?",
            isOther: true,
            options: [{ label: "Staging" }, { label: "Production" }],
          },
        ],
      }),
    );
    expect(syncResponses).toEqual([
      {
        id: 901,
        result: { answers: { region: { answers: ["EU"] } } },
      },
    ]);
    expect(serverRequestResolved).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "901" }),
    );
  });
});
