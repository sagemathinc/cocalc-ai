/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { CLAUDE_PROJECT_MCP_SOURCE } from "./claude-project-tool-source";
import type { HarnessProcess } from "@cocalc/ai/acp/harness";
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
import {
  editProjectFile,
  readProjectFile,
  runCaptured,
  shellQuote,
  validPath,
  writeProjectFile,
} from "./claude-project-file-tools";
import { validateMemoryName } from "@cocalc/conat/agents/memory";

// Room for project_write_file content (1 MB, JSON-escaped).
const MAX_REQUEST_BYTES = 2_500_000;
const MAX_CONCURRENT_TOOLS = 8;
const MAX_OPEN_CONNECTIONS = 16;
export const CLAUDE_PROJECT_TOOL_MOUNT = "/run/cocalc/agent-tools";
// Base64 of this must fit the MCP transport's 1.2 MB response limit.
export const MAX_PROJECT_IMAGE_BYTES = 800_000;

const IMAGE_SIGNATURES: {
  mimeType: string;
  matches: (b: Buffer) => boolean;
}[] = [
  {
    mimeType: "image/png",
    matches: (b) =>
      b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  },
  {
    mimeType: "image/jpeg",
    matches: (b) => b.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")),
  },
  {
    mimeType: "image/gif",
    matches: (b) => b.subarray(0, 6).toString("latin1").startsWith("GIF8"),
  },
  {
    mimeType: "image/webp",
    matches: (b) =>
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

// Reads one image with the same project authority as project_exec. The type
// comes from the file's bytes, not its name.
export async function readProjectImage(
  execute: ProjectJobExecutor,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<
  | { path: string; bytes: number; image: { data: string; mimeType: string } }
  | { error: string }
> {
  const path = args.path;
  if (!validPath(path)) return { error: "path must be a non-empty file path" };
  const limit = MAX_PROJECT_IMAGE_BYTES;
  const script = [
    `p=${shellQuote(path)}`,
    `[ -f "$p" ] || { echo "not a readable file: $p" >&2; exit 2; }`,
    `s=$(stat -L -c %s -- "$p") || exit 2`,
    `[ "$s" -le ${limit} ] || { echo "image is $s bytes; the limit is ${limit} bytes. Save a smaller or cropped copy and read that." >&2; exit 3; }`,
    `base64 -w0 -- "$p"`,
  ].join("\n");
  const out = await runCaptured(
    execute,
    script,
    signal,
    Math.ceil((limit * 4) / 3) + 64,
  );
  if (out.code !== 0)
    return { error: out.stderr.trim() || `could not read ${path}` };
  const stdout = out.stdout;
  const bytes = Buffer.from(stdout.trim(), "base64");
  const type = IMAGE_SIGNATURES.find(({ matches }) => matches(bytes));
  if (!type)
    return {
      error: `${path} is not a PNG, JPEG, GIF or WebP image. Convert it first (for example, render an SVG or PDF page to PNG).`,
    };
  return {
    path,
    bytes: bytes.length,
    image: { data: bytes.toString("base64"), mimeType: type.mimeType },
  };
}

const COCALC_CLI = '"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"';

// Claude's memory tools run the same CLI command as Codex and other agents, in
// the project with this turn's runtime identity; the hub resolves the account
// from that identity and enforces opt-in, limits and validation.
export async function runAgentMemoryTool(
  execute: ProjectJobExecutor,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const b64 = (value: unknown) =>
    Buffer.from(String(value ?? ""), "utf8").toString("base64");
  let script: string;
  if (tool === "memory_list") script = `${COCALC_CLI} project chat memory list`;
  else if (tool === "memory_read")
    script = `${COCALC_CLI} project chat memory read ${shellQuote(validateMemoryName(args.name))}`;
  else if (tool === "memory_delete")
    script = `${COCALC_CLI} project chat memory delete ${shellQuote(validateMemoryName(args.name))}`;
  else if (tool === "memory_write")
    script = `printf %s '${b64(args.body)}' | base64 -d | ${COCALC_CLI} project chat memory write ${shellQuote(validateMemoryName(args.name))} --description "$(printf %s '${b64(args.description)}' | base64 -d)" --stdin`;
  else throw Error("Unsupported project tool");
  const out = await runCaptured(execute, script, signal, 1_000_000);
  let parsed: any;
  try {
    parsed = JSON.parse(out.stdout);
  } catch {
    return { error: out.stderr.trim() || "agent memory command failed" };
  }
  if (parsed?.ok) return parsed.data;
  return { error: parsed?.error?.message ?? "agent memory command failed" };
}

export interface ClaudeProjectToolBridge {
  directory: string;
  cancel(): Promise<void>;
  resume(): void;
  close(): Promise<void>;
  setAsyncQuestionHandler: NonNullable<
    HarnessProcess["setAsyncQuestionHandler"]
  >;
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
  let asyncQuestion:
    | Parameters<ClaudeProjectToolBridge["setAsyncQuestionHandler"]>[0]
    | undefined;
  let generation = new AbortController();
  const jobs = new ClaudeProjectJobs(execute);
  let authorityCheck: Promise<AbortSignal> | undefined;
  // Share checks (including failed-check cleanup) so an older result cannot
  // invalidate a newly authorized generation. Explicit cancel/close stay final
  // until the caller resumes; an authority failure alone is recoverable.
  const checkAuthority = (): Promise<AbortSignal> =>
    (authorityCheck ??= (async () => {
      const current = generation;
      if (fenced || paused) throw Error("Project tool is closed");
      try {
        await authorize();
      } catch (error) {
        if (generation === current && !fenced && !paused) {
          current.abort();
          await jobs.cancelAll();
        }
        throw error;
      }
      if (fenced || paused || generation !== current)
        throw Error("Project tool is closed");
      if (current.signal.aborted) {
        generation = new AbortController();
        jobs.resume();
      }
      return generation.signal;
    })().finally(() => {
      authorityCheck = undefined;
    }));
  // Long jobs must not retain execution authority indefinitely between tool calls.
  const authorityTimer = setInterval(() => {
    if (!jobs.running || authorityCheck || fenced || paused) return;
    void checkAuthority().catch(() => {});
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
      if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
        // Say why rather than dropping the connection, which the helper can
        // only report as "Project tool disconnected".
        socket.removeAllListeners("data");
        socket.end(
          JSON.stringify({
            error: `Project tool request too large: over ${MAX_REQUEST_BYTES} bytes. Split it into smaller calls (for example, write a large file in parts).`,
          }) + "\n",
        );
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      socket.removeAllListeners("data");
      if (active >= MAX_CONCURRENT_TOOLS) {
        socket.end(JSON.stringify({ error: "Project tool is busy" }) + "\n");
        return;
      }
      active++;
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
          const signal = await checkAuthority();
          signal.throwIfAborted();
          if (fenced || paused) throw Error("Project tool is closed");
          let result;
          if (tool === "project_exec") result = await jobs.start(args);
          else if (tool === "project_exec_wait") result = await jobs.wait(args);
          else if (tool === "project_exec_cancel")
            result = await jobs.cancel(args);
          else if (tool === "project_exec_list") result = jobs.list();
          else if (tool === "project_read_image")
            result = await readProjectImage(jobs.executeTool, args, signal);
          else if (tool === "project_read_file")
            result = await readProjectFile(jobs.executeTool, args, signal);
          else if (tool === "project_write_file")
            result = await writeProjectFile(jobs.executeTool, args, signal);
          else if (tool === "project_edit_file")
            result = await editProjectFile(jobs.executeTool, args, signal);
          else if (tool.startsWith("memory_"))
            result = await runAgentMemoryTool(
              jobs.executeTool,
              tool,
              args,
              signal,
            );
          else if (tool === "request_user_input_async" && asyncQuestion)
            result = await asyncQuestion(args);
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
    await writeFile(join(directory, "bridge.cjs"), CLAUDE_PROJECT_MCP_SOURCE, {
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
      setAsyncQuestionHandler: (handler) => {
        asyncQuestion = handler;
      },
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
