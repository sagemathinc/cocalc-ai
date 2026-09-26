/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomBytes } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxExec } from "@cocalc/project-runner/run/sandbox-exec";
import {
  ClaudeProjectJobs,
  type ProjectJobExecutor,
} from "./claude-project-jobs";

const MAX_REQUEST_BYTES = 40 * 1024;
const MAX_CONCURRENT_TOOLS = 8;
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
const tools = [{
  name: "project_exec",
  description: "Start a managed command in the CoCalc project, not the Claude controller. Run builds in the foreground: do NOT use &/nohup/setsid to avoid a tool timeout. Returns promptly with job_id and status; running is NOT failure. Use project_exec_wait with next_cursor to continue reading until completion, or project_exec_cancel to stop it. Project files/secrets are accessible; subscription login material is not. Jobs belong to this controller and stop on cancellation, revocation, shutdown or deadline. For intentionally persistent services or interactive input use the existing CoCalc CLI project terminal facilities.",
  inputSchema: {
    type: "object",
    properties: {
      script: { type: "string", description: "Shell script to run in the project" },
      cwd: { type: "string", description: "Optional project-container working directory" },
      yield_time_ms: {type:"integer",minimum:0,maximum:30000,description:"How long this tool waits, not a job deadline; default 1000 ms"},
      timeout_ms: {type:"integer",minimum:1,maximum:86400000,description:"Job wall-clock deadline; default 1 hour, maximum 24 hours"},
      request_id: {type:"string",description:"Optional unique retry ID. Reuse only for the identical command; if a response is lost, list jobs instead of blindly rerunning."}
    },
    required: ["script"],
    additionalProperties: false
  }
}, {
  name:"project_exec_wait",
  description:"Read/poll a project job. Pass its next_cursor as cursor for incremental output. Repeating a cursor replays retained output. Continue while status is running or has_more is true. output_truncated means older output was evicted: redirect verbose logs to a project file when full history is needed. Polling never restarts a command. Completed jobs are retained for up to 10 minutes (at most 32 jobs).",
  inputSchema:{type:"object",properties:{job_id:{type:"string"},cursor:{type:"integer",minimum:0},yield_time_ms:{type:"integer",minimum:0,maximum:30000}},required:["job_id"],additionalProperties:false}
}, {
  name:"project_exec_cancel",
  description:"Cancel a managed project job and wait for its supervised execution to stop. Repeated cancellation is safe.",
  inputSchema:{type:"object",properties:{job_id:{type:"string"},cursor:{type:"integer",minimum:0}},required:["job_id"],additionalProperties:false}
}, {
  name:"project_exec_list",
  description:"List jobs owned by this controller, including IDs, retry IDs, status and deadlines. Use after an uncertain tool response; do not automatically repeat a command.",
  inputSchema:{type:"object",properties:{},additionalProperties:false}
}];
function execute(tool, args) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(root + "/tool.sock");
    socket.setEncoding("utf8");
    let received = "";
    socket.setTimeout(150000, () => socket.destroy(new Error("Project tool timed out")));
    socket.on("connect", () => socket.write(JSON.stringify({ token, tool, args }) + "\n"));
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
      result = { tools };
    } else if (message.method === "tools/call" && tools.some(tool => tool.name === message.params?.name)) {
      const output = await execute(message.params.name, message.params.arguments ?? {});
      const canceledSuccessfully = message.params.name === "project_exec_cancel" && output.status && !output.cleanup_pending;
      const isError = !!output.error || (output.status ? (!canceledSuccessfully && ["failed","canceled","timed_out"].includes(output.status)) : ("code" in output && output.code !== 0));
      result = { content: [{ type: "text", text: JSON.stringify(output) }], isError };
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
  cancel(): Promise<void>;
  resume(): void;
  close(): Promise<void>;
}

export async function createClaudeProjectToolBridge(
  projectId: string,
  execute: ProjectJobExecutor = (script, cwd, signal, options) =>
    sandboxExec({
      project_id: projectId,
      script,
      cwd,
      signal,
      ...options,
    }),
  authorize: () => Promise<void> = async () => {},
): Promise<ClaudeProjectToolBridge> {
  const directory = await mkdtemp(join(tmpdir(), "cocalc-claude-tools-"));
  const token = randomBytes(32).toString("hex");
  const socketPath = join(directory, "tool.sock");
  const sockets = new Set<Socket>();
  let active = 0;
  let closed: Promise<void> | undefined;
  let fenced = false;
  let paused = false;
  let generation = new AbortController();
  const jobs = new ClaudeProjectJobs(execute);
  let checking = false;
  const checkAuthority = async () => {
    try {
      await authorize();
    } catch (error) {
      paused = true;
      generation.abort();
      await jobs.cancelAll();
      throw error;
    }
  };
  // Long jobs must not retain execution authority indefinitely between tool calls.
  const authorityTimer = setInterval(() => {
    if (!jobs.running || checking || fenced || paused) return;
    checking = true;
    void checkAuthority()
      .catch(() => {})
      .finally(() => {
        checking = false;
      });
  }, 30_000);
  authorityTimer.unref();
  const running = new Set<Promise<void>>();
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    if (sockets.size >= MAX_OPEN_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
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
      const signal = generation.signal;
      const task = (async () => {
        try {
          const request = JSON.parse(input.slice(0, newline));
          const tool = request?.tool ?? "project_exec";
          const args = request?.args;
          if (
            request?.token !== token ||
            !args ||
            typeof args !== "object" ||
            Array.isArray(args)
          )
            throw Error("Invalid project tool request");
          await checkAuthority();
          signal.throwIfAborted();
          if (fenced || paused) throw Error("Project tool is closed");
          let result;
          if (tool === "project_exec") result = await jobs.start(args);
          else if (tool === "project_exec_wait") result = await jobs.wait(args);
          else if (tool === "project_exec_cancel")
            result = await jobs.cancel(args);
          else if (tool === "project_exec_list") result = jobs.list();
          else throw Error("Unsupported project tool");
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
      running.add(task);
      void task.finally(() => running.delete(task));
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
      resume: () => {
        if (!fenced) {
          paused = false;
          if (generation.signal.aborted) generation = new AbortController();
          jobs.resume();
        }
      },
      cancel: async () => {
        paused = true;
        const previous = [...running];
        generation.abort();
        generation = new AbortController();
        await jobs.cancelAll();
        await Promise.allSettled(previous);
      },
      close: () =>
        (closed ??= (async () => {
          fenced = true;
          clearInterval(authorityTimer);
          generation.abort();
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await jobs.close();
          await Promise.allSettled([...running]);
          await rm(directory, { recursive: true, force: true });
        })()),
    };
  } catch (error) {
    clearInterval(authorityTimer);
    await jobs.close();
    if (server.listening) server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
