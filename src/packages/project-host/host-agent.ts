import fs from "node:fs";
import path from "node:path";
import getLogger from "@cocalc/backend/logger";
import {
  ensureDaemon,
  inspectProjectHostRuntime,
  restartProjectHost,
} from "./daemon";
import { activateInstalledProjectHostVersion } from "./upgrade";

const logger = getLogger("project-host:host-agent");

export type ProjectHostRollbackPending = {
  target_version: string;
  previous_version: string;
  started_at: string;
  deadline_at: string;
};

export type ProjectHostRollbackRecord = {
  target_version: string;
  rollback_version: string;
  started_at: string;
  finished_at: string;
  reason: "health_deadline_exceeded";
};

export type HostAgentState = {
  project_host?: {
    last_known_good_version?: string;
    pending_rollout?: ProjectHostRollbackPending;
    last_automatic_rollback?: ProjectHostRollbackRecord;
  };
};

function parseIndex(argv: string[]): number {
  const indexFlag = argv.findIndex((arg) => arg === "--index");
  const raw =
    (indexFlag >= 0 ? argv[indexFlag + 1] : undefined) ??
    process.env.COCALC_PROJECT_HOST_AGENT_INDEX ??
    "0";
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `invalid host-agent index "${raw}"; expected a non-negative integer`,
    );
  }
  return index;
}

function getPollMs(): number {
  const raw = Number(process.env.COCALC_PROJECT_HOST_AGENT_POLL_MS ?? 5000);
  if (!Number.isFinite(raw) || raw < 1000) {
    return 5000;
  }
  return Math.floor(raw);
}

function getProjectHostRollbackTimeoutMs(): number {
  const raw = Number(
    process.env.COCALC_PROJECT_HOST_AGENT_PROJECT_HOST_ROLLBACK_TIMEOUT_MS ??
      120_000,
  );
  if (!Number.isFinite(raw) || raw < 10_000) {
    return 120_000;
  }
  return Math.floor(raw);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function stateFilePath(dataDir: string): string {
  return path.join(dataDir, "host-agent-state.json");
}

function readState(dataDir: string): HostAgentState {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(dataDir), "utf8"));
  } catch {
    return {};
  }
}

export function readHostAgentState(dataDir?: string): HostAgentState {
  const resolved =
    `${dataDir ?? process.env.COCALC_DATA ?? process.env.DATA ?? ""}`.trim() ||
    "/mnt/cocalc/data";
  return readState(resolved);
}

function writeState(dataDir: string, state: HostAgentState): void {
  const file = stateFilePath(dataDir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function effectiveLastKnownGoodVersion(
  state: HostAgentState,
  currentVersion?: string,
): string | undefined {
  return (
    `${state.project_host?.last_known_good_version ?? ""}`.trim() ||
    currentVersion
  );
}

function currentPendingRollout(
  state: HostAgentState,
): ProjectHostRollbackPending | undefined {
  const pending = state.project_host?.pending_rollout;
  if (!pending?.target_version?.trim() || !pending?.previous_version?.trim()) {
    return;
  }
  return pending;
}

function ensureProjectHostSection(
  state: HostAgentState,
): NonNullable<HostAgentState["project_host"]> {
  state.project_host ??= {};
  return state.project_host;
}

function deadlineExpired(iso: string, now: number): boolean {
  const deadline = Date.parse(iso);
  return Number.isFinite(deadline) && deadline <= now;
}

function beginPendingRollout({
  state,
  targetVersion,
  previousVersion,
  now,
  timeoutMs,
}: {
  state: HostAgentState;
  targetVersion: string;
  previousVersion: string;
  now: number;
  timeoutMs: number;
}): ProjectHostRollbackPending {
  const pending: ProjectHostRollbackPending = {
    target_version: targetVersion,
    previous_version: previousVersion,
    started_at: new Date(now).toISOString(),
    deadline_at: new Date(now + timeoutMs).toISOString(),
  };
  ensureProjectHostSection(state).pending_rollout = pending;
  return pending;
}

function clearPendingRollout(state: HostAgentState): void {
  if (state.project_host) {
    delete state.project_host.pending_rollout;
  }
}

function rememberSuccessfulVersion(
  state: HostAgentState,
  version: string,
  pending?: ProjectHostRollbackPending,
): void {
  const projectHost = ensureProjectHostSection(state);
  projectHost.last_known_good_version = version;
  if (!pending || pending.target_version === version) {
    delete projectHost.pending_rollout;
  }
}

function recordAutomaticRollback(
  state: HostAgentState,
  rollback: ProjectHostRollbackRecord,
): void {
  const projectHost = ensureProjectHostSection(state);
  projectHost.last_known_good_version = rollback.rollback_version;
  delete projectHost.pending_rollout;
  projectHost.last_automatic_rollback = rollback;
}

async function reconcileProjectHostRollback({
  index,
  timeoutMs,
}: {
  index: number;
  timeoutMs: number;
}): Promise<void> {
  const status = inspectProjectHostRuntime(index);
  const state = readState(status.dataDir);
  const now = Date.now();
  const currentVersion = `${status.currentVersion ?? ""}`.trim() || undefined;
  const runningVersion = `${status.runningVersion ?? ""}`.trim() || undefined;
  const effectiveLastKnownGood = effectiveLastKnownGoodVersion(
    state,
    currentVersion,
  );

  if (currentVersion && !state.project_host?.last_known_good_version) {
    rememberSuccessfulVersion(state, effectiveLastKnownGood ?? currentVersion);
    writeState(status.dataDir, state);
  }

  const lastKnownGood = effectiveLastKnownGood;
  const pending = currentPendingRollout(state);

  if (!currentVersion || !lastKnownGood || currentVersion === lastKnownGood) {
    if (pending) {
      clearPendingRollout(state);
      writeState(status.dataDir, state);
    }
    return;
  }

  if (status.healthy && runningVersion === currentVersion) {
    logger.info("host-agent accepted project-host candidate as healthy", {
      index,
      version: currentVersion,
      pid: status.runningPid,
    });
    rememberSuccessfulVersion(state, currentVersion, pending);
    writeState(status.dataDir, state);
    return;
  }

  const rolloutActive =
    !status.healthy || !runningVersion || runningVersion !== lastKnownGood;
  let activePending = pending;
  if (
    rolloutActive &&
    (!activePending || activePending.target_version !== currentVersion)
  ) {
    activePending = beginPendingRollout({
      state,
      targetVersion: currentVersion,
      previousVersion: lastKnownGood,
      now,
      timeoutMs,
    });
    writeState(status.dataDir, state);
    logger.warn("host-agent tracking project-host rollout candidate", {
      index,
      target_version: currentVersion,
      previous_version: lastKnownGood,
      deadline_at: activePending.deadline_at,
      running_version: runningVersion,
      healthy: status.healthy,
      pid: status.runningPid,
    });
    return;
  }

  if (
    activePending &&
    activePending.target_version === currentVersion &&
    deadlineExpired(activePending.deadline_at, now)
  ) {
    logger.error("host-agent rolling back unhealthy project-host candidate", {
      index,
      target_version: activePending.target_version,
      rollback_version: activePending.previous_version,
      started_at: activePending.started_at,
      deadline_at: activePending.deadline_at,
      running_version: runningVersion,
      healthy: status.healthy,
      pid: status.runningPid,
    });
    await activateInstalledProjectHostVersion(activePending.previous_version);
    restartProjectHost(index, {
      preserveManagedAuxiliaryDaemons: true,
    });
    recordAutomaticRollback(state, {
      target_version: activePending.target_version,
      rollback_version: activePending.previous_version,
      started_at: activePending.started_at,
      finished_at: new Date(now).toISOString(),
      reason: "health_deadline_exceeded",
    });
    writeState(status.dataDir, state);
    logger.warn("host-agent completed local project-host rollback", {
      index,
      target_version: activePending.target_version,
      rollback_version: activePending.previous_version,
    });
  }
}

export const __test__ = {
  beginPendingRollout,
  currentPendingRollout,
  deadlineExpired,
  effectiveLastKnownGoodVersion,
  reconcileProjectHostRollback,
};

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const index = parseIndex(argv);
  const pollMs = getPollMs();
  const rollbackTimeoutMs = getProjectHostRollbackTimeoutMs();
  let stopping = false;

  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("host-agent shutting down", { signal, index });
  };

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  logger.info("host-agent started", {
    index,
    poll_ms: pollMs,
    project_host_rollback_timeout_ms: rollbackTimeoutMs,
  });

  while (!stopping) {
    try {
      ensureDaemon(index, {
        quietHealthy: true,
        preserveManagedAuxiliaryDaemons: true,
      });
      await reconcileProjectHostRollback({
        index,
        timeoutMs: rollbackTimeoutMs,
      });
    } catch (err) {
      logger.warn("host-agent reconcile failed", { index, err: `${err}` });
    }
    if (stopping) {
      break;
    }
    await sleep(pollMs);
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error("host-agent failed", err);
    process.exitCode = 1;
  });
}
