/**
 * CLI daemon server runtime.
 *
 * This module hosts request routing for daemon file actions, context caching,
 * and the long-running UNIX-socket daemon lifecycle used by CLI file commands.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import {
  createServer as createNetServer,
  type Server as NetServer,
} from "node:net";
import { dirname } from "node:path";

import {
  daemonPidPath,
  daemonRequestId,
  daemonRequestWithAutoStart,
  daemonSocketPath,
  type DaemonRequest,
  type DaemonResponse,
} from "./daemon-transport";

export type DaemonServerState<Ctx> = {
  startedAtMs: number;
  socketPath: string;
  pidPath: string;
  contexts: Map<string, Ctx>;
  server?: NetServer;
  closing: boolean;
};

type DaemonServerDeps<Ctx> = {
  daemonContextKey: (globals: any) => string;
  contextForGlobals: (globals: any) => Promise<Ctx>;
  closeCommandContext: (ctx: Ctx | undefined) => void;
  globalsFrom: (command: unknown) => any;
  daemonContextMeta: (ctx: Ctx) => { api: string; account_id: string };
  projectFileListData: (args: any) => Promise<any>;
  projectFileCatData: (args: any) => Promise<any>;
  projectFilePutData: (args: any) => Promise<any>;
  projectFileGetData: (args: any) => Promise<any>;
  projectFileRmData: (args: any) => Promise<any>;
  projectFileMkdirData: (args: any) => Promise<any>;
  projectFileRgData: (args: any) => Promise<any>;
  projectFileFdData: (args: any) => Promise<any>;
};

export function createDaemonServerOps<Ctx>(deps: DaemonServerDeps<Ctx>) {
  const {
    daemonContextKey,
    contextForGlobals,
    closeCommandContext,
    globalsFrom,
    daemonContextMeta,
    projectFileListData,
    projectFileCatData,
    projectFilePutData,
    projectFileGetData,
    projectFileRmData,
    projectFileMkdirData,
    projectFileRgData,
    projectFileFdData,
  } = deps;

  async function getDaemonContext(
    state: DaemonServerState<Ctx>,
    globals: any,
  ): Promise<Ctx> {
    const key = daemonContextKey(globals);
    const existing = state.contexts.get(key);
    if (existing) {
      return existing;
    }
    const ctx = await contextForGlobals({ ...globals, noDaemon: true });
    state.contexts.set(key, ctx);
    return ctx;
  }

  function closeDaemonServerState(state: DaemonServerState<Ctx>): void {
    for (const ctx of state.contexts.values()) {
      closeCommandContext(ctx);
    }
    state.contexts.clear();
    try {
      state.server?.close();
    } catch {
      // ignore
    }
    try {
      if (existsSync(state.socketPath)) unlinkSync(state.socketPath);
    } catch {
      // ignore
    }
    try {
      if (existsSync(state.pidPath)) unlinkSync(state.pidPath);
    } catch {
      // ignore
    }
  }

  async function handleDaemonAction(
    state: DaemonServerState<Ctx>,
    request: DaemonRequest,
  ): Promise<DaemonResponse> {
    const meta = {
      pid: process.pid,
      uptime_s: Math.max(
        0,
        Math.floor((Date.now() - state.startedAtMs) / 1000),
      ),
      started_at: new Date(state.startedAtMs).toISOString(),
    };
    try {
      switch (request.action) {
        case "ping":
          return { id: request.id, ok: true, data: { status: "ok" }, meta };
        case "shutdown":
          state.closing = true;
          setTimeout(() => {
            closeDaemonServerState(state);
            process.exit(0);
          }, 10);
          return {
            id: request.id,
            ok: true,
            data: { status: "shutting_down" },
            meta,
          };
        case "project.file.list": {
          const globals = request.globals ?? {};
          const cwd =
            typeof request.cwd === "string" ? request.cwd : process.cwd();
          const ctx = await getDaemonContext(state, globals);
          const data = await projectFileListData({
            ctx,
            projectIdentifier:
              typeof request.payload?.project === "string"
                ? request.payload.project
                : undefined,
            path:
              typeof request.payload?.path === "string"
                ? request.payload.path
                : undefined,
            cwd,
          });
          return {
            id: request.id,
            ok: true,
            data,
            meta: {
              ...meta,
              ...daemonContextMeta(ctx),
            },
          };
        }
        case "project.file.cat": {
          const globals = request.globals ?? {};
          const cwd =
            typeof request.cwd === "string" ? request.cwd : process.cwd();
          const path =
            typeof request.payload?.path === "string"
              ? request.payload.path
              : "";
          if (!path) {
            throw new Error("project file cat requires path");
          }
          const ctx = await getDaemonContext(state, globals);
          const data = await projectFileCatData({
            ctx,
            projectIdentifier:
              typeof request.payload?.project === "string"
                ? request.payload.project
                : undefined,
            path,
            cwd,
          });
          return {
            id: request.id,
            ok: true,
            data,
            meta: {
              ...meta,
              ...daemonContextMeta(ctx),
            },
          };
        }
        case "project.file.put": {
          const globals = request.globals ?? {};
          const cwd =
            typeof request.cwd === "string" ? request.cwd : process.cwd();
          const dest =
            typeof request.payload?.dest === "string"
              ? request.payload.dest
              : "";
          const contentBase64 =
            typeof request.payload?.content_base64 === "string"
              ? request.payload.content_base64
              : "";
          if (!dest) {
            throw new Error("project file put requires dest");
          }
          const data = Buffer.from(contentBase64, "base64");
          const ctx = await getDaemonContext(state, globals);
          const result = await projectFilePutData({
            ctx,
            projectIdentifier:
              typeof request.payload?.project === "string"
                ? request.payload.project
                : undefined,
            dest,
            data,
            parents: request.payload?.parents !== false,
            cwd,
          });
          return {
            id: request.id,
            ok: true,
            data: result,
            meta: {
              ...meta,
              ...daemonContextMeta(ctx),
            },
          };
        }
        case "project.file.get": {
          const globals = request.globals ?? {};
          const cwd =
            typeof request.cwd === "string" ? request.cwd : process.cwd();
          const src =
            typeof request.payload?.src === "string" ? request.payload.src : "";
          if (!src) {
            throw new Error("project file get requires src");
          }
          const ctx = await getDaemonContext(state, globals);
          const data = await projectFileGetData({
            ctx,
            projectIdentifier:
              typeof request.payload?.project === "string"
                ? request.payload.project
                : undefined,
            src,
            cwd,
          });
          return {
            id: request.id,
            ok: true,
            data,
            meta: {
              ...meta,
              ...daemonContextMeta(ctx),
            },
          };
        }
        case "project.file.rm": {
          const globals = request.globals ?? {};
          const cwd =
            typeof request.cwd === "string" ? request.cwd : process.cwd();
          const path =
            typeof request.payload?.path === "string"
              ? request.payload.path
              : "";
          if (!path) {
            throw new Error("project file rm requires path");
          }
          const ctx = await getDaemonContext(state, globals);
          const data = await projectFileRmData({
            ctx,
            projectIdentifier:
              typeof request.payload?.project === "string"
                ? request.payload.project
                : undefined,
            path,
            recursive: request.payload?.recursive === true,
            force: request.payload?.force === true,
            cwd,
          });
          return {
            id: request.id,
            ok: true,
            data,
            meta: {
              ...meta,
              ...daemonContextMeta(ctx),
            },
          };
        }
        case "project.file.mkdir": {
          const globals = request.globals ?? {};
          const cwd =
            typeof request.cwd === "string" ? request.cwd : process.cwd();
          const path =
            typeof request.payload?.path === "string"
              ? request.payload.path
              : "";
          if (!path) {
            throw new Error("project file mkdir requires path");
          }
          const ctx = await getDaemonContext(state, globals);
          const data = await projectFileMkdirData({
            ctx,
            projectIdentifier:
              typeof request.payload?.project === "string"
                ? request.payload.project
                : undefined,
            path,
            parents: request.payload?.parents !== false,
            cwd,
          });
          return {
            id: request.id,
            ok: true,
            data,
            meta: {
              ...meta,
              ...daemonContextMeta(ctx),
            },
          };
        }
        case "project.file.rg": {
          const globals = request.globals ?? {};
          const cwd =
            typeof request.cwd === "string" ? request.cwd : process.cwd();
          const pattern =
            typeof request.payload?.pattern === "string"
              ? request.payload.pattern
              : "";
          if (!pattern) {
            throw new Error("project file rg requires pattern");
          }
          const timeoutMs = Math.max(
            1,
            Number(request.payload?.timeout_ms ?? 30_000) || 30_000,
          );
          const maxBytes = Math.max(
            1024,
            Number(request.payload?.max_bytes ?? 20000000) || 20000000,
          );
          const rgOptions = Array.isArray(request.payload?.rg_options)
            ? request.payload?.rg_options.filter(
                (x): x is string => typeof x === "string",
              )
            : undefined;
          const ctx = await getDaemonContext(state, globals);
          const data = await projectFileRgData({
            ctx,
            projectIdentifier:
              typeof request.payload?.project === "string"
                ? request.payload.project
                : undefined,
            pattern,
            path:
              typeof request.payload?.path === "string"
                ? request.payload.path
                : undefined,
            timeoutMs,
            maxBytes,
            options: rgOptions,
            cwd,
          });
          return {
            id: request.id,
            ok: true,
            data,
            meta: {
              ...meta,
              ...daemonContextMeta(ctx),
            },
          };
        }
        case "project.file.fd": {
          const globals = request.globals ?? {};
          const cwd =
            typeof request.cwd === "string" ? request.cwd : process.cwd();
          const timeoutMs = Math.max(
            1,
            Number(request.payload?.timeout_ms ?? 30_000) || 30_000,
          );
          const maxBytes = Math.max(
            1024,
            Number(request.payload?.max_bytes ?? 20000000) || 20000000,
          );
          const fdOptions = Array.isArray(request.payload?.fd_options)
            ? request.payload?.fd_options.filter(
                (x): x is string => typeof x === "string",
              )
            : undefined;
          const ctx = await getDaemonContext(state, globals);
          const data = await projectFileFdData({
            ctx,
            projectIdentifier:
              typeof request.payload?.project === "string"
                ? request.payload.project
                : undefined,
            pattern:
              typeof request.payload?.pattern === "string"
                ? request.payload.pattern
                : undefined,
            path:
              typeof request.payload?.path === "string"
                ? request.payload.path
                : undefined,
            timeoutMs,
            maxBytes,
            options: fdOptions,
            cwd,
          });
          return {
            id: request.id,
            ok: true,
            data,
            meta: {
              ...meta,
              ...daemonContextMeta(ctx),
            },
          };
        }
        default:
          throw new Error(`unsupported daemon action '${request.action}'`);
      }
    } catch (err) {
      return {
        id: request.id,
        ok: false,
        error: err instanceof Error ? err.message : `${err}`,
        meta,
      };
    }
  }

  async function serveDaemon(socketPath = daemonSocketPath()): Promise<void> {
    mkdirSync(dirname(socketPath), { recursive: true });
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath);
    } catch {
      // ignore
    }
    const state: DaemonServerState<Ctx> = {
      startedAtMs: Date.now(),
      socketPath,
      pidPath: daemonPidPath(),
      contexts: new Map(),
      closing: false,
    };
    writeFileSync(state.pidPath, `${process.pid}\n`, "utf8");

    const server = createNetServer((socket) => {
      let buffer = "";
      socket.on("data", async (chunk) => {
        buffer += chunk.toString("utf8");
        while (true) {
          const idx = buffer.indexOf("\n");
          if (idx < 0) break;
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let request: DaemonRequest;
          try {
            request = JSON.parse(line) as DaemonRequest;
          } catch (err) {
            const response: DaemonResponse = {
              id: daemonRequestId(),
              ok: false,
              error: `invalid daemon request JSON: ${
                err instanceof Error ? err.message : `${err}`
              }`,
              meta: { pid: process.pid },
            };
            socket.write(`${JSON.stringify(response)}\n`);
            continue;
          }
          const response = await handleDaemonAction(state, request);
          socket.write(`${JSON.stringify(response)}\n`);
        }
      });
    });
    state.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const terminate = () => {
      if (state.closing) return;
      state.closing = true;
      closeDaemonServerState(state);
      process.exit(0);
    };
    process.on("SIGINT", terminate);
    process.on("SIGTERM", terminate);

    await new Promise<void>(() => {
      // wait forever until signal/shutdown
    });
  }

  async function runDaemonRequestFromCommand(
    command: unknown,
    request: Omit<DaemonRequest, "id" | "globals">,
  ): Promise<DaemonResponse> {
    const globals = globalsFrom(command);
    return await daemonRequestWithAutoStart({
      id: daemonRequestId(),
      action: request.action,
      payload: request.payload,
      cwd: process.cwd(),
      globals: { ...globals, noDaemon: true },
    });
  }

  return {
    serveDaemon,
    runDaemonRequestFromCommand,
  };
}
