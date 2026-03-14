import path from "node:path";
import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import getLogger from "@cocalc/backend/logger";
import { conatPassword, conatServer, data } from "@cocalc/backend/data";

const logger = getLogger("project-host:hub:acp:worker-manager");
const ACP_WORKER_PID_FILE = path.join(data, "acp-worker.pid");
const ACP_WORKER_LOG_FILE = path.join(data, "logs", "acp-worker.log");
const ACP_WORKER_SUPERVISOR_MS = 2000;

let supervisorStarted = false;
let workerEntryPoint: string | undefined;

type WorkerLaunch = {
  command: string;
  args: string[];
  nodeLike: boolean;
  resolvedCommand: string;
  resolvedEntryPoint?: string;
};

type WorkerProcessInfo = {
  pid: number;
  env: Record<string, string>;
  cmdline: string[];
};

export function classifyProjectHostAcpWorkers({
  workers,
  launch,
}: {
  workers: WorkerProcessInfo[];
  launch: WorkerLaunch;
}): { keepPid?: number; stalePids: number[] } {
  const matching = workers
    .filter((worker) => isExpectedWorkerProcess(worker, launch))
    .sort((left, right) => right.pid - left.pid);
  const keepPid = matching[0]?.pid;
  return {
    keepPid,
    stalePids: workers
      .filter((worker) => worker.pid !== keepPid)
      .map((worker) => worker.pid),
  };
}

export function configureProjectHostAcpWorkerLauncher({
  entryPoint,
}: {
  entryPoint: string;
}): void {
  workerEntryPoint = entryPoint;
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

export function resolveProjectHostAcpWorkerLaunch({
  command = process.env.COCALC_PROJECT_HOST_DAEMON_EXEC ?? process.execPath,
  entryPoint = workerEntryPoint,
}: {
  command?: string;
  entryPoint?: string;
} = {}): { command: string; args: string[] } {
  const base = path.basename(command).toLowerCase();
  const nodeLike = base === "node" || base.startsWith("node");
  if (nodeLike) {
    const entry = entryPoint ?? require.resolve("@cocalc/project-host/main");
    return { command, args: [entry] };
  }
  return { command, args: [] };
}

function workerLaunchSignature(): WorkerLaunch {
  const { command, args } = resolveProjectHostAcpWorkerLaunch();
  const base = path.basename(command).toLowerCase();
  const nodeLike = base === "node" || base.startsWith("node");
  return {
    command,
    args,
    nodeLike,
    resolvedCommand: path.resolve(command),
    resolvedEntryPoint:
      nodeLike && args[0] != null ? path.resolve(args[0]) : undefined,
  };
}

function readProcEnviron(pid: number): Record<string, string> {
  const env: Record<string, string> = {};
  const raw = readFileSync(`/proc/${pid}/environ`, "utf8");
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const idx = entry.indexOf("=");
    if (idx === -1) continue;
    env[entry.slice(0, idx)] = entry.slice(idx + 1);
  }
  return env;
}

function readProcCmdline(pid: number): string[] {
  return readFileSync(`/proc/${pid}/cmdline`, "utf8")
    .split("\0")
    .filter((value) => value.length > 0);
}

function listProjectHostAcpWorkers(): WorkerProcessInfo[] {
  const hostId = `${process.env.PROJECT_HOST_ID ?? ""}`.trim();
  return readdirSync("/proc")
    .map((name) => Number(name))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
    .flatMap((pid) => {
      try {
        const env = readProcEnviron(pid);
        if (`${env.COCALC_PROJECT_HOST_ACP_WORKER ?? ""}`.trim() !== "1") {
          return [];
        }
        const workerHostId = `${env.PROJECT_HOST_ID ?? ""}`.trim();
        if (hostId && workerHostId && workerHostId !== hostId) {
          return [];
        }
        return [
          {
            pid,
            env,
            cmdline: readProcCmdline(pid),
          },
        ];
      } catch {
        // ignore processes we cannot inspect or that exit during scanning
        return [];
      }
    });
}

function isExpectedWorkerProcess(
  worker: WorkerProcessInfo,
  launch: WorkerLaunch,
): boolean {
  if (worker.cmdline.length === 0) return false;
  if (path.resolve(worker.cmdline[0]) !== launch.resolvedCommand) {
    return false;
  }
  if (!launch.nodeLike) {
    return true;
  }
  if (!launch.resolvedEntryPoint) {
    return false;
  }
  const entryPoint = worker.cmdline[1];
  if (!entryPoint) {
    return false;
  }
  return path.resolve(entryPoint) === launch.resolvedEntryPoint;
}

async function terminateWorkerPid(pid: number): Promise<void> {
  if (!isPidAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore exit races
  }
}

async function reconcileProjectHostAcpWorkers(): Promise<number | undefined> {
  const launch = workerLaunchSignature();
  const workers = listProjectHostAcpWorkers();
  if (!workers.length) {
    clearWorkerPidFile();
    return;
  }
  const { keepPid, stalePids } = classifyProjectHostAcpWorkers({
    workers,
    launch,
  });
  for (const worker of workers) {
    if (!stalePids.includes(worker.pid)) continue;
    logger.warn("terminating stale project-host ACP worker", {
      pid: worker.pid,
      cmdline: worker.cmdline,
    });
    await terminateWorkerPid(worker.pid);
  }
  if (keepPid && isPidAlive(keepPid)) {
    writeFileSync(ACP_WORKER_PID_FILE, `${keepPid}\n`);
    return keepPid;
  }
  clearWorkerPidFile();
  return;
}

export async function ensureProjectHostAcpWorkerRunning(): Promise<boolean> {
  const existingPid =
    (await reconcileProjectHostAcpWorkers()) ?? readWorkerPid();
  if (isPidAlive(existingPid)) {
    return true;
  }
  if (!`${conatPassword ?? ""}`.trim()) {
    logger.warn("skipping ACP worker spawn: conat password is not initialized");
    clearWorkerPidFile();
    return false;
  }
  clearWorkerPidFile();
  const { command, args } = resolveProjectHostAcpWorkerLaunch();
  mkdirSync(path.dirname(ACP_WORKER_LOG_FILE), { recursive: true });
  const stdout = openSync(ACP_WORKER_LOG_FILE, "a");
  const env = {
    ...process.env,
    CONAT_SERVER: conatServer,
    DATA: data,
    COCALC_DATA: data,
    COCALC_DATA_DIR: data,
    COCALC_LITE_SQLITE_FILENAME:
      process.env.COCALC_LITE_SQLITE_FILENAME ?? path.join(data, "sqlite.db"),
    COCALC_PROJECT_HOST_ACP_WORKER_CONAT_PASSWORD: conatPassword,
    COCALC_PROJECT_HOST_ACP_WORKER_PID_FILE: ACP_WORKER_PID_FILE,
    COCALC_PROJECT_HOST_ACP_WORKER: "1",
  };
  const child = spawn(command, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", stdout, stdout],
    env,
  });
  closeSync(stdout);
  child.unref();
  writeFileSync(ACP_WORKER_PID_FILE, `${child.pid}\n`);
  logger.warn("spawned project-host ACP worker", {
    pid: child.pid,
    command,
    args,
    log: ACP_WORKER_LOG_FILE,
  });
  return true;
}

export function startProjectHostAcpWorkerSupervisor(): void {
  if (supervisorStarted) return;
  supervisorStarted = true;
  const timer = setInterval(() => {
    void ensureProjectHostAcpWorkerRunning().catch((err) => {
      logger.warn("project-host ACP worker supervisor check failed", err);
    });
  }, ACP_WORKER_SUPERVISOR_MS);
  timer.unref?.();
}

export function projectHostAcpWorkerLogFile(): string {
  return ACP_WORKER_LOG_FILE;
}

export function projectHostAcpWorkerPidFile(): string {
  return ACP_WORKER_PID_FILE;
}
