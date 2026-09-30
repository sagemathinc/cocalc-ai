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

const MAX_REQUEST_BYTES = 40 * 1024;
const MAX_CONCURRENT_TOOLS = 8;
const MAX_OPEN_CONNECTIONS = 16;
export const CLAUDE_PROJECT_TOOL_MOUNT = "/run/cocalc/agent-tools";

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
      if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) return socket.destroy();
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
