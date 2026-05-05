import getLogger from "@cocalc/backend/logger";
import type {
  HostAgentProjectHostRolloutPhase,
  HostAgentProjectHostRolloutState,
} from "@cocalc/conat/project-host/api";
import {
  ensureDaemon,
  inspectProjectHostRuntime,
  restartProjectHost,
} from "./daemon";
import {
  appendSupervisionEvent,
  type SupervisionEvent,
} from "./supervision-events";
import {
  readHostAgentState,
  type HostAgentState,
  type ProjectHostRollbackPending,
  type ProjectHostRollbackRecord,
  writeHostAgentState,
} from "./host-agent-state";
import { activateInstalledProjectHostVersion } from "./upgrade";

const logger = getLogger("project-host:host-agent");

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

function recordHostAgentEvent(
  dataDir: string,
  event: Omit<SupervisionEvent, "source">,
): void {
  try {
    appendSupervisionEvent(dataDir, {
      source: "host-agent",
      ...event,
    });
  } catch {
    // best effort
  }
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

function setProjectHostRolloutState(
  state: HostAgentState,
  rollout: HostAgentProjectHostRolloutState,
): boolean {
  const projectHost = ensureProjectHostSection(state);
  const current = projectHost.rollout;
  if (JSON.stringify(current ?? null) === JSON.stringify(rollout)) {
    return false;
  }
  projectHost.rollout = rollout;
  return true;
}

function phaseForPendingRollout({
  pending,
  runningVersion,
  healthy,
}: {
  pending: ProjectHostRollbackPending;
  runningVersion?: string;
  healthy: boolean;
}): HostAgentProjectHostRolloutPhase {
  if (runningVersion === pending.target_version) {
    return healthy
      ? "candidate_running_healthy"
      : "candidate_running_unhealthy";
  }
  if (!runningVersion || runningVersion !== pending.previous_version) {
    return "candidate_starting";
  }
  return "restart_requested";
}

function recordRolloutState({
  state,
  phase,
  targetVersion,
  previousVersion,
  startedAt,
  deadlineAt,
  runningPid,
  runningVersion,
  healthy,
  acceptedAt,
  rollbackStartedAt,
  rollbackFinishedAt,
  failureReason,
}: {
  state: HostAgentState;
  phase: HostAgentProjectHostRolloutPhase;
  targetVersion?: string;
  previousVersion?: string;
  startedAt?: string;
  deadlineAt?: string;
  runningPid?: number;
  runningVersion?: string;
  healthy?: boolean;
  acceptedAt?: string;
  rollbackStartedAt?: string;
  rollbackFinishedAt?: string;
  failureReason?: "health_deadline_exceeded";
}): boolean {
  return setProjectHostRolloutState(state, {
    phase,
    ...(targetVersion ? { target_version: targetVersion } : {}),
    ...(previousVersion ? { previous_version: previousVersion } : {}),
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(deadlineAt ? { deadline_at: deadlineAt } : {}),
    ...(runningPid != null ? { running_pid: runningPid } : {}),
    ...(runningVersion ? { running_version: runningVersion } : {}),
    ...(healthy != null ? { healthy } : {}),
    ...(acceptedAt ? { accepted_at: acceptedAt } : {}),
    ...(rollbackStartedAt ? { rollback_started_at: rollbackStartedAt } : {}),
    ...(rollbackFinishedAt ? { rollback_finished_at: rollbackFinishedAt } : {}),
    ...(failureReason ? { failure_reason: failureReason } : {}),
  });
}

function rememberSuccessfulVersion({
  state,
  version,
  pending,
  nowIso,
  runningPid,
  runningVersion,
  healthy,
  phase,
}: {
  state: HostAgentState;
  version: string;
  pending?: ProjectHostRollbackPending;
  nowIso: string;
  runningPid?: number;
  runningVersion?: string;
  healthy?: boolean;
  phase: "stable" | "promoted";
}): boolean {
  const projectHost = ensureProjectHostSection(state);
  projectHost.last_known_good_version = version;
  if (!pending || pending.target_version === version) {
    delete projectHost.pending_rollout;
  }
  return recordRolloutState({
    state,
    phase,
    targetVersion: pending?.target_version ?? version,
    previousVersion: pending?.previous_version,
    startedAt: pending?.started_at,
    deadlineAt: pending?.deadline_at,
    runningPid,
    runningVersion: runningVersion ?? version,
    healthy,
    ...(phase === "promoted" ? { acceptedAt: nowIso } : {}),
  });
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
  const state = readHostAgentState(status.dataDir);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const currentVersion = `${status.currentVersion ?? ""}`.trim() || undefined;
  const runningVersion = `${status.runningVersion ?? ""}`.trim() || undefined;
  const effectiveLastKnownGood = effectiveLastKnownGoodVersion(
    state,
    currentVersion,
  );

  if (currentVersion && !state.project_host?.last_known_good_version) {
    rememberSuccessfulVersion({
      state,
      version: effectiveLastKnownGood ?? currentVersion,
      nowIso,
      runningPid: status.runningPid,
      runningVersion,
      healthy: status.healthy,
      phase: "stable",
    });
    writeHostAgentState(status.dataDir, state);
  }

  const lastKnownGood = effectiveLastKnownGood;
  const pending = currentPendingRollout(state);

  if (!currentVersion || !lastKnownGood || currentVersion === lastKnownGood) {
    if (pending) {
      clearPendingRollout(state);
      recordRolloutState({
        state,
        phase:
          state.project_host?.last_automatic_rollback?.rollback_version ===
            lastKnownGood &&
          state.project_host?.rollout?.phase === "rollback_requested"
            ? "rolled_back"
            : "stable",
        targetVersion:
          state.project_host?.rollout?.target_version ?? currentVersion,
        previousVersion: state.project_host?.rollout?.previous_version,
        startedAt: state.project_host?.rollout?.started_at,
        deadlineAt: state.project_host?.rollout?.deadline_at,
        runningPid: status.runningPid,
        runningVersion,
        healthy: status.healthy,
        rollbackStartedAt:
          state.project_host?.rollout?.rollback_started_at ??
          state.project_host?.last_automatic_rollback?.started_at,
        rollbackFinishedAt:
          state.project_host?.last_automatic_rollback?.finished_at,
        failureReason: state.project_host?.rollout?.failure_reason,
      });
      writeHostAgentState(status.dataDir, state);
    } else if (state.project_host?.rollout?.phase === "rollback_requested") {
      if (
        recordRolloutState({
          state,
          phase: "rolled_back",
          targetVersion: state.project_host.rollout.target_version,
          previousVersion:
            state.project_host.rollout.previous_version ?? lastKnownGood,
          startedAt: state.project_host.rollout.started_at,
          deadlineAt: state.project_host.rollout.deadline_at,
          runningPid: status.runningPid,
          runningVersion,
          healthy: status.healthy,
          rollbackStartedAt: state.project_host.rollout.rollback_started_at,
          rollbackFinishedAt:
            state.project_host?.last_automatic_rollback?.finished_at ?? nowIso,
          failureReason:
            state.project_host.rollout.failure_reason ??
            state.project_host?.last_automatic_rollback?.reason,
        })
      ) {
        writeHostAgentState(status.dataDir, state);
      }
    } else if (
      !state.project_host?.rollout ||
      !["promoted", "rolled_back"].includes(state.project_host.rollout.phase)
    ) {
      const stableVersion = lastKnownGood ?? currentVersion;
      if (
        stableVersion &&
        rememberSuccessfulVersion({
          state,
          version: stableVersion,
          nowIso,
          runningPid: status.runningPid,
          runningVersion,
          healthy: status.healthy,
          phase: "stable",
        })
      ) {
        writeHostAgentState(status.dataDir, state);
      }
    }
    return;
  }

  if (!pending && status.healthy && runningVersion === lastKnownGood) {
    const activePending = beginPendingRollout({
      state,
      targetVersion: currentVersion,
      previousVersion: lastKnownGood,
      now,
      timeoutMs,
    });
    recordRolloutState({
      state,
      phase: "restart_requested",
      targetVersion: currentVersion,
      previousVersion: lastKnownGood,
      startedAt: activePending.started_at,
      deadlineAt: activePending.deadline_at,
      runningPid: status.runningPid,
      runningVersion,
      healthy: status.healthy,
    });
    writeHostAgentState(status.dataDir, state);
    logger.warn("host-agent restarting project-host onto rollout candidate", {
      index,
      target_version: currentVersion,
      previous_version: lastKnownGood,
      deadline_at: activePending.deadline_at,
      running_version: runningVersion,
      pid: status.runningPid,
    });
    recordHostAgentEvent(status.dataDir, {
      component: "project-host",
      action: "restart_requested",
      message: "restarting project-host onto rollout candidate",
      pid: status.runningPid,
      target_version: currentVersion,
      previous_version: lastKnownGood,
      running_version: runningVersion,
      deadline_at: activePending.deadline_at,
      metadata: {
        healthy: status.healthy,
        proactive_restart: true,
      },
    });
    restartProjectHost(index, {
      preserveManagedAuxiliaryDaemons: true,
    });
    return;
  }

  if (status.healthy && runningVersion === currentVersion) {
    logger.info("host-agent accepted project-host candidate as healthy", {
      index,
      version: currentVersion,
      pid: status.runningPid,
    });
    recordHostAgentEvent(status.dataDir, {
      component: "project-host",
      action: "rollback_accepted",
      message: "accepted project-host candidate as healthy",
      pid: status.runningPid,
      current_version: currentVersion,
      running_version: runningVersion,
    });
    rememberSuccessfulVersion({
      state,
      version: currentVersion,
      pending,
      nowIso,
      runningPid: status.runningPid,
      runningVersion,
      healthy: status.healthy,
      phase: "promoted",
    });
    writeHostAgentState(status.dataDir, state);
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
    recordRolloutState({
      state,
      phase: phaseForPendingRollout({
        pending: activePending,
        runningVersion,
        healthy: status.healthy,
      }),
      targetVersion: currentVersion,
      previousVersion: lastKnownGood,
      startedAt: activePending.started_at,
      deadlineAt: activePending.deadline_at,
      runningPid: status.runningPid,
      runningVersion,
      healthy: status.healthy,
    });
    writeHostAgentState(status.dataDir, state);
    logger.warn("host-agent tracking project-host rollout candidate", {
      index,
      target_version: currentVersion,
      previous_version: lastKnownGood,
      deadline_at: activePending.deadline_at,
      running_version: runningVersion,
      healthy: status.healthy,
      pid: status.runningPid,
    });
    recordHostAgentEvent(status.dataDir, {
      component: "project-host",
      action: "rollback_tracking",
      message: "tracking project-host rollout candidate",
      pid: status.runningPid,
      target_version: currentVersion,
      previous_version: lastKnownGood,
      running_version: runningVersion,
      deadline_at: activePending.deadline_at,
      metadata: {
        healthy: status.healthy,
      },
    });
    return;
  }

  if (activePending) {
    const rolloutChanged = recordRolloutState({
      state,
      phase: phaseForPendingRollout({
        pending: activePending,
        runningVersion,
        healthy: status.healthy,
      }),
      targetVersion: activePending.target_version,
      previousVersion: activePending.previous_version,
      startedAt: activePending.started_at,
      deadlineAt: activePending.deadline_at,
      runningPid: status.runningPid,
      runningVersion,
      healthy: status.healthy,
      rollbackStartedAt: state.project_host?.rollout?.rollback_started_at,
      failureReason: state.project_host?.rollout?.failure_reason,
    });
    if (rolloutChanged) {
      writeHostAgentState(status.dataDir, state);
    }
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
    recordHostAgentEvent(status.dataDir, {
      component: "project-host",
      action: "restart_requested",
      message: "rolling back unhealthy project-host candidate",
      pid: status.runningPid,
      target_version: activePending.target_version,
      previous_version: activePending.previous_version,
      running_version: runningVersion,
      deadline_at: activePending.deadline_at,
      metadata: {
        healthy: status.healthy,
      },
    });
    recordRolloutState({
      state,
      phase: "rollback_requested",
      targetVersion: activePending.target_version,
      previousVersion: activePending.previous_version,
      startedAt: activePending.started_at,
      deadlineAt: activePending.deadline_at,
      runningPid: status.runningPid,
      runningVersion,
      healthy: status.healthy,
      rollbackStartedAt: nowIso,
      failureReason: "health_deadline_exceeded",
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
    writeHostAgentState(status.dataDir, state);
    logger.warn("host-agent completed local project-host rollback", {
      index,
      target_version: activePending.target_version,
      rollback_version: activePending.previous_version,
    });
    recordHostAgentEvent(status.dataDir, {
      component: "project-host",
      action: "rollback_completed",
      message: "completed local project-host rollback",
      target_version: activePending.target_version,
      previous_version: activePending.previous_version,
      current_version: activePending.previous_version,
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
    recordHostAgentEvent(
      `${process.env.COCALC_DATA ?? process.env.DATA ?? "/mnt/cocalc/data"}`,
      {
        component: "host-agent",
        action: "shutdown",
        message: "host-agent shutting down",
        metadata: {
          signal,
          index,
        },
      },
    );
  };

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  logger.info("host-agent started", {
    index,
    poll_ms: pollMs,
    project_host_rollback_timeout_ms: rollbackTimeoutMs,
  });
  recordHostAgentEvent(
    `${process.env.COCALC_DATA ?? process.env.DATA ?? "/mnt/cocalc/data"}`,
    {
      component: "host-agent",
      action: "started",
      message: "host-agent started",
      metadata: {
        index,
        poll_ms: pollMs,
        project_host_rollback_timeout_ms: rollbackTimeoutMs,
      },
    },
  );

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
      recordHostAgentEvent(
        `${process.env.COCALC_DATA ?? process.env.DATA ?? "/mnt/cocalc/data"}`,
        {
          component: "host-agent",
          action: "reconcile_failed",
          message: "host-agent reconcile failed",
          metadata: {
            index,
            error: `${err}`,
          },
        },
      );
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
