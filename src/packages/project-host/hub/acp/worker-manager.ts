import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import getLogger from "@cocalc/backend/logger";
import { conatPassword, conatServer, data } from "@cocalc/backend/data";
import {
  acpDaemonControlClient,
  type AcpDaemonStatus,
} from "@cocalc/conat/ai/acp/daemon-control";
import { getSoftwareVersions } from "../../software";
import { getProjectHostConatClient } from "../../runtime-client";

const logger = getLogger("project-host:hub:acp:worker-manager");
const ACP_WORKER_PID_FILE = path.join(data, "acp-worker.pid");
const ACP_WORKER_LOG_FILE = path.join(data, "logs", "acp-worker.log");
const ACP_WORKER_SUPERVISOR_MS = 2000;
const ACP_WORKER_ROLLING_CAPABILITY = "rolling-v1";
const ACP_WORKER_CONTROL_TIMEOUT_MS = Math.max(
  250,
  Number(process.env.COCALC_ACP_WORKER_CONTROL_TIMEOUT_MS ?? 1500),
);

let supervisorStarted = false;
let workerEntryPoint: string | undefined;
let ensureWorkerPromise: Promise<boolean> | undefined;

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

type WorkerWithStatus = WorkerProcessInfo & {
  status?: AcpDaemonStatus;
};

export type ProjectHostAcpWorkerRolloutPlan = {
  activePid?: number;
  drainingPids: number[];
  terminatePids: number[];
  spawnNewActive: boolean;
};

function workerRollingCapable(worker: WorkerProcessInfo): boolean {
  return (
    `${worker.env.COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY ?? ""}`.trim() ===
      ACP_WORKER_ROLLING_CAPABILITY &&
    `${worker.env.COCALC_ACP_INSTANCE_ID ?? ""}`.trim().length > 0
  );
}

export function planProjectHostAcpWorkerRollout({
  workers,
  launch,
  drainingWorkerIds,
}: {
  workers: WorkerProcessInfo[];
  launch: WorkerLaunch;
  drainingWorkerIds?: Iterable<string>;
}): ProjectHostAcpWorkerRolloutPlan {
  const drainingIds = new Set(drainingWorkerIds ?? []);
  const matchingCurrent = workers
    .filter(
      (worker) =>
        isExpectedWorkerProcess(worker, launch) &&
        !drainingIds.has(workerIdOf(worker)),
    )
    .sort((left, right) => right.pid - left.pid);
  const activePid = matchingCurrent[0]?.pid;
  const drainingPids: number[] = [];
  const terminatePids: number[] = [];
  for (const worker of workers) {
    if (worker.pid === activePid) continue;
    if (workerRollingCapable(worker)) {
      drainingPids.push(worker.pid);
    } else {
      terminatePids.push(worker.pid);
    }
  }
  return {
    activePid,
    drainingPids,
    terminatePids,
    spawnNewActive: activePid == null,
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

function safeRealpath(value?: string): string | undefined {
  if (!value) return;
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function resolveProjectHostWorkerBundlePath(launch: WorkerLaunch): string {
  const explicit =
    `${process.env.COCALC_PROJECT_HOST_BUNDLE_PATH ?? ""}`.trim() ||
    `${process.env.COCALC_PROJECT_HOST_CURRENT ?? ""}`.trim();
  const current =
    explicit ||
    (launch.resolvedEntryPoint
      ? path.dirname(path.dirname(launch.resolvedEntryPoint))
      : process.cwd());
  return safeRealpath(current) ?? current;
}

function resolveProjectHostWorkerBundleVersion(bundlePath: string): string {
  const explicit = `${process.env.COCALC_PROJECT_HOST_VERSION ?? ""}`.trim();
  if (explicit) return explicit;
  const software = getSoftwareVersions();
  return (
    `${software.project_host_build_id ?? ""}`.trim() ||
    `${software.project_host ?? ""}`.trim() ||
    path.basename(bundlePath)
  );
}

function workerIdOf(worker: WorkerProcessInfo): string {
  return `${worker.env.COCALC_ACP_INSTANCE_ID ?? ""}`.trim();
}

async function getWorkerStatus(
  worker: WorkerProcessInfo,
): Promise<AcpDaemonStatus | undefined> {
  const worker_id = workerIdOf(worker);
  const host_id = `${worker.env.PROJECT_HOST_ID ?? ""}`.trim();
  if (!worker_id || !host_id) {
    return;
  }
  try {
    return await acpDaemonControlClient({
      client: getProjectHostConatClient(),
      host_id,
      worker_id,
      timeout: ACP_WORKER_CONTROL_TIMEOUT_MS,
      waitForInterest: false,
    }).health();
  } catch (err) {
    logger.debug("failed reading ACP worker control status", {
      pid: worker.pid,
      worker_id,
      host_id,
      err: `${err}`,
    });
    return;
  }
}

async function requestWorkerDrain(
  worker: WorkerProcessInfo,
): Promise<AcpDaemonStatus | undefined> {
  const worker_id = workerIdOf(worker);
  const host_id = `${worker.env.PROJECT_HOST_ID ?? ""}`.trim();
  if (!worker_id || !host_id) {
    return;
  }
  try {
    return await acpDaemonControlClient({
      client: getProjectHostConatClient(),
      host_id,
      worker_id,
      timeout: ACP_WORKER_CONTROL_TIMEOUT_MS,
      waitForInterest: false,
    }).requestDrain({ reason: "rolling_restart" });
  } catch (err) {
    logger.warn("failed requesting ACP worker drain", {
      pid: worker.pid,
      worker_id,
      host_id,
      err: `${err}`,
    });
    return;
  }
}

function workerBundleVersionOf(
  worker: WorkerProcessInfo,
  launch: WorkerLaunch,
): string {
  const fromEnv =
    `${worker.env.COCALC_PROJECT_HOST_ACP_WORKER_BUNDLE_VERSION ?? ""}`.trim();
  if (fromEnv) return fromEnv;
  const entry = worker.cmdline[1];
  if (entry) {
    return path.basename(path.dirname(path.dirname(path.resolve(entry))));
  }
  return resolveProjectHostWorkerBundleVersion(
    resolveProjectHostWorkerBundlePath(launch),
  );
}

function workerBundlePathOf(
  worker: WorkerProcessInfo,
  launch: WorkerLaunch,
): string {
  const fromEnv =
    `${worker.env.COCALC_PROJECT_HOST_ACP_WORKER_BUNDLE_PATH ?? ""}`.trim();
  if (fromEnv) return fromEnv;
  const entry = worker.cmdline[1];
  if (entry) {
    return (
      safeRealpath(path.dirname(path.dirname(path.resolve(entry)))) ??
      path.dirname(path.dirname(path.resolve(entry)))
    );
  }
  return resolveProjectHostWorkerBundlePath(launch);
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
  const observedWorkers = listProjectHostAcpWorkers();
  if (observedWorkers.length > 1) {
    logger.warn("multiple project-host ACP workers observed", {
      count: observedWorkers.length,
      workers: observedWorkers.map((worker) => ({
        pid: worker.pid,
        worker_id: workerIdOf(worker) || null,
        bundle_version: workerBundleVersionOf(worker, launch),
        bundle_path: workerBundlePathOf(worker, launch),
      })),
    });
  }
  const workerStatuses = await Promise.all(
    observedWorkers.map(async (worker) => ({
      worker,
      status: await getWorkerStatus(worker),
    })),
  );
  const workers: WorkerWithStatus[] = [];
  for (const worker of observedWorkers) {
    const status = workerStatuses.find(
      (entry) => entry.worker.pid === worker.pid,
    )?.status;
    if (status?.state === "stopped") {
      logger.warn("terminating stale stopped project-host ACP worker", {
        pid: worker.pid,
        worker_id: status.worker_id,
        bundle_version: status.bundle_version,
        bundle_path: status.bundle_path,
      });
      await terminateWorkerPid(worker.pid);
      continue;
    }
    workers.push({ ...worker, status });
  }
  if (!workers.length) {
    clearWorkerPidFile();
    return;
  }
  const { activePid, drainingPids, terminatePids } =
    planProjectHostAcpWorkerRollout({
      workers: workers.map(({ status, ...worker }) => worker),
      launch,
      drainingWorkerIds: workers
        .map((worker) => {
          return worker.status?.state === "draining"
            ? worker.status.worker_id
            : undefined;
        })
        .filter((worker_id): worker_id is string => worker_id != null),
    });
  for (const worker of workers) {
    if (!drainingPids.includes(worker.pid)) continue;
    if (!workerRollingCapable(worker)) continue;
    if (worker.status?.state === "draining") continue;
    await requestWorkerDrain(worker);
  }
  for (const worker of workers) {
    if (!terminatePids.includes(worker.pid)) continue;
    logger.warn("terminating non-cooperative project-host ACP worker", {
      pid: worker.pid,
      cmdline: worker.cmdline,
    });
    await terminateWorkerPid(worker.pid);
  }
  if (activePid && isPidAlive(activePid)) {
    writeFileSync(ACP_WORKER_PID_FILE, `${activePid}\n`);
    return activePid;
  }
  clearWorkerPidFile();
  return;
}

function spawnProjectHostAcpWorker({
  restartReason,
}: {
  restartReason?: string;
} = {}): boolean {
  if (!`${conatPassword ?? ""}`.trim()) {
    logger.warn("skipping ACP worker spawn: conat password is not initialized");
    clearWorkerPidFile();
    return false;
  }
  clearWorkerPidFile();
  const { command, args } = resolveProjectHostAcpWorkerLaunch();
  const launch = workerLaunchSignature();
  const worker_id = randomUUID();
  const bundle_path = resolveProjectHostWorkerBundlePath(launch);
  const bundle_version = resolveProjectHostWorkerBundleVersion(bundle_path);
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
    COCALC_LITE_ACP_SQLITE_FILENAME:
      process.env.COCALC_LITE_ACP_SQLITE_FILENAME ??
      path.join(data, "acp.sqlite"),
    COCALC_PROJECT_HOST_ACP_WORKER_CONAT_PASSWORD: conatPassword,
    COCALC_PROJECT_HOST_ACP_WORKER_PID_FILE: ACP_WORKER_PID_FILE,
    COCALC_PROJECT_HOST_ACP_WORKER: "1",
    COCALC_PROJECT_HOST_ACP_WORKER_CAPABILITY: ACP_WORKER_ROLLING_CAPABILITY,
    COCALC_PROJECT_HOST_ACP_WORKER_BUNDLE_VERSION: bundle_version,
    COCALC_PROJECT_HOST_ACP_WORKER_BUNDLE_PATH: bundle_path,
    COCALC_PROJECT_HOST_ACP_WORKER_STATE: "active",
    COCALC_ACP_INSTANCE_ID: worker_id,
    ...(restartReason
      ? { COCALC_PROJECT_HOST_ACP_WORKER_RESTART_REASON: restartReason }
      : {}),
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
    worker_id,
    bundle_version,
    bundle_path,
    command,
    args,
    log: ACP_WORKER_LOG_FILE,
  });
  return true;
}

async function ensureProjectHostAcpWorkerRunningOnce({
  restartReason,
}: {
  restartReason?: string;
} = {}): Promise<boolean> {
  const existingPid =
    (await reconcileProjectHostAcpWorkers()) ?? readWorkerPid();
  if (isPidAlive(existingPid)) {
    return true;
  }
  return spawnProjectHostAcpWorker({ restartReason });
}

export async function ensureProjectHostAcpWorkerRunning({
  restartReason,
}: {
  restartReason?: string;
} = {}): Promise<boolean> {
  if (ensureWorkerPromise != null) {
    return await ensureWorkerPromise;
  }
  const promise = ensureProjectHostAcpWorkerRunningOnce({ restartReason });
  ensureWorkerPromise = promise;
  try {
    return await promise;
  } finally {
    if (ensureWorkerPromise === promise) {
      ensureWorkerPromise = undefined;
    }
  }
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
