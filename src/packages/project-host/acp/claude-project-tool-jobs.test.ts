/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { createClaudeProjectToolBridge } from "./claude-project-tool-bridge";
import { runStreamingSandboxCommand } from "@cocalc/project-runner/run/sandbox-command-stream";
import { SANDBOX_COMMAND_SUPERVISOR } from "@cocalc/project-runner/run/sandbox-command-supervisor";

// This fixture tests MCP streaming, not kernel containment. Production uses
// the root-owned cgroup helper; its adversarial tests live with bootstrap.
async function streamingFixture(script, _cwd, signal, options) {
  const result = await runStreamingSandboxCommand({
    command: process.execPath,
    args: ["-e", SANDBOX_COMMAND_SUPERVISOR, "--", script],
    env: { PATH: process.env.PATH },
    signal,
    ...options,
  });
  return { ...result, cleanupConfirmed: true };
}

function helper(directory: string) {
  const child = spawn(process.execPath, [join(directory, "bridge.cjs")], {
    env: { COCALC_PROJECT_TOOL_DIR: directory },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  let id = 0;
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    pending.get(value.id)?.resolve(value);
    pending.delete(value.id);
  });
  child.on("close", () => {
    for (const entry of pending.values())
      entry.reject(Error("MCP helper closed"));
    pending.clear();
  });
  return {
    child,
    call: async (name: string, args: unknown = {}) => {
      const result = await new Promise<any>((resolve, reject) => {
        const current = ++id;
        pending.set(current, { resolve, reject });
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: current,
            method: "tools/call",
            params: { name, arguments: args },
          }) + "\n",
        );
      });
      if (result.error) throw Error(result.error.message);
      return {
        ...JSON.parse(result.result.content[0].text),
        isError: result.result.isError,
      };
    },
  };
}

test("MCP starts, lists, replays and cancels real supervised jobs across tool connections", async () => {
  const authorize = jest.fn(async () => {});
  const bridge = await createClaudeProjectToolBridge(
    "fixture",
    streamingFixture,
    authorize,
  );
  const mcp = helper(bridge.directory);
  try {
    const quick = await mcp.call("project_exec", {
      script: "printf quick",
      yield_time_ms: 5000,
    });
    expect(quick).toMatchObject({
      status: "completed",
      code: 0,
      stdout: "quick",
      isError: false,
    });
    const first = await mcp.call("project_exec", {
      script: "printf begin; sleep 30",
      request_id: "build",
      yield_time_ms: 0,
    });
    expect(first).toMatchObject({
      status: "running",
      code: null,
      isError: false,
    });
    const listing = await mcp.call("project_exec_list");
    expect(listing.isError).toBe(false);
    expect(
      listing.jobs.find((job: any) => job.job_id === first.job_id)?.status,
    ).toBe("running");
    const output = await mcp.call("project_exec_wait", {
      job_id: first.job_id,
      cursor: 0,
      yield_time_ms: 2000,
    });
    expect(output.stdout).toBe("begin");
    expect(output.isError).toBe(false);
    const replay = await mcp.call("project_exec_wait", {
      job_id: first.job_id,
      cursor: 0,
      yield_time_ms: 0,
    });
    expect(replay.stdout).toBe("begin");
    // Reconnecting the MCP client must not orphan or re-execute its owned job.
    const reconnected = helper(bridge.directory);
    try {
      const same = await reconnected.call("project_exec", {
        script: "printf begin; sleep 30",
        request_id: "build",
        yield_time_ms: 0,
      });
      expect(same.job_id).toBe(first.job_id);
      expect(same.status).toBe("running");
    } finally {
      reconnected.child.kill("SIGKILL");
    }
    const canceled = await mcp.call("project_exec_cancel", {
      job_id: first.job_id,
      cursor: output.next_cursor,
    });
    expect(canceled).toMatchObject({
      status: "canceled",
      code: 130,
      cleanup_pending: false,
      isError: false,
    });
    expect(authorize.mock.calls.length).toBeGreaterThanOrEqual(5);
  } finally {
    mcp.child.kill("SIGKILL");
    await bridge.close();
  }
}, 15000);

async function request(directory: string, tool: string, args: unknown) {
  const token = await readFile(join(directory, "token"), "utf8");
  return new Promise<any>((resolve, reject) => {
    const socket = connect(join(directory, "tool.sock"));
    let text = "";
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.write(JSON.stringify({ token, tool, args }) + "\n"),
    );
    socket.on("data", (chunk) => {
      text += chunk;
    });
    socket.on("end", () => resolve(JSON.parse(text)));
  });
}

test("revocation cancels jobs even without further tool calls", async () => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  const authorize = jest.fn(async () => {});
  let signal!: AbortSignal;
  const bridge = await createClaudeProjectToolBridge(
    "fixture",
    async (_script, _cwd, s) => {
      signal = s;
      await new Promise<void>((resolve) =>
        s.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { code: 130, stdout: "", stderr: "", cleanupConfirmed: true };
    },
    authorize,
  );
  try {
    const first = await request(bridge.directory, "project_exec", {
      script: "long",
      yield_time_ms: 0,
    });
    expect(first.status).toBe("running");
    authorize.mockRejectedValue(Error("revoked"));
    await jest.advanceTimersByTimeAsync(30000);
    expect(signal.aborted).toBe(true);
    const denied = await request(bridge.directory, "project_exec_wait", {
      job_id: first.job_id,
      cursor: 0,
    });
    expect(denied.stderr).toContain("revoked");
    expect(denied.stdout).toBe("");
  } finally {
    await bridge.close();
    jest.useRealTimers();
  }
});

(process.env.COCALC_TEST_LONG_JOBS === "1" ? test : test.skip)(
  "MCP can poll a real job beyond two minutes without detachment",
  async () => {
    const bridge = await createClaudeProjectToolBridge(
      "fixture",
      streamingFixture,
    );
    const mcp = helper(bridge.directory);
    try {
      let result = await mcp.call("project_exec", {
        script: "printf before; sleep 125; printf after",
        yield_time_ms: 0,
      });
      let output = result.stdout;
      let polls = 0;
      while (result.status === "running" || result.has_more) {
        result = await mcp.call("project_exec_wait", {
          job_id: result.job_id,
          cursor: result.next_cursor,
          yield_time_ms: 30000,
        });
        output += result.stdout;
        polls++;
        expect(result.isError).toBe(false);
      }
      expect(result).toMatchObject({ status: "completed", code: 0 });
      expect(output).toBe("beforeafter");
      expect(polls).toBeGreaterThan(4);
    } finally {
      mcp.child.kill("SIGKILL");
      await bridge.close();
    }
  },
  150000,
);
