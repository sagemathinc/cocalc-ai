/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { createClaudeProjectToolBridge } from "./claude-project-tool-bridge";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

test("tool calls containing U+2028/U+2029 get a response, and malformed lines get errors", async () => {
  const execute = jest.fn(async (script: string) => ({
    code: 0,
    cleanupConfirmed: true,
    stdout: `ran ${script}`,
    stderr: "",
  }));
  const bridge = await createClaudeProjectToolBridge(PROJECT_ID, execute);
  const child = spawn(
    process.execPath,
    [join(bridge.directory, "bridge.cjs")],
    {
      env: { COCALC_PROJECT_TOOL_DIR: bridge.directory },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const raw: string[] = [];
  const waiters = new Map<number, (value: any) => void>();
  let buffer = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      raw.push(line);
      const message = JSON.parse(line);
      waiters.get(message.id)?.(message);
    }
  });
  const response = (id: number) =>
    new Promise<any>((resolve) => waiters.set(id, resolve));
  try {
    // Exactly what a client's JSON.stringify sends: the characters stay raw.
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "project_exec",
        arguments: { script: `echo a${LS}b${PS}c` },
      },
    });
    expect(call.includes(LS)).toBe(true);
    const answered = response(1);
    child.stdin!.write(call + "\n");
    const result = await answered;
    expect(execute).toHaveBeenCalledWith(
      `echo a${LS}b${PS}c`,
      undefined,
      expect.any(AbortSignal),
      expect.any(Object),
    );
    expect(JSON.parse(result.result.content[0].text).stdout).toBe(
      `ran echo a${LS}b${PS}c`,
    );
    // The response line itself carries the characters escaped.
    expect(raw.at(-1)!.includes(LS) || raw.at(-1)!.includes(PS)).toBe(false);

    // A truncated request no longer vanishes silently.
    const rejected = response(7);
    child.stdin!.write('{"jsonrpc":"2.0","id":7,"method":"tools/call"\n');
    expect((await rejected).error).toEqual({
      code: -32700,
      message: "Project tool request was not valid JSON",
    });
  } finally {
    child.kill("SIGKILL");
    await bridge.close();
  }
});
