/**
 * CLI daemon transport/runtime path primitives.
 *
 * This module owns socket/pid/log path resolution and client-side request
 * helpers (ping, auto-start, RPC send) used by CLI command handlers.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection as createNetConnection } from "node:net";

export const DAEMON_CONNECT_TIMEOUT_MS = 3_000;
export const DAEMON_RPC_TIMEOUT_MS = 30_000;

export type DaemonAction =
  | "ping"
  | "shutdown"
  | "workspace.file.list"
  | "workspace.file.cat"
  | "workspace.file.put"
  | "workspace.file.get"
  | "workspace.file.rm"
  | "workspace.file.mkdir"
  | "workspace.file.rg"
  | "workspace.file.fd";

export type DaemonRequest = {
  id: string;
  action: DaemonAction;
  cwd?: string;
  globals?: any;
  payload?: Record<string, unknown>;
};

export type DaemonResponse = {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  meta?: {
    api?: string | null;
    account_id?: string | null;
    pid?: number;
    uptime_s?: number;
    started_at?: string;
  };
};

function daemonRuntimeDir(env = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  if (runtime) {
    return join(runtime, "cocalc");
  }
  const cache = env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(cache, "cocalc");
}

export function daemonSocketPath(env = process.env): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(daemonRuntimeDir(env), `cli-daemon-${uid}.sock`);
}

export function daemonPidPath(env = process.env): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(daemonRuntimeDir(env), `cli-daemon-${uid}.pid`);
}

export function daemonLogPath(env = process.env): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(daemonRuntimeDir(env), `cli-daemon-${uid}.log`);
}

function daemonSpawnTarget(): { cmd: string; args: string[] } {
  const scriptPath = process.argv[1];
  if (scriptPath && existsSync(scriptPath)) {
    return { cmd: process.execPath, args: [scriptPath] };
  }
  return { cmd: process.execPath, args: [] };
}

export function daemonRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function readDaemonPid(path = daemonPidPath()): number | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return pid;
}

export function isDaemonTransportError(err: unknown): boolean {
  const code = `${(err as any)?.code ?? ""}`.toUpperCase();
  const msg = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  return (
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    msg.includes("daemon transport") ||
    msg.includes("daemon timeout")
  );
}

export async function sendDaemonRequest({
  request,
  socketPath = daemonSocketPath(),
  timeoutMs = DAEMON_RPC_TIMEOUT_MS,
}: {
  request: DaemonRequest;
  socketPath?: string;
  timeoutMs?: number;
}): Promise<DaemonResponse> {
  return await new Promise<DaemonResponse>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const socket = createNetConnection(socketPath);

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        socket.end();
      } catch {
        // ignore
      }
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      fn();
    };

    const timer = setTimeout(() => {
      const err: any = new Error(`daemon timeout after ${timeoutMs}ms`);
      err.code = "ETIMEDOUT";
      done(() => reject(err));
    }, timeoutMs);

    socket.on("connect", () => {
      try {
        socket.write(`${JSON.stringify(request)}\n`);
      } catch (err) {
        done(() => reject(err));
      }
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let parsed: DaemonResponse;
        try {
          parsed = JSON.parse(line) as DaemonResponse;
        } catch (err) {
          clearTimeout(timer);
          done(() => reject(err));
          return;
        }
        if (parsed.id !== request.id) {
          continue;
        }
        clearTimeout(timer);
        done(() => resolve(parsed));
        return;
      }
    });

    socket.on("error", (err: any) => {
      clearTimeout(timer);
      err.message = `daemon transport error: ${err?.message ?? err}`;
      done(() => reject(err));
    });

    socket.on("close", () => {
      if (settled) return;
      clearTimeout(timer);
      const err: any = new Error("daemon transport closed before response");
      err.code = "ECONNRESET";
      done(() => reject(err));
    });
  });
}

export async function pingDaemon(socketPath = daemonSocketPath()): Promise<DaemonResponse> {
  return await sendDaemonRequest({
    socketPath,
    timeoutMs: DAEMON_CONNECT_TIMEOUT_MS,
    request: {
      id: daemonRequestId(),
      action: "ping",
    },
  });
}

export async function startDaemonProcess({
  socketPath = daemonSocketPath(),
  timeoutMs = 8_000,
}: {
  socketPath?: string;
  timeoutMs?: number;
} = {}): Promise<{ started: boolean; pid?: number; already_running?: boolean }> {
  try {
    const pong = await pingDaemon(socketPath);
    return {
      started: true,
      pid: pong.meta?.pid,
      already_running: true,
    };
  } catch {
    // not running
  }

  mkdirSync(dirname(socketPath), { recursive: true });
  const { cmd, args } = daemonSpawnTarget();
  const daemonArgs = [...args, "daemon", "serve", "--socket", socketPath];
  const child = spawn(cmd, daemonArgs, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      COCALC_CLI_DAEMON_MODE: "1",
    },
  });
  child.unref();

  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const pong = await pingDaemon(socketPath);
      return {
        started: true,
        pid: pong.meta?.pid,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `daemon did not become ready in ${timeoutMs}ms: ${
      lastErr instanceof Error ? lastErr.message : `${lastErr ?? "unknown"}`
    }`,
  );
}

export async function daemonRequestWithAutoStart(
  request: DaemonRequest,
  {
    timeoutMs = DAEMON_RPC_TIMEOUT_MS,
  }: {
    timeoutMs?: number;
  } = {},
): Promise<DaemonResponse> {
  const socketPath = daemonSocketPath();
  try {
    return await sendDaemonRequest({ request, socketPath, timeoutMs });
  } catch (err) {
    if (!isDaemonTransportError(err)) {
      throw err;
    }
    await startDaemonProcess({ socketPath });
    return await sendDaemonRequest({ request, socketPath, timeoutMs });
  }
}
