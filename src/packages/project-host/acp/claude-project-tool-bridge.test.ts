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
      return { code: 130, stdout: "", stderr: "canceled" };
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
    expect(listed.result.tools.map(({ name }) => name)).toEqual([
      "project_exec",
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
    );
    authorized = false;
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
