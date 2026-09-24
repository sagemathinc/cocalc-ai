/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createClaudeProjectToolBridge } from "./claude-project-tool-bridge";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

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
    expect(execute).toHaveBeenCalledWith("pwd", "/home/user");
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
