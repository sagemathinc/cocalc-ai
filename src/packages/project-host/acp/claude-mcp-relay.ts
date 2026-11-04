/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The host's part of a Claude agent's own MCP servers: the controller's
// relay.cjs connects to the tool bridge socket, and this pipes it to the
// project's MCP service (@cocalc/conat/project/claude-mcp), which runs the
// server in the project. Policy is applied here, on the trusted side: a
// server may not make requests of Claude beyond ping and roots/list (no
// sampling, which would spend the subscription, and no elicitation).

import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import {
  claudeMcpServerLine,
  McpLineSplitter,
} from "@cocalc/util/ai/claude-mcp-relay";
import { claudeMcpSubject } from "@cocalc/conat/project/claude-mcp";
import { getLogger } from "@cocalc/backend/logger";

const logger = getLogger("project-host:acp:claude-mcp-relay");

/** Queued for the controller before the relay gives up on it. */
export const MAX_CLAUDE_MCP_QUEUED_BYTES = 4 * 1024 * 1024;
/** Lines from Claude held until the server is ready, and their bytes. */
const MAX_PENDING_LINES = 64;
/** Toward the project: sent and not yet acknowledged before reading from
 * Claude pauses, and how long it may stay paused. */
const MAX_IN_FLIGHT_BYTES = 4 * 1024 * 1024;
const STALL_MS = 30_000;
const LIST_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_MS = 60_000;

/** The project side: a conat socket to the project's MCP service. */
export interface ProjectMcpSocket {
  write(data: string | Buffer): void;
  on(event: "data", listener: (data: any, headers?: any) => void): unknown;
  on(event: "closed", listener: () => void): unknown;
  on(event: "drain", listener: () => void): unknown;
  close(): void;
}
export type ConnectProjectMcp = (subject: string) => ProjectMcpSocket;

export interface ClaudeMcpServerRef {
  name: string;
  scope: string;
  digest: string;
}

export interface ClaudeMcpList {
  servers: ClaudeMcpServerRef[];
  skipped: { name: string; scope: string; reason: string }[];
}

/** The servers configured for an agent working in `cwd`. */
export function listProjectClaudeMcpServers(
  connect: ConnectProjectMcp,
  projectId: string,
  cwd: string,
  timeoutMs = LIST_TIMEOUT_MS,
): Promise<ClaudeMcpList> {
  return new Promise((resolve, reject) => {
    const socket = connect(claudeMcpSubject(projectId));
    let done = false;
    const finish = (error?: Error, list?: ClaudeMcpList) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      if (error) reject(error);
      else resolve(list!);
    };
    const timer = setTimeout(
      () => finish(new Error("the project did not list its MCP servers")),
      timeoutMs,
    );
    socket.on("data", (_data, headers) => {
      const list = headers?.list;
      if (list?.error) finish(new Error(list.error));
      else if (list) finish(undefined, list);
      else if (headers?.error) finish(new Error(headers.error));
    });
    socket.on("closed", () =>
      finish(new Error("the project closed the MCP list request")),
    );
    socket.write(JSON.stringify({ list: true, cwd }));
  });
}

/**
 * Relay one server between the controller (a connection to the bridge
 * socket, after its first line) and the project. Returns a close function;
 * `onEnd` runs once when either side ends.
 */
export function relayClaudeMcp({
  controller,
  leftover,
  connect,
  projectId,
  server,
  cwd,
  onEnd,
  readyTimeoutMs = READY_TIMEOUT_MS,
}: {
  controller: Pick<
    Socket,
    "write" | "on" | "destroy" | "end" | "writableLength" | "pause" | "resume"
  >;
  /** What the controller already sent after its first line. */
  leftover: string;
  connect: ConnectProjectMcp;
  projectId: string;
  server: ClaudeMcpServerRef;
  cwd: string;
  onEnd: (why: string) => void;
  readyTimeoutMs?: number;
}): () => void {
  const project = connect(claudeMcpSubject(projectId));
  let ended = false;
  let ready = false;
  const pending: string[] = [];
  let pendingBytes = 0;
  let inFlight = 0;
  let stall: ReturnType<typeof setTimeout> | undefined;
  const fromClaude = new McpLineSplitter();
  const fromServer = new McpLineSplitter();
  // A character may span two chunks.
  const decoder = new StringDecoder("utf8");
  const end = (why: string) => {
    if (ended) return;
    ended = true;
    clearTimeout(readyTimer);
    clearTimeout(stall);
    try {
      project.close();
    } catch {}
    try {
      controller.end();
      controller.destroy();
    } catch {}
    logger.debug("claude mcp relay ended", { server: server.name, why });
    onEnd(why);
  };
  const readyTimer = setTimeout(
    () => end("the MCP server did not start in time"),
    readyTimeoutMs,
  );
  const toProject = (line: string) => {
    try {
      project.write(line + "\n");
    } catch {
      return end("project write failed");
    }
    // Bound what waits unacknowledged: stop reading from Claude until the
    // project catches up.
    inFlight += Buffer.byteLength(line) + 1;
    if (inFlight > MAX_IN_FLIGHT_BYTES && !stall) {
      controller.pause();
      stall = setTimeout(
        () => end("the project stopped reading the MCP relay"),
        STALL_MS,
      );
    }
  };
  const fromController = (chunk: string) => {
    let lines: string[];
    try {
      lines = fromClaude.push(chunk);
    } catch {
      return end("message from Claude too large");
    }
    for (const line of lines) {
      if (ready) toProject(line);
      else {
        pendingBytes += Buffer.byteLength(line);
        if (
          pending.length >= MAX_PENDING_LINES ||
          pendingBytes > MAX_IN_FLIGHT_BYTES
        )
          return end("too much sent before the server was ready");
        pending.push(line);
      }
    }
  };
  const toController = (line: string) => {
    if (controller.writableLength > MAX_CLAUDE_MCP_QUEUED_BYTES)
      return end("Claude is not reading the MCP server's output");
    controller.write(line + "\n");
  };

  project.on("data", (data, headers) => {
    if (ended) return;
    if (headers?.error) return end(String(headers.error));
    if (headers?.exit !== undefined) {
      logger.debug("claude mcp server exited", {
        server: server.name,
        code: headers.exit,
        stderr: `${headers.stderr ?? ""}`.slice(-1000),
      });
      return end("the MCP server exited");
    }
    if (headers?.ready) {
      ready = true;
      clearTimeout(readyTimer);
      for (const line of pending.splice(0)) toProject(line);
      return;
    }
    if (data == null || data.length === 0) return;
    let lines: string[];
    try {
      lines = fromServer.push(
        typeof data === "string" ? data : decoder.write(Buffer.from(data)),
      );
    } catch {
      return end("message from the MCP server too large");
    }
    for (const line of lines) {
      const verdict = claudeMcpServerLine(line);
      if ("forward" in verdict) toController(verdict.forward);
      else if ("answer" in verdict) toProject(verdict.answer);
    }
  });
  project.on("closed", () => end("the project closed the MCP relay"));
  project.on("drain", () => {
    inFlight = 0;
    if (stall) {
      clearTimeout(stall);
      stall = undefined;
      controller.resume();
    }
  });
  controller.on("data", (chunk: Buffer | string) =>
    fromController(typeof chunk === "string" ? chunk : chunk.toString("utf8")),
  );
  controller.on("close", () => end("Claude closed the MCP relay"));
  controller.on("error", () => end("controller connection failed"));

  project.write(
    JSON.stringify({
      name: server.name,
      scope: server.scope,
      digest: server.digest,
      cwd,
    }),
  );
  if (leftover) fromController(leftover);
  return () => end("closed by the host");
}
