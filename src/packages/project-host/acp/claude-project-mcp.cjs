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
  {
    name: "project_read_image",
    description:
      "View an image file saved in the CoCalc project (PNG, JPEG, GIF or WebP, up to 800 KB), such as a screenshot, plot or rendered page, returned as an image you can see. Use it to check visual results instead of describing or measuring them indirectly. For SVG or PDF, render a PNG first; for large images, save a smaller or cropped copy.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Image path in the project; relative paths start in the turn's project working directory",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "project_read_file",
    description:
      "Read a text file in the CoCalc project. Returns lines prefixed with their line numbers and a tab (like cat -n), plus total_lines. Reads up to 2000 lines from offset by default and at most 256 KB; use offset and limit to page through larger files. Prefer this over sed/cat through project_exec. Binary files are refused; use project_read_image for images.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "File path in the project; relative paths start in the turn's project working directory",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "First line to return (1-based); default 1",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Maximum number of lines to return; default 2000",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "project_edit_file",
    description:
      "Edit a text file in the CoCalc project by exact string replacement. old_string must match the file exactly, including indentation, without the line-number prefixes from project_read_file, and must occur exactly once unless replace_all is true. The file is replaced atomically and the edit is refused if the file changed during it. Files up to 1 MB.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "File path in the project; relative paths start in the turn's project working directory",
        },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: {
          type: "boolean",
          description: "Replace every occurrence instead of requiring one",
        },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "project_write_file",
    description:
      "Create or overwrite a text file in the CoCalc project with the given content (up to 1 MB), atomically and keeping an existing file's permissions. Prefer project_edit_file for changes to existing files. The parent directory must exist unless create_dirs is true.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "File path in the project; relative paths start in the turn's project working directory",
        },
        content: { type: "string", description: "Complete new file content" },
        create_dirs: {
          type: "boolean",
          description: "Create missing parent directories",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "request_user_input_async",
    description:
      "Ask the user one to three short questions while continuing useful work. Returns immediately after saving a question card; the reply arrives as a user message during this turn, or a continuation if the turn has finished. Do not poll or stop unrelated work waiting for a reply. Use only for missing information, preferences, or clarification, never authentication, secrets, or permission escalation. Use a unique request_id and reuse it only when retrying the identical request.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" },
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "The complete, self-contained question",
              },
              options: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
                description:
                  "Optional suggested answers; free text is always available",
              },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      required: ["request_id", "questions"],
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
      const image = output.image;
      result =
        message.params.name === "project_read_file" &&
        typeof output.content === "string"
          ? {
              content: [
                {
                  type: "text",
                  text:
                    `${output.path}: lines ${output.start_line}-${output.end_line} of ${output.total_lines}` +
                    (output.truncated
                      ? " (truncated at 256 KB; continue with offset)"
                      : "") +
                    "\n" +
                    output.content,
                },
              ],
              isError: false,
            }
          : image && typeof image.data === "string"
            ? {
                content: [
                  { type: "image", data: image.data, mimeType: image.mimeType },
                  {
                    type: "text",
                    text: JSON.stringify({
                      path: output.path,
                      bytes: output.bytes,
                      mimeType: image.mimeType,
                    }),
                  },
                ],
                isError: false,
              }
            : {
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
  if (line.length > 2600000) return;
  try {
    void handle(JSON.parse(line));
  } catch {
    /* Ignore malformed notifications. */
  }
});
module.exports = {};
