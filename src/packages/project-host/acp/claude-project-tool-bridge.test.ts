/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { createClaudeProjectToolBridge } from "./claude-project-tool-bridge";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

async function callTool(
  directory: string,
  tool = "project_exec",
  args: Record<string, unknown> = { script: "echo ok" },
): Promise<any> {
  const token = await readFile(join(directory, "token"), "utf8");
  return new Promise((resolve, reject) => {
    const socket = connect(join(directory, "tool.sock"));
    let response = "";
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.write(JSON.stringify({ token, tool, args }) + "\n"),
    );
    socket.on("data", (chunk) => (response += chunk));
    socket.on("end", () => {
      try {
        resolve(JSON.parse(response));
      } catch (error) {
        reject(error);
      }
    });
  });
}

test("successful reauthorization restores tools in the same turn", async () => {
  const execute = jest.fn(async () => ({
    code: 0,
    stdout: "ok",
    stderr: "",
    cleanupConfirmed: true,
  }));
  const authorize = jest
    .fn(async () => {})
    .mockRejectedValueOnce(Error("connection lost"));
  const bridge = await createClaudeProjectToolBridge(
    PROJECT_ID,
    execute,
    authorize,
  );
  try {
    expect((await callTool(bridge.directory)).stderr).toBe("connection lost");
    expect(execute).not.toHaveBeenCalled();
    expect((await callTool(bridge.directory)).stdout).toBe("ok");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(2);
  } finally {
    await bridge.close();
  }
});

test("continuing authorization denial never restores tools", async () => {
  const execute = jest.fn();
  const authorize = jest.fn(async () => {
    throw Error("No longer authorized");
  });
  const bridge = await createClaudeProjectToolBridge(
    PROJECT_ID,
    execute,
    authorize,
  );
  try {
    for (let i = 0; i < 3; i++) {
      expect((await callTool(bridge.directory)).stderr).toBe(
        "No longer authorized",
      );
    }
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await bridge.close();
  }
});

test("cancel during reauthorization requires an explicit resume", async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const execute = jest.fn(async () => ({
    code: 0,
    stdout: "ok",
    stderr: "",
    cleanupConfirmed: true,
  }));
  const authorize = jest
    .fn(async () => {})
    .mockRejectedValueOnce(Error("connection lost"))
    .mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
  const bridge = await createClaudeProjectToolBridge(
    PROJECT_ID,
    execute,
    authorize,
  );
  try {
    await callTool(bridge.directory);
    const pending = callTool(bridge.directory);
    await waiting;
    const canceled = bridge.cancel();
    release();
    await canceled;
    expect((await pending).code).toBeNull();
    expect((await callTool(bridge.directory)).stderr).toBe(
      "Project tool is closed",
    );
    expect(execute).not.toHaveBeenCalled();
    bridge.resume();
    expect((await callTool(bridge.directory)).stdout).toBe("ok");
  } finally {
    release?.();
    await bridge.close();
  }
});

test("reauthorization preserves canceled jobs and retry IDs without replay", async () => {
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const execute = jest.fn(
    async (_script: string, _cwd: string | undefined, signal: AbortSignal) => {
      entered();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return {
        code: 130,
        stdout: "",
        stderr: "canceled",
        cleanupConfirmed: true,
      };
    },
  );
  let fail = false;
  const bridge = await createClaudeProjectToolBridge(
    PROJECT_ID,
    execute,
    async () => {
      if (fail) throw Error("connection lost");
    },
  );
  const args = { script: "long job", request_id: "original", yield_time_ms: 0 };
  try {
    const original = await callTool(bridge.directory, "project_exec", args);
    await waiting;
    fail = true;
    expect(
      (await callTool(bridge.directory, "project_exec_list", {})).stderr,
    ).toBe("connection lost");
    fail = false;
    const listed = await callTool(bridge.directory, "project_exec_list", {});
    expect(listed.jobs).toEqual([
      expect.objectContaining({ job_id: original.job_id, status: "canceled" }),
    ]);
    const retried = await callTool(bridge.directory, "project_exec", args);
    expect(retried.job_id).toBe(original.job_id);
    expect(retried.status).toBe("canceled");
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    await bridge.close();
  }
});

test("timer authority failure recovers without replaying its canceled job", async () => {
  jest.useFakeTimers({
    doNotFake: ["nextTick", "setImmediate", "setTimeout", "clearTimeout"],
  });
  let canceled!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    canceled = resolve;
  });
  const execute = jest.fn(
    async (_script: string, _cwd: string | undefined, signal: AbortSignal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            canceled();
            resolve();
          },
          { once: true },
        ),
      );
      return {
        code: 130,
        stdout: "",
        stderr: "canceled",
        cleanupConfirmed: true,
      };
    },
  );
  const authorize = jest
    .fn(async () => {})
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(Error("connection lost"));
  const bridge = await createClaudeProjectToolBridge(
    PROJECT_ID,
    execute,
    authorize,
  );
  try {
    const job = await callTool(bridge.directory, "project_exec", {
      script: "long job",
      yield_time_ms: 0,
    });
    jest.advanceTimersByTime(30_000);
    await cancellation;
    const listed = await callTool(bridge.directory, "project_exec_list", {});
    expect(listed.jobs).toEqual([
      expect.objectContaining({ job_id: job.job_id, status: "canceled" }),
    ]);
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    await bridge.close();
    jest.useRealTimers();
  }
});

test("timer and tool calls share an in-flight authorization check", async () => {
  jest.useFakeTimers({
    doNotFake: ["nextTick", "setImmediate", "setTimeout", "clearTimeout"],
  });
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const execute = jest.fn(
    async (_script: string, _cwd: string | undefined, signal: AbortSignal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return {
        code: 130,
        stdout: "",
        stderr: "canceled",
        cleanupConfirmed: true,
      };
    },
  );
  const authorize = jest
    .fn(async () => {})
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
  const bridge = await createClaudeProjectToolBridge(
    PROJECT_ID,
    execute,
    authorize,
  );
  try {
    await callTool(bridge.directory, "project_exec", {
      script: "long job",
      yield_time_ms: 0,
    });
    const pending = callTool(bridge.directory, "project_exec_list", {});
    await waiting;
    jest.advanceTimersByTime(30_000);
    expect(authorize).toHaveBeenCalledTimes(2);
    release();
    expect((await pending).jobs).toHaveLength(1);
  } finally {
    release?.();
    await bridge.close();
    jest.useRealTimers();
  }
});

async function sendTool(directory: string) {
  const token = await readFile(join(directory, "token"), "utf8");
  const socket = connect(join(directory, "tool.sock"));
  socket.on("error", () => {});
  socket.on("data", () => {});
  socket.on("connect", () =>
    socket.write(
      JSON.stringify({ token, args: { script: "sleep 60" } }) + "\n",
    ),
  );
  return socket;
}

test("closing during authorization cannot start a command", async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const execute = jest.fn();
  const bridge = await createClaudeProjectToolBridge(
    PROJECT_ID,
    execute,
    async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  );
  const socket = await sendTool(bridge.directory);
  await waiting;
  const closed = bridge.close();
  release();
  await closed;
  expect(execute).not.toHaveBeenCalled();
  socket.destroy();
});

test("cancel aborts an executing command and close is idempotent", async () => {
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let commandSignal: AbortSignal | undefined;
  const bridge = await createClaudeProjectToolBridge(
    PROJECT_ID,
    async (_script, _cwd, signal) => {
      commandSignal = signal;
      entered();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return {
        code: 130,
        stdout: "",
        stderr: "canceled",
        cleanupConfirmed: true,
      };
    },
  );
  const socket = await sendTool(bridge.directory);
  await waiting;
  await bridge.cancel();
  expect(commandSignal?.aborted).toBe(true);
  await bridge.close();
  await bridge.close();
  socket.destroy();
});

test("trusted MCP helper executes only through the scoped project socket", async () => {
  const execute = jest.fn(async (script: string, cwd?: string) => ({
    code: 0,
    cleanupConfirmed: true,
    stdout: `ran ${script} in ${cwd}`,
    stderr: "",
  }));
  let authorized = true;
  const bridge = await createClaudeProjectToolBridge(
    PROJECT_ID,
    execute,
    async () => {
      if (!authorized) throw Error("No longer authorized");
    },
  );
  const child = spawn(
    process.execPath,
    [join(bridge.directory, "bridge.cjs")],
    {
      env: { COCALC_PROJECT_TOOL_DIR: bridge.directory },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const lines = createInterface({ input: child.stdout! });
  const pending = new Map<number, (value: any) => void>();
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    pending.get(value.id)?.(value);
    pending.delete(value.id);
  });
  const request = (id: number, method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      pending.set(id, resolve);
      child.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-03-26",
    });
    expect(initialized.result.serverInfo.name).toBe("cocalc-project-tools");
    const listed = await request(2, "tools/list");
    expect(Object.keys(listed.result.tools[0].inputSchema.properties)).toEqual(
      expect.arrayContaining([
        "script",
        "cwd",
        "yield_time_ms",
        "timeout_ms",
        "request_id",
      ]),
    );
    expect(listed.result.tools.map(({ name }) => name)).toEqual([
      "project_exec",
      "project_exec_wait",
      "project_exec_cancel",
      "project_exec_list",
      "project_read_image",
      "project_read_file",
      "project_edit_file",
      "project_write_file",
      "memory_list",
      "memory_read",
      "memory_write",
      "memory_delete",
      "request_user_input_async",
    ]);
    const unavailable = await request(30, "tools/call", {
      name: "memory_list",
      arguments: {},
    });
    expect(unavailable.result.isError).toBe(true);
    const saved: any[] = [];
    bridge.setMemory({
      list: async () => ({ count: saved.length, notes: saved }),
      read: async () => ({ error: "unused" }),
      write: async (args: any) => {
        saved.push({ name: args.name, description: args.description });
        return { name: args.name, saved: "created" };
      },
      delete: async () => ({ name: "x", deleted: false }),
      entries: async () => [],
    } as any);
    const wrote = await request(31, "tools/call", {
      name: "memory_write",
      arguments: { name: "deploy", description: "How to deploy", body: "..." },
    });
    expect(wrote.result.isError).toBe(false);
    const listedNotes = await request(32, "tools/call", {
      name: "memory_list",
      arguments: {},
    });
    expect(JSON.parse(listedNotes.result.content[0].text)).toEqual({
      count: 1,
      notes: [{ name: "deploy", description: "How to deploy" }],
    });
    const called = await request(3, "tools/call", {
      name: "project_exec",
      arguments: { script: "pwd", cwd: "/home/user" },
    });
    expect(JSON.parse(called.result.content[0].text).stdout).toBe(
      "ran pwd in /home/user",
    );
    expect(execute).toHaveBeenCalledWith(
      "pwd",
      "/home/user",
      expect.any(AbortSignal),
      expect.objectContaining({
        timeoutMs: 3_600_000,
        onOutput: expect.any(Function),
      }),
    );
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    execute.mockImplementationOnce(async () => ({
      code: 0,
      cleanupConfirmed: true,
      stdout: png.toString("base64"),
      stderr: "",
    }));
    const viewed = await request(5, "tools/call", {
      name: "project_read_image",
      arguments: { path: "/home/user/plot.png" },
    });
    expect(viewed.result.isError).toBe(false);
    expect(viewed.result.content[0]).toEqual({
      type: "image",
      data: png.toString("base64"),
      mimeType: "image/png",
    });
    expect(JSON.parse(viewed.result.content[1].text)).toEqual({
      path: "/home/user/plot.png",
      bytes: png.length,
      mimeType: "image/png",
    });
    execute.mockImplementationOnce(async () => ({
      code: 0,
      cleanupConfirmed: true,
      stdout: `2\n${Buffer.from("alpha\nbeta\n").toString("base64")}`,
      stderr: "",
    }));
    const read = await request(6, "tools/call", {
      name: "project_read_file",
      arguments: { path: "notes.txt" },
    });
    expect(read.result).toEqual({
      content: [
        {
          type: "text",
          text: "notes.txt: lines 1-2 of 2\n     1\talpha\n     2\tbeta",
        },
      ],
      isError: false,
    });
    const question = {
      request_id: "target",
      questions: [{ title: "Which target?" }],
    };
    const ask = jest.fn(async () => ({
      question_id: "durable-question",
      status: "pending" as const,
    }));
    bridge.setAsyncQuestionHandler(ask);
    const asked = await request(20, "tools/call", {
      name: "request_user_input_async",
      arguments: question,
    });
    expect(asked.result.isError).toBe(false);
    expect(JSON.parse(asked.result.content[0].text)).toEqual({
      question_id: "durable-question",
      status: "pending",
    });
    expect(ask).toHaveBeenCalledWith(question);
    authorized = false;
    const deniedQuestion = await request(21, "tools/call", {
      name: "request_user_input_async",
      arguments: question,
    });
    expect(deniedQuestion.result.isError).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    const revoked = await request(4, "tools/call", {
      name: "project_exec",
      arguments: { script: "id" },
    });
    expect(revoked.result.isError).toBe(true);
    expect(JSON.parse(revoked.result.content[0].text).stderr).toContain(
      "No longer authorized",
    );
    const unauthorized = await new Promise<string>((resolve) => {
      const socket = connect(join(bridge.directory, "tool.sock"));
      let response = "";
      socket.on("connect", () =>
        socket.write(
          JSON.stringify({ token: "wrong", args: { script: "id" } }) + "\n",
        ),
      );
      socket.on("data", (chunk) => {
        response += chunk.toString();
      });
      socket.on("end", () => resolve(response));
    });
    expect(unauthorized).toContain("Invalid project tool request");
    expect(execute).toHaveBeenCalledTimes(3);
  } finally {
    child.kill("SIGKILL");
    await bridge.close();
  }
});
