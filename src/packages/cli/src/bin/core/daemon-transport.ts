/**
 * CLI daemon transport/runtime path primitives.
 *
 * This module owns socket/pid/log path resolution and client-side request
 * helpers (ping, auto-start, RPC send) used by CLI command handlers.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, win32 } from "node:path";
import { createConnection as createNetConnection } from "node:net";

import { applyPrivateMode, cocalcCliCacheDir } from "../../core/platform-paths";

export const DAEMON_CONNECT_TIMEOUT_MS = 3_000;
export const DAEMON_RPC_TIMEOUT_MS = 30_000;
export const DAEMON_RUNTIME_DIR_MODE = 0o700;
export const DAEMON_PRIVATE_FILE_MODE = 0o600;

export type DaemonAction =
  | "ping"
  | "shutdown"
  | "project.file.list"
  | "project.file.cat"
  | "project.file.put"
  | "project.file.get"
  | "project.file.rm"
  | "project.file.mkdir"
  | "project.file.rg"
  | "project.file.fd";

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
    daemon_fingerprint?: string | null;
  };
};

function isSeaRuntime(): boolean {
  try {
    const sea = require("node:sea") as { isSea?: () => boolean };
    return typeof sea?.isSea === "function" ? !!sea.isSea() : false;
  } catch {
    return false;
  }
}

function daemonScriptPath(
  argv = process.argv,
  execPath = process.execPath,
  sea = isSeaRuntime(),
): string | undefined {
  if (sea) return undefined;
  const scriptPath = argv[1];
  if (!scriptPath || !existsSync(scriptPath)) return undefined;
  try {
    if (realpathSync(scriptPath) === realpathSync(execPath)) return undefined;
  } catch {
    // The normal JS entrypoint and executable need not share a filesystem.
  }
  return scriptPath;
}

export function currentDaemonFingerprint(
  argv = process.argv,
  execPath = process.execPath,
  env = process.env,
): string {
  // Connections and profile lookup are created in the daemon's environment.
  // Reusing it after a project/relay/config change silently uses stale routes.
  // Hash the configuration so admission credentials never appear in diagnostics.
  const runtime = createHash("sha256")
    .update(
      JSON.stringify(
        [
          "CONAT_SERVER",
          "COCALC_API_RELAY",
          "COCALC_API_RELAY_HUB_URL",
          "COCALC_SITE_URL",
          "COCALC_PROJECT_ID",
          "COCALC_PROJECT_SECRET",
          "COCALC_SECRET_TOKEN",
          "COCALC_CLI_CONFIG",
          "HOME",
          "XDG_CONFIG_HOME",
        ].map((key) => [key, env[key] ?? ""]),
      ),
    )
    .digest("hex");
  const scriptPath = daemonScriptPath(argv, execPath);
  if (scriptPath) {
    const resolved = realpathSync(scriptPath);
    const stats = statSync(resolved);
    return `${execPath}:${resolved}:${Math.trunc(stats.mtimeMs)}:${runtime}`;
  }
  if (existsSync(execPath)) {
    const stats = statSync(execPath);
    return `${execPath}:sea:${stats.size}:${Math.trunc(stats.mtimeMs)}:${runtime}`;
  }
  return `${execPath}:sea:${runtime}`;
}

export function daemonFingerprintMatches(
  expected: string,
  actual?: string | null,
): boolean {
  return !!actual && actual === expected;
}

function daemonRuntimeDir(
  env = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return win32.join(cocalcCliCacheDir({ env, platform }), "runtime");
  }
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  if (runtime) {
    return join(runtime, "cocalc");
  }
  return cocalcCliCacheDir({ env, platform });
}

function daemonUserToken(
  env = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32" && typeof process.getuid === "function") {
    return String(process.getuid());
  }
  const identity = [env.USERDOMAIN, env.USERNAME, env.USER, env.HOME]
    .map((value) => `${value ?? ""}`.trim().toLowerCase())
    .filter(Boolean)
    .join("\\");
  return createHash("sha256")
    .update(identity || "user")
    .digest("hex")
    .slice(0, 16);
}

export function daemonSocketPath(
  env = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const uid = daemonUserToken(env, platform);
  if (platform === "win32") {
    return `\\\\.\\pipe\\cocalc-cli-${uid}`;
  }
  return join(daemonRuntimeDir(env), `cli-daemon-${uid}.sock`);
}

export function daemonPidPath(
  env = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const uid = daemonUserToken(env, platform);
  const runtime = daemonRuntimeDir(env, platform);
  return platform === "win32"
    ? win32.join(runtime, `cli-daemon-${uid}.pid`)
    : join(runtime, `cli-daemon-${uid}.pid`);
}

export function daemonLogPath(
  env = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const uid = daemonUserToken(env, platform);
  const runtime = daemonRuntimeDir(env, platform);
  return platform === "win32"
    ? win32.join(runtime, `cli-daemon-${uid}.log`)
    : join(runtime, `cli-daemon-${uid}.log`);
}

export function isWindowsNamedPipe(path: string): boolean {
  return path.toLowerCase().startsWith("\\\\.\\pipe\\");
}

export function ensurePrivateDaemonRuntimeDir(path: string): void {
  const dir = isWindowsNamedPipe(path)
    ? dirname(daemonPidPath())
    : dirname(path);
  mkdirSync(dir, { recursive: true, mode: DAEMON_RUNTIME_DIR_MODE });
  applyPrivateMode(dir, DAEMON_RUNTIME_DIR_MODE);
}

export function daemonSpawnTarget({
  argv = process.argv,
  execPath = process.execPath,
  sea = isSeaRuntime(),
}: {
  argv?: string[];
  execPath?: string;
  sea?: boolean;
} = {}): { cmd: string; args: string[] } {
  const scriptPath = daemonScriptPath(argv, execPath, sea);
  if (scriptPath) {
    return { cmd: execPath, args: [scriptPath] };
  }
  return { cmd: execPath, args: [] };
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

export async function pingDaemon(
  socketPath = daemonSocketPath(),
): Promise<DaemonResponse> {
  return await sendDaemonRequest({
    socketPath,
    timeoutMs: DAEMON_CONNECT_TIMEOUT_MS,
    request: {
      id: daemonRequestId(),
      action: "ping",
    },
  });
}

async function shutdownDaemonProcess(
  socketPath: string,
  timeoutMs = 3_000,
): Promise<void> {
  try {
    await sendDaemonRequest({
      socketPath,
      timeoutMs: Math.min(timeoutMs, DAEMON_CONNECT_TIMEOUT_MS),
      request: {
        id: daemonRequestId(),
        action: "shutdown",
      },
    });
  } catch {
    // best effort
  }
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      await pingDaemon(socketPath);
    } catch {
      return;
    }
  }
}

export async function startDaemonProcess({
  socketPath = daemonSocketPath(),
  timeoutMs = 8_000,
}: {
  socketPath?: string;
  timeoutMs?: number;
} = {}): Promise<{
  started: boolean;
  pid?: number;
  already_running?: boolean;
}> {
  const expectedFingerprint = currentDaemonFingerprint();
  let sawIncompatibleDaemon = false;
  try {
    const pong = await pingDaemon(socketPath);
    if (
      !daemonFingerprintMatches(
        expectedFingerprint,
        pong.meta?.daemon_fingerprint,
      )
    ) {
      sawIncompatibleDaemon = true;
      await shutdownDaemonProcess(socketPath);
    } else {
      return {
        started: true,
        pid: pong.meta?.pid,
        already_running: true,
      };
    }
  } catch {
    // not running
  }

  if (sawIncompatibleDaemon) {
    try {
      const pong = await pingDaemon(socketPath);
      throw new Error(
        `stale daemon (pid ${pong.meta?.pid ?? "unknown"}) did not stop for restart`,
      );
    } catch (err) {
      if (!isDaemonTransportError(err)) {
        throw err;
      }
    }
  }

  ensurePrivateDaemonRuntimeDir(socketPath);
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
  await startDaemonProcess({ socketPath });
  return await sendDaemonRequest({ request, socketPath, timeoutMs });
}
