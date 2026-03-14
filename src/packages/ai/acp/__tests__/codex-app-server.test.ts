import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  CodexAppServerAgent,
  forkCodexAppServerSession,
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

  sendNotification(method: string, params: any): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }
}

describe("CodexAppServerAgent", () => {
  afterEach(async () => {
    setCodexProjectSpawner(null);
  });

  it("streams app-server events and returns the upstream thread id", async () => {
    const proc = new FakeCodexAppServerProc((fake, message) => {
      switch (message.method) {
        case "initialize":
          fake.sendResponse(message.id, { ok: true });
          break;
        case "thread/start":
          fake.sendResponse(message.id, {
            thread: { id: "thr-shared-1" },
          });
          break;
        case "turn/start":
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
                text: "Hello",
                phase: null,
              },
            });
            fake.sendNotification("turn/completed", {
              turn: { id: "turn-1", status: "completed" },
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

    expect(streamPayloads).toEqual(
      expect.arrayContaining([
        { type: "status", state: "queued" },
        { type: "status", state: "init" },
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
          event: { type: "message", text: "Hello" },
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
          finalResponse: "Hello",
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
});
