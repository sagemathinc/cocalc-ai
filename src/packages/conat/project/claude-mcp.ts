/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Claude MCP servers, run inside the project.

A Claude agent on a subscription runs in an isolated controller outside the
project, so the user's MCP servers can't run there (they are arbitrary code,
and would sit next to the subscription credential). Instead this service, in
the project daemon, starts the configured server as an ordinary project
process and relays its stdio over a conat socket; the project host relays that
to the agent (and decides what the server may ask of the agent).

Protocol: the client's first message is {name, scope, digest, cwd}. The
service reads Claude Code's config itself (never a command from the caller),
starts that server only if the same name and scope still have that digest,
answers {ready: true} (or {error}), then relays raw stdio bytes both ways
until either side closes. The project's collaborators can reach this service
too, like terminals: they can already start any process in the project, and
it only ever starts servers named in the project's own config.
*/

import type { Client as ConatClient } from "@cocalc/conat/core/client";
import type { ConatSocketServer, ServerSocket } from "@cocalc/conat/socket";
import { getLogger } from "@cocalc/conat/logger";
import {
  claudeMcpServers,
  expandClaudeMcpVariables,
  type ClaudeMcpStdioServer,
} from "@cocalc/util/ai/claude-mcp-config";

const logger = getLogger("conat:project:claude-mcp");

/** Running servers per project. */
export const MAX_CLAUDE_MCP_PROCESSES = 8;
/** A relay with no traffic either way for this long is closed. */
export const CLAUDE_MCP_IDLE_MS = 30 * 60_000;
/** Kept from a server's stderr, for diagnostics. */
const MAX_STDERR = 64 * 1024;
/** Between SIGTERM and SIGKILL of a server's process group. */
const KILL_GRACE_MS = 5_000;

export function claudeMcpSubject(project_id: string): string {
  return `claude-mcp.project-${project_id}.0`;
}

export interface ClaudeMcpSetup {
  name: string;
  scope: string;
  digest: string;
  cwd: string;
}

/** A started server: stdio streams and its process group. */
export interface ClaudeMcpProcess {
  pid?: number;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface ClaudeMcpRuntime {
  /** The project's home (for ~/.claude.json and ~/.claude/settings.json). */
  home: string;
  /** Parsed JSON of a file, or undefined if missing, too big or invalid. */
  readJson(path: string): Promise<unknown>;
  /** Start a server detached, in its own process group. */
  spawn(opts: {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  }): ClaudeMcpProcess;
  /** Signal a process group. */
  killGroup(pid: number, signal: NodeJS.Signals): void;
  /** The environment servers start from (no CoCalc internals). */
  baseEnv(): Record<string, string>;
}

/** The project environment without CoCalc's own variables. */
export function claudeMcpBaseEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (value == null) continue;
    if (
      name.startsWith("COCALC_") ||
      name.startsWith("DEBUG") ||
      name === "NODE_ENV"
    )
      continue;
    env[name] = value;
  }
  return env;
}

/** The servers configured for an agent working in `cwd` (for its session's
 * list), and those skipped, with why. */
export async function listClaudeMcpConfig(
  runtime: Pick<ClaudeMcpRuntime, "home" | "readJson">,
  cwd: unknown,
): Promise<
  | {
      servers: { name: string; scope: string; digest: string }[];
      skipped: { name: string; scope: string; reason: string }[];
    }
  | { error: string }
> {
  if (typeof cwd !== "string" || !cwd.startsWith("/"))
    return { error: "invalid MCP setup" };
  const [claudeJson, userSettings, mcpJson] = await Promise.all([
    runtime.readJson(`${runtime.home}/.claude.json`),
    runtime.readJson(`${runtime.home}/.claude/settings.json`),
    runtime.readJson(`${cwd.replace(/\/+$/, "")}/.mcp.json`),
  ]);
  const { servers, skipped } = claudeMcpServers({
    claudeJson,
    userSettings,
    mcpJson,
    cwd,
  });
  return {
    servers: servers.map(({ name, scope, digest }) => ({ name, scope, digest })),
    skipped,
  };
}

/** The server a setup names, if the project's config still has it. */
export async function resolveClaudeMcpServer(
  runtime: Pick<ClaudeMcpRuntime, "home" | "readJson">,
  setup: ClaudeMcpSetup,
): Promise<ClaudeMcpStdioServer | { error: string }> {
  if (
    !setup ||
    typeof setup.name !== "string" ||
    typeof setup.scope !== "string" ||
    typeof setup.digest !== "string" ||
    typeof setup.cwd !== "string" ||
    !setup.cwd.startsWith("/")
  )
    return { error: "invalid MCP setup" };
  const [claudeJson, userSettings, mcpJson] = await Promise.all([
    runtime.readJson(`${runtime.home}/.claude.json`),
    runtime.readJson(`${runtime.home}/.claude/settings.json`),
    runtime.readJson(`${setup.cwd.replace(/\/+$/, "")}/.mcp.json`),
  ]);
  const { servers } = claudeMcpServers({
    claudeJson,
    userSettings,
    mcpJson,
    cwd: setup.cwd,
  });
  const server = servers.find(
    (s) => s.name === setup.name && s.scope === setup.scope,
  );
  if (!server)
    return { error: `MCP server ${setup.name} is no longer configured` };
  if (server.digest !== setup.digest)
    return {
      error: `MCP server ${setup.name} changed since the session started`,
    };
  return server;
}

/**
 * Serve one relay: resolve, start, pipe, and stop the server's whole
 * process group when the relay ends.
 */
export function serveClaudeMcpSocket(
  socket: Pick<ServerSocket, "on" | "write" | "close">,
  runtime: ClaudeMcpRuntime,
  admit: () => (() => void) | undefined,
  idleMs = CLAUDE_MCP_IDLE_MS,
): void {
  let child: ClaudeMcpProcess | undefined;
  let release: (() => void) | undefined;
  let ended = false;
  let stderr = "";
  let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => end("idle"), idleMs);
    (idle as any).unref?.();
  };
  const end = (why: string) => {
    if (ended) return;
    ended = true;
    clearTimeout(idle);
    const pid = child?.pid;
    if (pid) {
      try {
        runtime.killGroup(pid, "SIGTERM");
      } catch {}
      const kill = setTimeout(() => {
        try {
          runtime.killGroup(pid, "SIGKILL");
        } catch {}
      }, KILL_GRACE_MS);
      (kill as any).unref?.();
    }
    release?.();
    logger.debug("claude mcp relay ended", { why });
    try {
      socket.close();
    } catch {}
  };
  const send = (data: Buffer | string, headers?: Record<string, unknown>) => {
    try {
      socket.write(data, headers ? { headers } : undefined);
      touch();
    } catch {
      // ENOBUFS (the agent side isn't reading) or EPIPE: give up on it.
      end("write failed");
    }
  };
  socket.on("closed", () => end("socket closed"));
  let started = false;
  socket.on("data", (data: any) => {
    if (ended) return;
    if (started) {
      touch();
      try {
        child?.stdin.write(typeof data === "string" ? data : Buffer.from(data));
      } catch {
        end("server stdin failed");
      }
      return;
    }
    started = true;
    void (async () => {
      let setup: ClaudeMcpSetup & { list?: boolean };
      try {
        setup = typeof data === "string" ? JSON.parse(data) : data;
      } catch {
        send("", { error: "invalid MCP setup" });
        return end("invalid setup");
      }
      if (setup?.list === true) {
        // Only the list: nothing starts.
        send("", { list: await listClaudeMcpConfig(runtime, setup.cwd) });
        return end("listed");
      }
      const server = await resolveClaudeMcpServer(runtime, setup);
      if (ended) return;
      if ("error" in server) {
        send("", { error: server.error });
        return end("refused");
      }
      release = admit();
      if (!release) {
        send("", {
          error: `at most ${MAX_CLAUDE_MCP_PROCESSES} MCP servers may run in a project`,
        });
        return end("limit");
      }
      const env = { ...runtime.baseEnv(), ...server.env };
      const expand = (value: string) => expandClaudeMcpVariables(value, env);
      try {
        child = runtime.spawn({
          command: expand(server.command),
          args: server.args.map(expand),
          cwd: setup.cwd,
          env: Object.fromEntries(
            Object.entries(env).map(([k, v]) => [k, expand(v)]),
          ),
        });
      } catch (error) {
        send("", { error: `could not start MCP server: ${error}` });
        return end("spawn failed");
      }
      // A stream error (EPIPE once the server died) must never reach the
      // project daemon as an unhandled error.
      child.stdin.on("error", () => end("server stdin closed"));
      child.stdout.on("error", () => end("server stdout failed"));
      child.stderr.on("error", () => {});
      child.on("error", (error) => {
        send("", { error: `MCP server failed: ${error.message}` });
        end("process error");
      });
      child.on("exit", (code) => {
        send("", { exit: code, stderr: stderr.slice(-4000) });
        end("exited");
      });
      child.stdout.on("data", (chunk: Buffer) => send(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR);
      });
      send("", { ready: true });
      touch();
    })().catch((error) => {
      send("", { error: `MCP server failed: ${error}` });
      end("setup failed");
    });
  });
}

/** The project's MCP service. */
export function claudeMcpServer({
  client,
  project_id,
  runtime,
  maxProcesses = MAX_CLAUDE_MCP_PROCESSES,
}: {
  client: ConatClient;
  project_id: string;
  runtime: ClaudeMcpRuntime;
  maxProcesses?: number;
}): ConatSocketServer {
  const server = client.socket.listen(claudeMcpSubject(project_id));
  let running = 0;
  const admit = () => {
    if (running >= maxProcesses) return undefined;
    running++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      running--;
    };
  };
  server.on("connection", (socket: ServerSocket) =>
    serveClaudeMcpSocket(socket, runtime, admit),
  );
  return server;
}
