/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomBytes } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sandboxExec,
  type SandboxExecResult,
} from "@cocalc/project-runner/run/sandbox-exec";

const MAX_REQUEST_BYTES = 40 * 1024;
const MAX_SCRIPT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_CONCURRENT_TOOLS = 4;
const MAX_OPEN_CONNECTIONS = 16;
export const CLAUDE_PROJECT_TOOL_MOUNT = "/run/cocalc/agent-tools";

// This process is trusted code in the controller. It offers no local shell or
// filesystem tool: the project-host socket is its only effectful operation.
const MCP_HELPER_SOURCE = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const readline = require("node:readline");
const root = process.env.COCALC_PROJECT_TOOL_DIR || "/run/cocalc/agent-tools";
const token = fs.readFileSync(root + "/token", "utf8");
const tool = {
  name: "project_exec",
  description: "Run a shell command in the CoCalc project container, not in the Claude controller. Project files and project secrets are accessible there; Claude subscription login material is not.",
  inputSchema: {
    type: "object",
    properties: {
      script: { type: "string", description: "Shell script to run in the project" },
      cwd: { type: "string", description: "Optional project-container working directory" }
    },
    required: ["script"],
    additionalProperties: false
  }
};
function execute(args) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(root + "/tool.sock");
    let received = "";
    socket.setTimeout(150000, () => socket.destroy(new Error("Project tool timed out")));
    socket.on("connect", () => socket.write(JSON.stringify({ token, args }) + "\n"));
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (received.length > 1200000) return socket.destroy(new Error("Project tool response too large"));
      const newline = received.indexOf("\n");
      if (newline < 0) return;
      try { resolve(JSON.parse(received.slice(0, newline))); }
      catch { reject(new Error("Invalid project tool response")); }
      socket.end();
    });
    socket.on("error", reject);
    socket.on("close", () => { if (!received.includes("\n")) reject(new Error("Project tool disconnected")); });
  });
}
async function handle(message) {
  if (!message || typeof message !== "object" || message.id === undefined) return;
  const id = message.id;
  try {
    let result;
    if (message.method === "initialize") {
      result = { protocolVersion: message.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "cocalc-project-tools", version: "1" } };
    } else if (message.method === "ping") {
      result = {};
    } else if (message.method === "tools/list") {
      result = { tools: [tool] };
    } else if (message.method === "tools/call" && message.params?.name === tool.name) {
      const output = await execute(message.params.arguments);
      result = { content: [{ type: "text", text: JSON.stringify(output) }], isError: output.code !== 0 };
    } else {
      throw new Error("Unsupported project tool method");
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: error.message || "Project tool failed" } }) + "\n");
  }
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (line.length > 65536) return;
  try { void handle(JSON.parse(line)); } catch { /* Ignore malformed notifications. */ }
});
`;

export interface ClaudeProjectToolBridge {
  directory: string;
  close(): Promise<void>;
}

export async function createClaudeProjectToolBridge(
  projectId: string,
  execute: (script: string, cwd?: string) => Promise<SandboxExecResult> = (
    script,
    cwd,
  ) =>
    sandboxExec({
      project_id: projectId,
      script,
      cwd,
      timeoutMs: 120_000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    }),
  authorize: () => Promise<void> = async () => {},
): Promise<ClaudeProjectToolBridge> {
  const directory = await mkdtemp(join(tmpdir(), "cocalc-claude-tools-"));
  const token = randomBytes(32).toString("hex");
  const socketPath = join(directory, "tool.sock");
  const sockets = new Set<Socket>();
  let active = 0;
  const server = createServer((socket) => {
    if (sockets.size >= MAX_OPEN_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let input = "";
    socket.setTimeout(150_000, () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) return socket.destroy();
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      socket.removeAllListeners("data");
      if (active >= MAX_CONCURRENT_TOOLS) {
        socket.end(JSON.stringify({ error: "Project tool is busy" }) + "\n");
        return;
      }
      active++;
      void (async () => {
        try {
          const request = JSON.parse(input.slice(0, newline));
          const script = request?.args?.script;
          const cwd = request?.args?.cwd;
          if (
            request?.token !== token ||
            typeof script !== "string" ||
            !script.trim() ||
            Buffer.byteLength(script) > MAX_SCRIPT_BYTES ||
            (cwd !== undefined &&
              (typeof cwd !== "string" || cwd.length > 4096))
          )
            throw Error("Invalid project tool request");
          await authorize();
          const result = await execute(script, cwd);
          socket.end(JSON.stringify(result) + "\n");
        } catch (error) {
          socket.end(
            JSON.stringify({
              code: null,
              stdout: "",
              stderr:
                error instanceof Error ? error.message : "Project tool failed",
            }) + "\n",
          );
        } finally {
          active--;
        }
      })();
    });
  });
  try {
    await writeFile(join(directory, "token"), token, { mode: 0o600 });
    await writeFile(join(directory, "bridge.cjs"), MCP_HELPER_SOURCE, {
      mode: 0o600,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return {
      directory,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (server.listening) server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
