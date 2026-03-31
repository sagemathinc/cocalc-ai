import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
const getCodexSiteKeyGovernorMock: jest.Mock<any, []> = jest.fn(() => null);

jest.mock("../codex-site-key-governor", () => ({
  getCodexSiteKeyGovernor: () => getCodexSiteKeyGovernorMock(),
  setCodexSiteKeyGovernor: jest.fn(),
}));

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

  sendRequest(id: number, method: string, params: any): void {
    this.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
  }
}

describe("CodexAppServerAgent", () => {
  afterEach(async () => {
    setCodexProjectSpawner(null);
    getCodexSiteKeyGovernorMock.mockReset();
    getCodexSiteKeyGovernorMock.mockReturnValue(null);
  });

  it("streams app-server events and returns the upstream thread id", async () => {
    const loginRequests: any[] = [];
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
    expect(loginRequests).toEqual([
      {
        type: "apiKey",
        apiKey: "secret-key",
      },
    ]);
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
    const baseRequest = {
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      session_id: "chat-thread-1",
      config: {
        workingDirectory: "/tmp/project",
      } as any,
      stream: async () => {},
    };

    await agent.evaluate({
      ...baseRequest,
      prompt: "first turn",
    });
    await agent.evaluate({
      ...baseRequest,
      prompt: "second turn",
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
      expect.objectContaining({
        spawn: 2,
        params: expect.objectContaining({
          threadId: "thr-live-1",
        }),
      }),
    ]);
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
    expect(turnStartParams?.input?.[0]?.text).toContain(
      'When you need the CoCalc CLI, use this exact command: `"/root/.local/bin/cocalc"`.',
    );
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

  it("waits for the app-server process to exit before resolving interrupt", async () => {
    let releaseExit: (() => void) | undefined;
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
          break;
        default:
          if (typeof message.id === "number") {
            fake.sendResponse(message.id, {});
          }
      }
    });
    proc.kill = ((signal: NodeJS.Signals = "SIGTERM") => {
      if (proc.exitCode != null) return true;
      proc.killed = true;
      proc.exitCode = signal === "SIGKILL" ? 137 : 0;
      releaseExit = () => {
        setImmediate(() => proc.emit("exit", proc.exitCode, signal));
      };
      return true;
    }) as any;

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

    let interruptResolved = false;
    const interruptPromise = agent
      .interrupt("thr-interrupt-wait-1")
      .then(() => {
        interruptResolved = true;
      });

    await new Promise((resolve) => setImmediate(resolve));
    expect(interruptResolved).toBe(false);
    expect(typeof releaseExit).toBe("function");

    releaseExit?.();
    await interruptPromise;
    await expect(pending).resolves.toBeUndefined();
    expect(interruptResolved).toBe(true);
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
        cwd: "/root",
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
          workingDirectory: "/root",
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
        cwd: "/root",
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
          workingDirectory: "/root",
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
});
