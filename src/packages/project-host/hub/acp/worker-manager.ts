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
import { getAcpWorker } from "@cocalc/lite/hub/sqlite/acp-workers";
import {
  listAcpWorkers,
  stopAcpWorker,
  type AcpWorkerRow,
} from "@cocalc/lite/hub/sqlite/acp-workers";
import {
  ACP_PROJECT_RESTART_FENCE_REASON,
  countRunningAcpJobsForWorker,
  decodeAcpJobRequest,
  hasQueuedOrRunningAcpJobs,
  listRunningAcpJobsByWorker,
  oldestQueuedAcpJobTimestamp,
  fenceAcpJobsForProject,
} from "@cocalc/lite/hub/sqlite/acp-jobs";
import {
  countRunningAcpTurnLeasesForWorker,
  fenceAcpTurnLeasesForProject,
} from "@cocalc/lite/hub/sqlite/acp-turns";
import { clearAcpPayloadsForProject } from "@cocalc/lite/hub/sqlite/acp-queue";
import { getSoftwareVersions } from "../../software";
import { getProjectHostConatClient } from "../../runtime-client";
import { getProjectHostProcessTitle } from "../../process-role";
import {
  readProjectHostAcpWorkerTarget,
  writeProjectHostAcpWorkerTarget,
} from "./worker-target";

const logger = getLogger("project-host:hub:acp:worker-manager");
const ACP_WORKER_PID_FILE = path.join(data, "acp-worker.pid");
const ACP_WORKER_LOG_FILE = path.join(data, "logs", "acp-worker.log");
const ACP_WORKER_SUPERVISOR_MS = 2000;
const ACP_WORKER_SPAWN_BACKOFF_INITIAL_MS = Math.max(
  ACP_WORKER_SUPERVISOR_MS,
  Number(process.env.COCALC_ACP_WORKER_SPAWN_BACKOFF_INITIAL_MS ?? 5000),
);
const ACP_WORKER_SPAWN_BACKOFF_MAX_MS = Math.max(
  ACP_WORKER_SPAWN_BACKOFF_INITIAL_MS,
  Number(process.env.COCALC_ACP_WORKER_SPAWN_BACKOFF_MAX_MS ?? 120000),
);
const ACP_WORKER_ROLLING_CAPABILITY = "rolling-v1";
const ACP_WORKER_CONTROL_TIMEOUT_MS = Math.max(
  250,
  Number(process.env.COCALC_ACP_WORKER_CONTROL_TIMEOUT_MS ?? 1500),
);
const ACP_WORKER_CONTROL_STARTUP_GRACE_MS = Math.max(
  5_000,
  Number(process.env.COCALC_ACP_WORKER_CONTROL_STARTUP_GRACE_MS ?? 30_000),
);
const ACP_WORKER_DB_HEARTBEAT_STALE_MS = Math.max(
  5_000,
  Number(process.env.COCALC_ACP_WORKER_DB_HEARTBEAT_STALE_MS ?? 15_000),
);
const ACP_WORKER_DRAIN_TERMINATE_MS = Math.max(
  30_000,
  Number(process.env.COCALC_ACP_WORKER_DRAIN_TERMINATE_MS ?? 120_000),
);
const ACP_WORKER_QUEUE_STALL_MS = Math.max(
  60_000,
  Number(process.env.COCALC_ACP_WORKER_QUEUE_STALL_MS ?? 120_000),
);

let supervisorStarted = false;
let workerEntryPoint: string | undefined;
let ensureWorkerPromise:
  | {
      replaceMismatchedBundle: boolean;
      promise: Promise<boolean>;
    }
  | undefined;
let workerSpawnAttemptCount = 0;
let nextWorkerSpawnAllowedAt = 0;

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

export type ProjectHostAcpWorkerRolloutOutcome = {
  action: "spawned" | "drain_requested" | "noop";
  pid?: number;
  worker_id?: string;
  message?: string;
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
  preserveMismatchedActive = false,
}: {
  workers: WorkerProcessInfo[];
  launch: WorkerLaunch;
  drainingWorkerIds?: Iterable<string>;
  preserveMismatchedActive?: boolean;
}): ProjectHostAcpWorkerRolloutPlan {
  const drainingIds = new Set(drainingWorkerIds ?? []);
  const matchingCurrent = workers
    .filter(
      (worker) =>
        isExpectedWorkerProcess(worker, launch) &&
        !drainingIds.has(workerIdOf(worker)),
    )
    .sort((left, right) => right.pid - left.pid);
  const preservedMismatched =
    preserveMismatchedActive && matchingCurrent.length === 0
      ? workers
          .filter((worker) => !drainingIds.has(workerIdOf(worker)))
          .sort((left, right) => right.pid - left.pid)
      : [];
  const activePid = matchingCurrent[0]?.pid ?? preservedMismatched[0]?.pid;
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

function projectHostAcpWorkerSpawnBackoffDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(
    ACP_WORKER_SPAWN_BACKOFF_MAX_MS,
    ACP_WORKER_SPAWN_BACKOFF_INITIAL_MS * 2 ** exponent,
  );
}

function projectHostAcpWorkerSpawnBackoffRemainingMs(now = Date.now()): number {
  return Math.max(0, nextWorkerSpawnAllowedAt - now);
}

function resetProjectHostAcpWorkerSpawnBackoff(): void {
  workerSpawnAttemptCount = 0;
  nextWorkerSpawnAllowedAt = 0;
}

function noteProjectHostAcpWorkerSpawn(now = Date.now()): {
  attempt: number;
  backoffMs: number;
} {
  workerSpawnAttemptCount += 1;
  const backoffMs = projectHostAcpWorkerSpawnBackoffDelayMs(
    workerSpawnAttemptCount,
  );
  nextWorkerSpawnAllowedAt = now + backoffMs;
  return { attempt: workerSpawnAttemptCount, backoffMs };
}

export function resolveProjectHostAcpWorkerLaunch({
  command = process.env.COCALC_PROJECT_HOST_DAEMON_EXEC ?? process.execPath,
  entryPoint = readProjectHostAcpWorkerTarget()?.entry_point ??
    workerEntryPoint,
}: {
  command?: string;
  entryPoint?: string;
} = {}): { command: string; args: string[] } {
  const base = path.basename(command).toLowerCase();
  const nodeLike = base === "node" || base.startsWith("node");
  if (nodeLike) {
    const entry = entryPoint ?? require.resolve("../../main");
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
  const target = readProjectHostAcpWorkerTarget();
  if (
    target &&
    launch.resolvedEntryPoint === path.resolve(target.entry_point)
  ) {
    return target.bundle_path;
  }
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
  const target = readProjectHostAcpWorkerTarget();
  if (target?.bundle_path === bundlePath) return target.build_id;
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

function workerStartedAtMs(worker: WorkerProcessInfo): number {
  const value = Number(worker.env.COCALC_PROJECT_HOST_ACP_WORKER_STARTED_AT);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function workerControlStartupGraceExpired(
  worker: WorkerProcessInfo,
  now = Date.now(),
): boolean {
  const startedAt = workerStartedAtMs(worker);
  if (startedAt <= 0) {
    // Older workers did not record a spawn timestamp. If they are the current
    // active worker candidate and are not answering control RPCs, treat them as
    // past grace so the supervisor can recover.
    return true;
  }
  return now - startedAt >= ACP_WORKER_CONTROL_STARTUP_GRACE_MS;
}

function workerDatabaseStateProtectsUnresponsiveWorker(
  worker: WorkerProcessInfo,
  now = Date.now(),
): boolean {
  const worker_id = workerIdOf(worker);
  if (!worker_id) return false;
  const row = getAcpWorker(worker_id);
  if (row == null || row.state === "stopped") return false;
  if (Number(row.pid ?? 0) !== worker.pid) return false;
  if (countRunningAcpTurnLeasesForWorker(worker_id) > 0) return true;
  const lastHeartbeatAt = Number(row.last_heartbeat_at ?? 0);
  const heartbeatIsFresh =
    Number.isFinite(lastHeartbeatAt) &&
    lastHeartbeatAt > 0 &&
    now - lastHeartbeatAt <= ACP_WORKER_DB_HEARTBEAT_STALE_MS;
  if (heartbeatIsFresh && Number(row.background_terminal_processes ?? 0) > 0) {
    return true;
  }
  if (hasAcpBacklog()) {
    return !shouldTerminateQueueStalledWorker({ worker, row, now });
  }
  return heartbeatIsFresh;
}

function hasAcpBacklog(): boolean {
  return hasQueuedOrRunningAcpJobs();
}

function acpJobReferenceTimestamp(row: {
  updated_at?: number | null;
  created_at?: number | null;
}): number | undefined {
  const updatedAt = Number(row.updated_at ?? 0);
  if (Number.isFinite(updatedAt) && updatedAt > 0) return updatedAt;
  const createdAt = Number(row.created_at ?? 0);
  return Number.isFinite(createdAt) && createdAt > 0 ? createdAt : undefined;
}

function acpBacklogStaleSince(worker_id: string): number | undefined {
  let oldest = oldestQueuedAcpJobTimestamp();
  for (const row of listRunningAcpJobsByWorker(worker_id)) {
    const timestamp = acpJobReferenceTimestamp(row);
    if (timestamp == null) continue;
    oldest = oldest == null ? timestamp : Math.min(oldest, timestamp);
  }
  return oldest;
}

function countRunningJobsForWorker(worker_id: string): number {
  return countRunningAcpJobsForWorker(worker_id);
}

function workerHasRunningCommandJob(worker_id: string): boolean {
  for (const job of listRunningAcpJobsByWorker(worker_id)) {
    try {
      if (decodeAcpJobRequest(job).request_kind === "command") return true;
    } catch (err) {
      logger.warn("failed decoding running ACP job request", {
        worker_id,
        op_id: job.op_id,
        err,
      });
    }
  }
  return false;
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function shouldTerminateQueueStalledWorker({
  worker,
  status,
  row,
  now = Date.now(),
  stallMs = ACP_WORKER_QUEUE_STALL_MS,
}: {
  worker: WorkerProcessInfo;
  status?: AcpDaemonStatus;
  row?: ReturnType<typeof getAcpWorker>;
  now?: number;
  stallMs?: number;
}): boolean {
  const worker_id = workerIdOf(worker);
  if (!worker_id) return false;
  const runningTurnLeases = Math.max(
    numberOrUndefined(status?.running_turn_leases) ?? 0,
    countRunningAcpTurnLeasesForWorker(worker_id),
  );
  if (runningTurnLeases > 0) return false;
  const backgroundTerminalProcesses = Math.max(
    numberOrUndefined(status?.background_terminal_processes) ?? 0,
    row &&
      now - Number(row.last_heartbeat_at ?? 0) <=
        ACP_WORKER_DB_HEARTBEAT_STALE_MS
      ? (numberOrUndefined(row.background_terminal_processes) ?? 0)
      : 0,
  );
  if (backgroundTerminalProcesses > 0) return false;
  if (workerHasRunningCommandJob(worker_id)) return false;
  const backlogSince = acpBacklogStaleSince(worker_id);
  if (backlogSince == null || now - backlogSince < stallMs) return false;
  const startedAt = Math.max(
    workerStartedAtMs(worker),
    numberOrUndefined(row?.started_at) ?? 0,
    numberOrUndefined(status?.started_at) ?? 0,
  );
  const queueProgressAt = Math.max(
    numberOrUndefined(status?.last_queue_progress_at) ?? 0,
    numberOrUndefined(row?.last_queue_progress_at) ?? 0,
    startedAt,
  );
  return queueProgressAt <= 0 || now - queueProgressAt >= stallMs;
}

export function shouldTerminateOverdueDrainingWorker({
  worker,
  status,
  row,
  now = Date.now(),
  drainTerminateMs = ACP_WORKER_DRAIN_TERMINATE_MS,
}: {
  worker: WorkerProcessInfo;
  status?: AcpDaemonStatus;
  row?: ReturnType<typeof getAcpWorker>;
  now?: number;
  drainTerminateMs?: number;
}): boolean {
  const state = status?.state ?? row?.state;
  if (state !== "draining") return false;
  const exitRequestedAt = numberOrUndefined(
    status?.exit_requested_at ?? row?.exit_requested_at,
  );
  if (exitRequestedAt == null || exitRequestedAt <= 0) return false;
  if (now - exitRequestedAt < drainTerminateMs) return false;
  const worker_id = workerIdOf(worker);
  const runningJobs = Math.max(
    numberOrUndefined(status?.last_seen_running_jobs) ?? 0,
    numberOrUndefined(row?.last_seen_running_jobs) ?? 0,
    worker_id ? countRunningJobsForWorker(worker_id) : 0,
  );
  if (runningJobs > 0) return false;
  const runningTurnLeases = Math.max(
    numberOrUndefined(status?.running_turn_leases) ?? 0,
    worker_id ? countRunningAcpTurnLeasesForWorker(worker_id) : 0,
  );
  if (runningTurnLeases > 0) return false;
  const backgroundTerminalProcesses = Math.max(
    numberOrUndefined(status?.background_terminal_processes) ?? 0,
    row &&
      now - Number(row.last_heartbeat_at ?? 0) <=
        ACP_WORKER_DB_HEARTBEAT_STALE_MS
      ? (numberOrUndefined(row.background_terminal_processes) ?? 0)
      : 0,
  );
  return backgroundTerminalProcesses <= 0;
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
      waitForInterest: true,
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

export async function fenceProjectHostAcpWork({
  project_id,
  reason = ACP_PROJECT_RESTART_FENCE_REASON,
}: {
  project_id: string;
  reason?: string;
}): Promise<void> {
  // Persist the terminal fence before asking workers to release live runtimes.
  // This also covers a host with no currently running ACP worker.
  fenceAcpJobsForProject({ project_id, reason });
  fenceAcpTurnLeasesForProject({ project_id, reason });
  clearAcpPayloadsForProject(project_id);
  for (const worker of listProjectHostAcpWorkers()) {
    const worker_id = workerIdOf(worker);
    const host_id = `${worker.env.PROJECT_HOST_ID ?? ""}`.trim();
    try {
      if (!worker_id || !host_id)
        throw new Error("worker identity unavailable");
      await acpDaemonControlClient({
        client: getProjectHostConatClient(),
        host_id,
        worker_id,
        timeout: Math.max(ACP_WORKER_CONTROL_TIMEOUT_MS, 10_000),
        waitForInterest: true,
      }).fenceProject({ project_id, reason });
    } catch (err) {
      logger.warn("ACP worker did not acknowledge project restart fence", {
        project_id,
        worker_id,
        pid: worker.pid,
        err,
      });
      await terminateWorker(worker, "project_restart_fence_unacknowledged");
    }
  }
}

export function workerBundleVersionOf(
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

export function listProjectHostAcpWorkers(): WorkerProcessInfo[] {
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
  const observedCommand = worker.cmdline[0];
  const commandMatches =
    path.resolve(observedCommand) === launch.resolvedCommand;
  const titledProcessMatches =
    observedCommand === getProjectHostProcessTitle({ env: worker.env });
  if (!commandMatches && !titledProcessMatches) {
    return false;
  }
  if (!launch.nodeLike) {
    return true;
  }
  const entryPoint = worker.cmdline[1];
  if (entryPoint != null && entryPoint.length > 0) {
    if (!launch.resolvedEntryPoint) {
      return false;
    }
    return path.resolve(entryPoint) === launch.resolvedEntryPoint;
  }
  if (!titledProcessMatches) {
    return false;
  }
  const explicitBundlePath =
    `${worker.env.COCALC_PROJECT_HOST_ACP_WORKER_BUNDLE_PATH ?? ""}`.trim();
  if (!explicitBundlePath) {
    return false;
  }
  const expectedBundlePath = resolveProjectHostWorkerBundlePath(launch);
  const workerBundlePath = workerBundlePathOf(worker, launch);
  return workerBundlePath === expectedBundlePath;
}

export function partitionExpectedProjectHostAcpWorkers({
  workers,
  launch,
}: {
  workers: WorkerProcessInfo[];
  launch: WorkerLaunch;
}): {
  expectedWorkers: WorkerProcessInfo[];
  ignoredWorkers: WorkerProcessInfo[];
} {
  const expectedWorkers: WorkerProcessInfo[] = [];
  const ignoredWorkers: WorkerProcessInfo[] = [];
  for (const worker of workers) {
    if (isExpectedWorkerProcess(worker, launch)) {
      expectedWorkers.push(worker);
    } else {
      ignoredWorkers.push(worker);
    }
  }
  return { expectedWorkers, ignoredWorkers };
}

function isRecognizedWorkerEntrypoint(entryPoint?: string): boolean {
  if (!entryPoint) return false;
  const normalized = path.resolve(entryPoint);
  return (
    path.basename(normalized) === "index.js" &&
    path.basename(path.dirname(normalized)) === "main" &&
    path.basename(path.dirname(path.dirname(normalized))) !== "main"
  );
}

function isManageableWorkerProcess(
  worker: WorkerProcessInfo,
  launch: WorkerLaunch,
): boolean {
  if (isExpectedWorkerProcess(worker, launch)) {
    return true;
  }
  if (worker.cmdline.length === 0) return false;
  const observedCommand = worker.cmdline[0];
  const commandMatches =
    path.resolve(observedCommand) === launch.resolvedCommand;
  const titledProcessMatches =
    observedCommand === getProjectHostProcessTitle({ env: worker.env });
  if (!commandMatches && !titledProcessMatches) {
    return false;
  }
  if (!launch.nodeLike) {
    return true;
  }
  const entryPoint = worker.cmdline[1];
  if (entryPoint != null && entryPoint.length > 0) {
    return isRecognizedWorkerEntrypoint(entryPoint);
  }
  const bundlePath =
    `${worker.env.COCALC_PROJECT_HOST_ACP_WORKER_BUNDLE_PATH ?? ""}`.trim();
  return titledProcessMatches && bundlePath.length > 0;
}

export function partitionManageableProjectHostAcpWorkers({
  workers,
  launch,
}: {
  workers: WorkerProcessInfo[];
  launch: WorkerLaunch;
}): {
  managedWorkers: WorkerProcessInfo[];
  ignoredWorkers: WorkerProcessInfo[];
} {
  const managedWorkers: WorkerProcessInfo[] = [];
  const ignoredWorkers: WorkerProcessInfo[] = [];
  for (const worker of workers) {
    if (isManageableWorkerProcess(worker, launch)) {
      managedWorkers.push(worker);
    } else {
      ignoredWorkers.push(worker);
    }
  }
  return { managedWorkers, ignoredWorkers };
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

async function terminateWorker(
  worker: WorkerProcessInfo,
  reason: string,
): Promise<void> {
  await terminateWorkerPid(worker.pid);
  const worker_id = workerIdOf(worker);
  if (!worker_id) return;
  try {
    stopAcpWorker({ worker_id, reason });
  } catch (err) {
    logger.warn("failed marking terminated ACP worker stopped", {
      pid: worker.pid,
      worker_id,
      reason,
      err,
    });
  }
}

export function staleAcpWorkerRowsToStop({
  rows,
  observedWorkers,
  now = Date.now(),
  staleMs = ACP_WORKER_DB_HEARTBEAT_STALE_MS,
}: {
  rows: AcpWorkerRow[];
  observedWorkers: WorkerProcessInfo[];
  now?: number;
  staleMs?: number;
}): AcpWorkerRow[] {
  const observed = new Set(
    observedWorkers.map((worker) => `${workerIdOf(worker)}:${worker.pid}`),
  );
  return rows.filter((row) => {
    if (row.state === "stopped") return false;
    const rowPid = Number(row.pid ?? 0);
    if (
      rowPid > 0 &&
      observed.has(`${`${row.worker_id ?? ""}`.trim()}:${rowPid}`)
    ) {
      return false;
    }
    const referenceAt = Math.max(
      Number(row.last_heartbeat_at ?? 0),
      Number(row.started_at ?? 0),
    );
    return referenceAt <= 0 || now - referenceAt >= staleMs;
  });
}

function reconcileStaleAcpWorkerRows({
  observedWorkers,
}: {
  observedWorkers: WorkerProcessInfo[];
}): void {
  const host_id = `${process.env.PROJECT_HOST_ID ?? ""}`.trim();
  const rows = listAcpWorkers({
    host_id: host_id || undefined,
    states: ["active", "draining"],
  });
  const staleRows = staleAcpWorkerRowsToStop({ rows, observedWorkers });
  if (!staleRows.length) return;
  for (const row of staleRows) {
    stopAcpWorker({
      worker_id: row.worker_id,
      reason: "ACP worker process is no longer running",
    });
  }
  logger.warn("marked stale ACP worker rows stopped", {
    count: staleRows.length,
    worker_ids: staleRows.slice(0, 20).map((row) => row.worker_id),
    truncated: staleRows.length > 20,
  });
}

async function reconcileProjectHostAcpWorkers({
  replaceMismatchedBundle = false,
}: {
  replaceMismatchedBundle?: boolean;
} = {}): Promise<number | undefined> {
  const launch = workerLaunchSignature();
  const { managedWorkers: observedWorkers } =
    partitionManageableProjectHostAcpWorkers({
      workers: listProjectHostAcpWorkers(),
      launch,
    });
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
  reconcileStaleAcpWorkerRows({ observedWorkers });
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
    const row = getAcpWorker(workerIdOf(worker));
    if (shouldTerminateOverdueDrainingWorker({ worker, status, row })) {
      logger.warn("terminating overdue draining project-host ACP worker", {
        pid: worker.pid,
        worker_id: workerIdOf(worker) || null,
        bundle_version: workerBundleVersionOf(worker, launch),
        bundle_path: workerBundlePathOf(worker, launch),
        state: status?.state ?? row?.state ?? null,
        last_seen_running_jobs:
          status?.last_seen_running_jobs ?? row?.last_seen_running_jobs ?? null,
        running_turn_leases: status?.running_turn_leases ?? null,
        exit_requested_at:
          status?.exit_requested_at ?? row?.exit_requested_at ?? null,
        drain_terminate_ms: ACP_WORKER_DRAIN_TERMINATE_MS,
      });
      await terminateWorker(worker, "overdue_draining_worker");
      continue;
    }
    if (
      isExpectedWorkerProcess(worker, launch) &&
      shouldTerminateQueueStalledWorker({ worker, status, row })
    ) {
      logger.warn("terminating queue-stalled project-host ACP worker", {
        pid: worker.pid,
        worker_id: workerIdOf(worker) || null,
        bundle_version: workerBundleVersionOf(worker, launch),
        bundle_path: workerBundlePathOf(worker, launch),
        state: status?.state ?? row?.state ?? null,
        last_seen_running_jobs:
          status?.last_seen_running_jobs ?? row?.last_seen_running_jobs ?? null,
        running_turn_leases: status?.running_turn_leases ?? null,
        last_queue_progress_at:
          status?.last_queue_progress_at ?? row?.last_queue_progress_at ?? null,
        queue_stall_ms: ACP_WORKER_QUEUE_STALL_MS,
      });
      await terminateWorker(worker, "queue_stalled_worker");
      continue;
    }
    if (
      status == null &&
      isExpectedWorkerProcess(worker, launch) &&
      workerControlStartupGraceExpired(worker) &&
      !workerDatabaseStateProtectsUnresponsiveWorker(worker)
    ) {
      logger.warn("terminating unresponsive active project-host ACP worker", {
        pid: worker.pid,
        worker_id: workerIdOf(worker) || null,
        bundle_version: workerBundleVersionOf(worker, launch),
        bundle_path: workerBundlePathOf(worker, launch),
        control_startup_grace_ms: ACP_WORKER_CONTROL_STARTUP_GRACE_MS,
        db_heartbeat_stale_ms: ACP_WORKER_DB_HEARTBEAT_STALE_MS,
      });
      await terminateWorker(worker, "unresponsive_worker");
      continue;
    }
    if (status?.state === "stopped") {
      logger.warn("terminating stale stopped project-host ACP worker", {
        pid: worker.pid,
        worker_id: status.worker_id,
        bundle_version: status.bundle_version,
        bundle_path: status.bundle_path,
      });
      await terminateWorker(worker, "stale_stopped_worker");
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
      preserveMismatchedActive: !replaceMismatchedBundle,
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
    const drainStatus = await requestWorkerDrain(worker);
    if (drainStatus && drainStatus.state !== "draining") {
      logger.info("deferring ACP worker replacement while it owns live work", {
        pid: worker.pid,
        worker_id: drainStatus.worker_id,
        last_seen_running_jobs: drainStatus.last_seen_running_jobs,
        running_turn_leases: drainStatus.running_turn_leases,
        background_terminal_processes:
          drainStatus.background_terminal_processes ?? 0,
      });
      writeFileSync(ACP_WORKER_PID_FILE, `${worker.pid}\n`);
      return worker.pid;
    }
  }
  for (const worker of workers) {
    if (!terminatePids.includes(worker.pid)) continue;
    logger.warn("terminating non-cooperative project-host ACP worker", {
      pid: worker.pid,
      cmdline: worker.cmdline,
    });
    await terminateWorker(worker, "non_cooperative_worker");
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
  const now = Date.now();
  const backoffRemainingMs = projectHostAcpWorkerSpawnBackoffRemainingMs(now);
  if (backoffRemainingMs > 0) {
    logger.warn("skipping ACP worker spawn due to restart backoff", {
      backoff_remaining_ms: backoffRemainingMs,
      attempt: workerSpawnAttemptCount,
      restartReason,
    });
    return false;
  }
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
    COCALC_PROJECT_HOST_ACP_WORKER_STARTED_AT: String(now),
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
    argv0: getProjectHostProcessTitle({ env }),
  });
  closeSync(stdout);
  child.unref();
  const { attempt, backoffMs } = noteProjectHostAcpWorkerSpawn(now);
  writeFileSync(ACP_WORKER_PID_FILE, `${child.pid}\n`);
  logger.warn("spawned project-host ACP worker", {
    pid: child.pid,
    worker_id,
    attempt,
    backoff_ms_until_next_attempt: backoffMs,
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
  replaceMismatchedBundle,
}: {
  restartReason?: string;
  replaceMismatchedBundle?: boolean;
} = {}): Promise<boolean> {
  const existingPid =
    (await reconcileProjectHostAcpWorkers({ replaceMismatchedBundle })) ??
    readWorkerPid();
  if (isPidAlive(existingPid)) {
    resetProjectHostAcpWorkerSpawnBackoff();
    return true;
  }
  return spawnProjectHostAcpWorker({ restartReason });
}

export async function ensureProjectHostAcpWorkerRunning({
  restartReason,
  replaceMismatchedBundle,
}: {
  restartReason?: string;
  replaceMismatchedBundle?: boolean;
} = {}): Promise<boolean> {
  const replacementRequested = replaceMismatchedBundle === true;
  if (ensureWorkerPromise != null) {
    const active = ensureWorkerPromise;
    const result = await active.promise;
    if (active.replaceMismatchedBundle || !replacementRequested) {
      return result;
    }
  }
  const promise = ensureProjectHostAcpWorkerRunningOnce({
    restartReason,
    replaceMismatchedBundle,
  });
  ensureWorkerPromise = {
    replaceMismatchedBundle: replacementRequested,
    promise,
  };
  try {
    return await promise;
  } finally {
    if (ensureWorkerPromise?.promise === promise) {
      ensureWorkerPromise = undefined;
    }
  }
}

export async function rolloutProjectHostAcpWorker({
  restartReason = "managed_component_rollout",
  desiredVersion,
}: {
  restartReason?: string;
  desiredVersion?: string;
} = {}): Promise<ProjectHostAcpWorkerRolloutOutcome> {
  if (desiredVersion) {
    writeProjectHostAcpWorkerTarget(desiredVersion);
  }
  const launch = workerLaunchSignature();
  const { managedWorkers: workers } = partitionManageableProjectHostAcpWorkers({
    workers: listProjectHostAcpWorkers(),
    launch,
  });
  if (!workers.length) {
    const spawned = await ensureProjectHostAcpWorkerRunning({ restartReason });
    return spawned
      ? {
          action: "spawned",
          message: "spawned ACP worker because none were running",
        }
      : {
          action: "noop",
          message: "ACP worker spawn was skipped",
        };
  }
  const workerStatuses = await Promise.all(
    workers.map(async (worker) => ({
      worker,
      status: await getWorkerStatus(worker),
    })),
  );
  const plan = planProjectHostAcpWorkerRollout({
    workers,
    launch,
    drainingWorkerIds: workerStatuses
      .map(({ worker, status }) =>
        status?.state === "draining" ? workerIdOf(worker) : undefined,
      )
      .filter(
        (worker_id): worker_id is string =>
          worker_id != null && worker_id.length > 0,
      ),
  });
  if (plan.activePid == null) {
    const spawned = await ensureProjectHostAcpWorkerRunning({
      restartReason,
      replaceMismatchedBundle: true,
    });
    return spawned
      ? {
          action: "spawned",
          message: "spawned replacement ACP worker",
        }
      : {
          action: "noop",
          message: "ACP worker replacement spawn was skipped",
        };
  }
  const activeWorker = workers.find((worker) => worker.pid === plan.activePid);
  if (!activeWorker) {
    throw new Error(`active ACP worker pid ${plan.activePid} disappeared`);
  }
  if (!workerRollingCapable(activeWorker)) {
    logger.warn("forcing non-cooperative ACP worker replacement for rollout", {
      pid: activeWorker.pid,
      cmdline: activeWorker.cmdline,
    });
    await terminateWorker(activeWorker, "rollout_replacement");
    const spawned = await ensureProjectHostAcpWorkerRunning({
      restartReason,
      replaceMismatchedBundle: true,
    });
    return spawned
      ? {
          action: "spawned",
          pid: activeWorker.pid,
          message:
            "terminated non-cooperative ACP worker and spawned a replacement",
        }
      : {
          action: "noop",
          pid: activeWorker.pid,
          message:
            "terminated non-cooperative ACP worker but replacement spawn was skipped",
        };
  }
  const status = await requestWorkerDrain(activeWorker);
  if (!status) {
    throw new Error(
      `failed requesting drain for ACP worker ${workerIdOf(activeWorker) || activeWorker.pid}`,
    );
  }
  if (status.state !== "draining") {
    return {
      action: "noop",
      pid: activeWorker.pid,
      worker_id: status.worker_id,
      message:
        "deferred ACP worker rollout because it owns an active turn or background command",
    };
  }
  await ensureProjectHostAcpWorkerRunning({
    restartReason,
    replaceMismatchedBundle: true,
  });
  return {
    action: "drain_requested",
    pid: activeWorker.pid,
    worker_id: status.worker_id,
    message: "requested drain for active ACP worker and ensured replacement",
  };
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

export const __test__ = {
  projectHostAcpWorkerSpawnBackoffDelayMs,
  projectHostAcpWorkerSpawnBackoffRemainingMs,
  noteProjectHostAcpWorkerSpawn,
  resetProjectHostAcpWorkerSpawnBackoff,
  workerDatabaseStateProtectsUnresponsiveWorker,
  workerControlStartupGraceExpired,
  staleAcpWorkerRowsToStop,
  shouldTerminateQueueStalledWorker,
};
