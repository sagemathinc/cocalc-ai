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

const logger = getLogger("lite:hub:acp:worker-manager");
const ACP_WORKER_PID_FILE = path.join(data, "acp-worker.pid");
const ACP_WORKER_LOG_FILE = path.join(data, "logs", "acp-worker.log");
const ACP_WORKER_SUPERVISOR_MS = 2000;

let supervisorStarted = false;

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

function resolveWorkerScript(): string {
  const distMain = require.resolve("@cocalc/lite/main");
  return path.join(path.dirname(distMain), "..", "bin", "acp-worker.js");
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
  if (isPidAlive(existingPid)) {
    return true;
  }
  if (!`${conatPassword ?? ""}`.trim()) {
    logger.warn("skipping ACP worker spawn: conat password is not initialized");
    clearWorkerPidFile();
    return false;
  }
  clearWorkerPidFile();
  const script = resolveWorkerScript();
  mkdirSync(path.dirname(ACP_WORKER_LOG_FILE), { recursive: true });
  const stdout = openSync(ACP_WORKER_LOG_FILE, "a");
  const env = {
    ...process.env,
    CONAT_SERVER: conatServer,
    DATA: data,
    COCALC_DATA_DIR: data,
    COCALC_LITE_SQLITE_FILENAME: path.join(data, "hub.db"),
    COCALC_LITE_ACP_WORKER_CONAT_PASSWORD: conatPassword,
    COCALC_LITE_ACP_WORKER_PID_FILE: ACP_WORKER_PID_FILE,
    // The worker's stdout/stderr are already redirected to acp-worker.log.
    // Force debug logging to stay on console so the useful ACP worker logs land
    // in that file instead of being redirected again into the shared dev log.
    DEBUG_CONSOLE: "yes",
    DEBUG_FILE: "",
  };
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: ["ignore", stdout, stdout],
    env,
  });
  closeSync(stdout);
  child.unref();
  writeFileSync(ACP_WORKER_PID_FILE, `${child.pid}\n`);
  logger.warn("spawned ACP worker", {
    pid: child.pid,
    script,
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
