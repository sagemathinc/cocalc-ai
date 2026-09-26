// @ts-check
/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
/* Trusted controller-side MCP transport. Project effects go only through the scoped socket. */
const fs = require("node:fs");
const net = require("node:net");
const readline = require("node:readline");
const root = process.env.COCALC_PROJECT_TOOL_DIR || "/run/cocalc/agent-tools";
const token = fs.readFileSync(root + "/token", "utf8");
const tools = [
  {
    name: "project_exec",
    description:
      "Start a managed command in the CoCalc project, not the Claude controller. Run builds in the foreground: do NOT use &/nohup/setsid to avoid a tool timeout. Returns promptly with job_id and status; running is NOT failure. Use project_exec_wait with next_cursor to continue reading until completion, or project_exec_cancel to stop it. Project files/secrets are accessible; subscription login material is not. Jobs belong to this controller and stop on cancellation, revocation, shutdown or deadline. For intentionally persistent services or interactive input use the existing CoCalc CLI project terminal facilities.",
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description: "Shell script to run in the project",
        },
        cwd: {
          type: "string",
          description: "Optional project-container working directory",
        },
        yield_time_ms: {
          type: "integer",
          minimum: 0,
          maximum: 30000,
          description:
            "How long this tool waits, not a job deadline; default 10000 ms",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          maximum: 86400000,
          description:
            "Job wall-clock deadline; default 1 hour, maximum 24 hours",
        },
        request_id: {
          type: "string",
          description:
            "Optional unique retry ID. Reuse only for the identical command; if a response is lost, list jobs instead of blindly rerunning.",
        },
      },
      required: ["script"],
      additionalProperties: false,
    },
  },
  {
    name: "project_exec_wait",
    description:
      "Read/poll a project job. Waits until completion, a full output page, or yield_time_ms (default 10000 ms), not just the first output chunk. Pass its next_cursor as cursor for incremental output. Repeating a cursor replays retained output. Continue while status is running or has_more is true. cleanup_pending with cleanup_error means runtime cleanup is unconfirmed: do not claim cancellation succeeded or retry execution; report the runtime failure. output_truncated means older output was evicted: redirect verbose logs to a project file when full history is needed. Polling never restarts a command. Completed jobs are retained for up to 10 minutes (at most 32 jobs).",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        cursor: { type: "integer", minimum: 0 },
        yield_time_ms: { type: "integer", minimum: 0, maximum: 30000 },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "project_exec_cancel",
    description:
      "Cancel a managed project job and wait for its supervised execution to stop. Repeated cancellation is safe.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        cursor: { type: "integer", minimum: 0 },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "project_exec_list",
    description:
      "List jobs owned by this controller, including IDs, retry IDs, status and deadlines. Use after an uncertain tool response; do not automatically repeat a command.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];
/** @param {string} tool @param {Record<string, unknown>} args @returns {Promise<any>} */
function execute(tool, args) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(root + "/tool.sock");
    socket.setEncoding("utf8");
    let received = "";
    socket.setTimeout(150000, () =>
      socket.destroy(new Error("Project tool timed out")),
    );
    socket.on("connect", () =>
      socket.write(JSON.stringify({ token, tool, args }) + "\n"),
    );
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (received.length > 1200000)
        return socket.destroy(new Error("Project tool response too large"));
      const newline = received.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(JSON.parse(received.slice(0, newline)));
      } catch {
        reject(new Error("Invalid project tool response"));
      }
      socket.end();
    });
    socket.on("error", reject);
    socket.on("close", () => {
      if (!received.includes("\n"))
        reject(new Error("Project tool disconnected"));
    });
  });
}
/** @param {any} message */
async function handle(message) {
  if (!message || typeof message !== "object" || message.id === undefined)
    return;
  const id = message.id;
  try {
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "cocalc-project-tools", version: "2" },
      };
    } else if (message.method === "ping") {
      result = {};
    } else if (message.method === "tools/list") {
      result = { tools };
    } else if (
      message.method === "tools/call" &&
      tools.some((tool) => tool.name === message.params?.name)
    ) {
      const output = await execute(
        message.params.name,
        message.params.arguments ?? {},
      );
      const canceledSuccessfully =
        message.params.name === "project_exec_cancel" &&
        output.status &&
        !output.cleanup_pending;
      const isError =
        !!output.error ||
        (output.status
          ? !canceledSuccessfully &&
            ["failed", "canceled", "timed_out"].includes(output.status)
          : "code" in output && output.code !== 0);
      result = {
        content: [{ type: "text", text: JSON.stringify(output) }],
        isError,
      };
    } else {
      throw new Error("Unsupported project tool method");
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: error.message || "Project tool failed",
        },
      }) + "\n",
    );
  }
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (line.length > 65536) return;
  try {
    void handle(JSON.parse(line));
  } catch {
    /* Ignore malformed notifications. */
  }
});
module.exports = {};
