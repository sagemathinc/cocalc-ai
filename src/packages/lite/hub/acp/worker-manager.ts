import path from "node:path";
import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import getLogger from "@cocalc/backend/logger";
import { conatPassword, conatServer, data } from "@cocalc/backend/data";
import { listQueuedAcpJobs, listRunningAcpJobs } from "../sqlite/acp-jobs";
import { resolveLiteAcpWorkerLaunch } from "./worker-launch";

const logger = getLogger("lite:hub:acp:worker-manager");
const ACP_WORKER_PID_FILE = path.join(data, "acp-worker.pid");
const ACP_WORKER_LOG_FILE = path.join(data, "logs", "acp-worker.log");
const ACP_WORKER_HEARTBEAT_FILE = path.join(data, "acp-worker.heartbeat.json");
const ACP_WORKER_SUPERVISOR_MS = 2000;
const ACP_WORKER_HEARTBEAT_STALE_MS = 15_000;

let supervisorStarted = false;

type AcpWorkerHeartbeat = {
  pid: number;
  updated_at: number;
};

function pendingAcpWorkExists(): boolean {
  try {
    return listQueuedAcpJobs().length > 0 || listRunningAcpJobs().length > 0;
  } catch (err) {
    logger.warn("failed to inspect ACP work state", err);
    return false;
  }
}

function readWorkerPid(): number | undefined {
  try {
    const raw = readFileSync(ACP_WORKER_PID_FILE, "utf8").trim();
    if (!raw) return;
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return;
  }
}

function isPidAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearWorkerPidFile(): void {
  try {
    rmSync(ACP_WORKER_PID_FILE, { force: true });
  } catch {
    // ignore
  }
}

function readWorkerHeartbeat(): AcpWorkerHeartbeat | undefined {
  try {
    const raw = JSON.parse(readFileSync(ACP_WORKER_HEARTBEAT_FILE, "utf8"));
    const pid = Number(raw?.pid);
    const updated_at = Number(raw?.updated_at);
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (!Number.isFinite(updated_at) || updated_at <= 0) return;
    return { pid, updated_at };
  } catch {
    return;
  }
}

function hasFreshWorkerHeartbeat(
  pid?: number,
  now: number = Date.now(),
): boolean {
  if (!pid) return false;
  const heartbeat = readWorkerHeartbeat();
  if (!heartbeat || heartbeat.pid !== pid) {
    return false;
  }
  return now - heartbeat.updated_at <= ACP_WORKER_HEARTBEAT_STALE_MS;
}

export function recordAcpWorkerHeartbeat({
  pid,
  now = Date.now(),
}: {
  pid: number;
  now?: number;
}): void {
  try {
    writeFileSync(
      ACP_WORKER_HEARTBEAT_FILE,
      `${JSON.stringify({ pid, updated_at: now })}\n`,
      { mode: 0o600 },
    );
  } catch (err) {
    logger.debug("failed to record ACP worker heartbeat", {
      pid,
      heartbeat: ACP_WORKER_HEARTBEAT_FILE,
      err,
    });
  }
}

export function clearAcpWorkerHeartbeat(): void {
  try {
    rmSync(ACP_WORKER_HEARTBEAT_FILE, { force: true });
  } catch {
    // ignore
  }
}

export async function ensureAcpWorkerRunning({
  force = false,
}: {
  force?: boolean;
} = {}): Promise<boolean> {
  if (!force && !pendingAcpWorkExists()) {
    return false;
  }
  const existingPid = readWorkerPid();
  if (isPidAlive(existingPid) && hasFreshWorkerHeartbeat(existingPid)) {
    return true;
  }
  if (existingPid && isPidAlive(existingPid)) {
    logger.warn("ignoring stale ACP worker pid without fresh heartbeat", {
      pid: existingPid,
      pid_file: ACP_WORKER_PID_FILE,
      heartbeat_file: ACP_WORKER_HEARTBEAT_FILE,
    });
  }
  if (!`${conatPassword ?? ""}`.trim()) {
    logger.warn("skipping ACP worker spawn: conat password is not initialized");
    clearWorkerPidFile();
    clearAcpWorkerHeartbeat();
    return false;
  }
  clearWorkerPidFile();
  clearAcpWorkerHeartbeat();
  const { command, args } = resolveLiteAcpWorkerLaunch();
  mkdirSync(path.dirname(ACP_WORKER_LOG_FILE), { recursive: true });
  const stdout = openSync(ACP_WORKER_LOG_FILE, "a");
  const env = {
    ...process.env,
    CONAT_SERVER: conatServer,
    DATA: data,
    COCALC_DATA_DIR: data,
    COCALC_LITE_SQLITE_FILENAME: path.join(data, "hub.db"),
    COCALC_LITE_ACP_SQLITE_FILENAME: path.join(data, "acp.sqlite"),
    COCALC_LITE_ACP_WORKER_CONAT_PASSWORD: conatPassword,
    COCALC_LITE_ACP_WORKER_PID_FILE: ACP_WORKER_PID_FILE,
    // The worker's stdout/stderr are already redirected to acp-worker.log.
    // Force debug logging to stay on console so the useful ACP worker logs land
    // in that file instead of being redirected again into the shared dev log.
    DEBUG_CONSOLE: "yes",
    DEBUG_FILE: "",
    COCALC_LITE_ACP_WORKER: "1",
  };
  const child = spawn(command, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", stdout, stdout],
    env,
  });
  closeSync(stdout);
  child.unref();
  const pid = child.pid;
  if (pid == null || !Number.isInteger(pid) || pid <= 0) {
    clearWorkerPidFile();
    clearAcpWorkerHeartbeat();
    throw new Error("failed to determine ACP worker pid");
  }
  writeFileSync(ACP_WORKER_PID_FILE, `${pid}\n`);
  recordAcpWorkerHeartbeat({ pid });
  logger.warn("spawned ACP worker", {
    pid,
    command,
    args,
    log: ACP_WORKER_LOG_FILE,
  });
  return true;
}

export function startAcpWorkerSupervisor(): void {
  if (supervisorStarted) return;
  supervisorStarted = true;
  const timer = setInterval(() => {
    void ensureAcpWorkerRunning().catch((err) => {
      logger.warn("ACP worker supervisor check failed", err);
    });
  }, ACP_WORKER_SUPERVISOR_MS);
  timer.unref?.();
}

export function acpWorkerLogFile(): string {
  return ACP_WORKER_LOG_FILE;
}

export function acpWorkerPidFile(): string {
  return ACP_WORKER_PID_FILE;
}
