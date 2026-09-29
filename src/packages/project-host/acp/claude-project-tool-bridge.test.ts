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
      "request_user_input_async",
    ]);
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
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    child.kill("SIGKILL");
    await bridge.close();
  }
});
