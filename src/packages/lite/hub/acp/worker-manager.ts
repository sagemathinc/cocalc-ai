import path from "node:path";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import {
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
// A live worker rewrites its heartbeat every few seconds; a file this old
// belongs to a dead worker even if its pid has been reused.
const ACP_WORKER_HEARTBEAT_ORPHAN_MS = 60 * 60_000;
// acp-worker.heartbeat.json.<pid> and its temp file .<pid>.<writer pid>.tmp
const ACP_WORKER_HEARTBEAT_NAME =
  /^acp-worker\.heartbeat\.json\.(\d+)(?:\.(\d+)\.tmp)?$/;

let supervisorStarted = false;

type AcpWorkerHeartbeat = {
  pid: number;
  updated_at: number;
};

const pendingHeartbeatWrites = new Map<number, AcpWorkerHeartbeat>();
const heartbeatWritePromises = new Map<number, Promise<void>>();

function workerHeartbeatFile(pid: number): string {
  return `${ACP_WORKER_HEARTBEAT_FILE}.${pid}`;
}

function pendingAcpWorkExists(): boolean {
  try {
    return listQueuedAcpJobs().length > 0 || listRunningAcpJobs().length > 0;
  } catch (err) {
    logger.warn("failed to inspect ACP work state", err);
    return false;
  }
}

async function readWorkerPid(): Promise<number | undefined> {
  try {
    const raw = (await readFile(ACP_WORKER_PID_FILE, "utf8")).trim();
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

async function readHeartbeatFile(
  filename: string,
): Promise<AcpWorkerHeartbeat | undefined> {
  try {
    const raw = JSON.parse(await readFile(filename, "utf8"));
    const pid = Number(raw?.pid);
    const updated_at = Number(raw?.updated_at);
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (!Number.isFinite(updated_at) || updated_at <= 0) return;
    return { pid, updated_at };
  } catch {
    return;
  }
}

async function readWorkerHeartbeat(
  pid: number,
): Promise<AcpWorkerHeartbeat | undefined> {
  return (
    (await readHeartbeatFile(workerHeartbeatFile(pid))) ??
    (await readHeartbeatFile(ACP_WORKER_HEARTBEAT_FILE))
  );
}

async function hasFreshWorkerHeartbeat(
  pid?: number,
  now: number = Date.now(),
): Promise<boolean> {
  if (!pid) return false;
  const heartbeat = await readWorkerHeartbeat(pid);
  if (!heartbeat || heartbeat.pid !== pid) {
    return false;
  }
  return now - heartbeat.updated_at <= ACP_WORKER_HEARTBEAT_STALE_MS;
}

async function flushWorkerHeartbeat(pid: number): Promise<void> {
  while (true) {
    const heartbeat = pendingHeartbeatWrites.get(pid);
    if (!heartbeat) return;
    pendingHeartbeatWrites.delete(pid);
    const filename = workerHeartbeatFile(pid);
    const temp = `${filename}.${process.pid}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(heartbeat)}\n`, { mode: 0o600 });
      await rename(temp, filename);
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {});
      logger.debug("failed to record ACP worker heartbeat", {
        pid,
        heartbeat: filename,
        err,
      });
    }
  }
}

export function recordAcpWorkerHeartbeat({
  pid,
  now = Date.now(),
}: {
  pid: number;
  now?: number;
}): Promise<void> {
  pendingHeartbeatWrites.set(pid, { pid, updated_at: now });
  const existing = heartbeatWritePromises.get(pid);
  if (existing) return existing;
  const promise = flushWorkerHeartbeat(pid).finally(() => {
    heartbeatWritePromises.delete(pid);
  });
  heartbeatWritePromises.set(pid, promise);
  return promise;
}

export async function clearAcpWorkerHeartbeat({
  pid,
  legacy = false,
}: {
  pid?: number;
  legacy?: boolean;
} = {}): Promise<void> {
  if (pid) {
    pendingHeartbeatWrites.delete(pid);
    await heartbeatWritePromises.get(pid)?.catch(() => {});
    await rm(workerHeartbeatFile(pid), { force: true }).catch(() => {});
  }
  if (legacy) {
    await rm(ACP_WORKER_HEARTBEAT_FILE, { force: true }).catch(() => {});
  }
}

// Synchronous, for process "exit" handlers: a worker stopped by a signal
// exits without reaching the cleanup in its run loop.
export function clearAcpWorkerHeartbeatSync(pid: number): void {
  try {
    rmSync(workerHeartbeatFile(pid), { force: true });
  } catch {
    // ignore
  }
}

/**
 * Remove heartbeat files (and temp files) left by workers that died without
 * cleaning up (SIGKILL, crash, host restart): those whose pid is gone, or
 * that have not been touched for an hour. Never touches keepPid's files.
 */
export async function sweepStaleAcpWorkerHeartbeats({
  keepPid = process.pid,
  dir = data,
  now = Date.now(),
}: {
  keepPid?: number;
  dir?: string;
  now?: number;
} = {}): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = ACP_WORKER_HEARTBEAT_NAME.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    const writer = match[2] == null ? pid : Number(match[2]);
    if (pid === keepPid || writer === keepPid) continue;
    const filename = path.join(dir, name);
    if (isPidAlive(writer)) {
      try {
        if (
          now - (await stat(filename)).mtimeMs <=
          ACP_WORKER_HEARTBEAT_ORPHAN_MS
        ) {
          continue;
        }
      } catch {
        continue;
      }
    }
    try {
      await rm(filename, { force: true });
      removed += 1;
    } catch {
      // ignore
    }
  }
  if (removed > 0) {
    logger.debug("removed stale ACP worker heartbeat files", { removed });
  }
  return removed;
}

async function clearStaleWorkerFiles(pid?: number): Promise<void> {
  clearWorkerPidFile();
  await clearAcpWorkerHeartbeat({ pid, legacy: true });
}

async function workerIsHealthy(pid?: number): Promise<boolean> {
  return isPidAlive(pid) && (await hasFreshWorkerHeartbeat(pid));
}

function logStaleWorker(pid: number): void {
  logger.warn("ignoring stale ACP worker pid without fresh heartbeat", {
    pid,
    pid_file: ACP_WORKER_PID_FILE,
    heartbeat_file: workerHeartbeatFile(pid),
  });
}

async function recordInitialWorkerHeartbeat(pid: number): Promise<void> {
  try {
    await recordAcpWorkerHeartbeat({ pid });
  } catch (err) {
    logger.debug("failed to record initial ACP worker heartbeat", {
      pid,
      heartbeat: workerHeartbeatFile(pid),
      err,
    });
  }
}

export async function ensureAcpWorkerRunning({
  force = false,
}: {
  force?: boolean;
} = {}): Promise<boolean> {
  const existingPid = await readWorkerPid();
  if (await workerIsHealthy(existingPid)) {
    return true;
  }
  if (!force && !pendingAcpWorkExists()) {
    return false;
  }
  if (existingPid && isPidAlive(existingPid)) {
    logStaleWorker(existingPid);
  }
  if (!`${conatPassword ?? ""}`.trim()) {
    logger.warn("skipping ACP worker spawn: conat password is not initialized");
    await clearStaleWorkerFiles(existingPid);
    return false;
  }
  await clearStaleWorkerFiles(existingPid);
  await sweepStaleAcpWorkerHeartbeats();
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
    // Use the logger's asynchronous file stream instead of synchronous writes
    // through a console redirected to a regular file.
    DEBUG_CONSOLE: "no",
    DEBUG_FILE: ACP_WORKER_LOG_FILE,
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
    await clearStaleWorkerFiles(existingPid);
    throw new Error("failed to determine ACP worker pid");
  }
  writeFileSync(ACP_WORKER_PID_FILE, `${pid}\n`);
  await recordInitialWorkerHeartbeat(pid);
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
