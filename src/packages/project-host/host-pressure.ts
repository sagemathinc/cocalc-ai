/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import type {
  HostCurrentMetrics,
  HostPressureState,
  HostPressureZone,
} from "@cocalc/conat/hub/api/hosts";
import { listProjects, type ProjectRow } from "./sqlite/projects";
import {
  getProjectStopState,
  listProjectStopPolicies,
  type ProjectStopPolicyRow,
  upsertProjectStopState,
} from "./sqlite/stop-policy";

const logger = getLogger("project-host:host-pressure");

const CONTROLLER_INTERVAL_MS = Math.max(
  2_000,
  Number(process.env.COCALC_PROJECT_HOST_PRESSURE_INTERVAL_MS ?? 10_000),
);
const OBSERVE_MEMORY_USED_PERCENT = clampPercent(
  process.env.COCALC_PROJECT_HOST_PRESSURE_OBSERVE_MEMORY_USED_PERCENT,
  85,
);
const PRESSURE_MEMORY_USED_PERCENT = clampPercent(
  process.env.COCALC_PROJECT_HOST_PRESSURE_MEMORY_USED_PERCENT,
  90,
);
const EMERGENCY_MEMORY_USED_PERCENT = clampPercent(
  process.env.COCALC_PROJECT_HOST_EMERGENCY_MEMORY_USED_PERCENT,
  95,
);
const OBSERVE_MEMORY_AVAILABLE_BYTES = clampNonNegativeInteger(
  process.env.COCALC_PROJECT_HOST_PRESSURE_OBSERVE_MEMORY_AVAILABLE_BYTES,
  2 * 1024 ** 3,
);
const PRESSURE_MEMORY_AVAILABLE_BYTES = clampNonNegativeInteger(
  process.env.COCALC_PROJECT_HOST_PRESSURE_MEMORY_AVAILABLE_BYTES,
  1 * 1024 ** 3,
);
const EMERGENCY_MEMORY_AVAILABLE_BYTES = clampNonNegativeInteger(
  process.env.COCALC_PROJECT_HOST_EMERGENCY_MEMORY_AVAILABLE_BYTES,
  512 * 1024 ** 2,
);
const STARTUP_PROTECTION_MS = Math.max(
  0,
  Number(
    process.env.COCALC_PROJECT_HOST_PRESSURE_STARTUP_PROTECTION_MS ??
      10 * 60_000,
  ),
);
const PRESSURE_PROJECT_COOLDOWN_MS = Math.max(
  0,
  Number(
    process.env.COCALC_PROJECT_HOST_PRESSURE_PROJECT_COOLDOWN_MS ?? 15 * 60_000,
  ),
);
const PRESSURE_SETTLE_MS = Math.max(
  0,
  Number(process.env.COCALC_PROJECT_HOST_PRESSURE_SETTLE_MS ?? 45_000),
);
const EMERGENCY_SETTLE_MS = Math.max(
  0,
  Number(process.env.COCALC_PROJECT_HOST_EMERGENCY_SETTLE_MS ?? 15_000),
);
const EMERGENCY_MAX_STOPS_PER_CYCLE = Math.max(
  1,
  Math.min(
    5,
    Number(
      process.env.COCALC_PROJECT_HOST_EMERGENCY_MAX_STOPS_PER_CYCLE ?? 2,
    ) || 2,
  ),
);
const RECENT_PRESSURE_STOP_WINDOW_MS = 60 * 60_000;

type StopActionStatus = NonNullable<HostPressureState["last_action_status"]>;

type StopCandidate = {
  project_id: string;
  state: string;
  shared_compute_priority: number;
  override_rank: number;
  startup_protected: boolean;
  protect_override: boolean;
  policy_missing: boolean;
  cooldown_active: boolean;
  authoritative_last_edited_ms: number;
  last_started_ms: number;
  projected_memory_limit_mb: number;
  explanation: string[];
};

export interface HostPressureControllerHandle {
  stop: () => void;
  getCurrentState: () => HostPressureState | undefined;
}

function clampPercent(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, parsed));
}

function clampNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function parseNonNegativeNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function parseRunQuota(run_quota: unknown): Record<string, any> | undefined {
  if (run_quota == null) return undefined;
  if (typeof run_quota === "string") {
    try {
      const parsed = JSON.parse(run_quota);
      return typeof parsed === "object" && parsed != null ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (typeof run_quota === "object") {
    return run_quota as Record<string, any>;
  }
}

function candidateExplanation(candidate: StopCandidate): string {
  return candidate.explanation.join(",");
}

export function classifyHostPressure(
  metrics: HostCurrentMetrics | undefined,
  now: number = Date.now(),
): HostPressureState | undefined {
  if (!metrics) return undefined;
  const usedPercent = parseNonNegativeNumber(metrics.memory_used_percent);
  const availableBytes = parseNonNegativeNumber(metrics.memory_available_bytes);
  const emergencyReasons: string[] = [];
  const pressureReasons: string[] = [];
  const observeReasons: string[] = [];
  if (usedPercent != null && usedPercent >= EMERGENCY_MEMORY_USED_PERCENT) {
    emergencyReasons.push(
      `memory_used_percent>=${EMERGENCY_MEMORY_USED_PERCENT}`,
    );
  }
  if (
    availableBytes != null &&
    availableBytes <= EMERGENCY_MEMORY_AVAILABLE_BYTES
  ) {
    emergencyReasons.push(
      `memory_available_bytes<=${EMERGENCY_MEMORY_AVAILABLE_BYTES}`,
    );
  }
  if (usedPercent != null && usedPercent >= PRESSURE_MEMORY_USED_PERCENT) {
    pressureReasons.push(
      `memory_used_percent>=${PRESSURE_MEMORY_USED_PERCENT}`,
    );
  }
  if (
    availableBytes != null &&
    availableBytes <= PRESSURE_MEMORY_AVAILABLE_BYTES
  ) {
    pressureReasons.push(
      `memory_available_bytes<=${PRESSURE_MEMORY_AVAILABLE_BYTES}`,
    );
  }
  if (usedPercent != null && usedPercent >= OBSERVE_MEMORY_USED_PERCENT) {
    observeReasons.push(`memory_used_percent>=${OBSERVE_MEMORY_USED_PERCENT}`);
  }
  if (
    availableBytes != null &&
    availableBytes <= OBSERVE_MEMORY_AVAILABLE_BYTES
  ) {
    observeReasons.push(
      `memory_available_bytes<=${OBSERVE_MEMORY_AVAILABLE_BYTES}`,
    );
  }
  if (emergencyReasons.length > 0) {
    return {
      zone: "emergency",
      reason: emergencyReasons.join(","),
      evaluated_at_ms: now,
    };
  }
  if (pressureReasons.length > 0) {
    return {
      zone: "pressure",
      reason: pressureReasons.join(","),
      evaluated_at_ms: now,
    };
  }
  if (observeReasons.length > 0) {
    return {
      zone: "observe",
      reason: observeReasons.join(","),
      evaluated_at_ms: now,
    };
  }
  return {
    zone: "normal",
    reason:
      usedPercent != null || availableBytes != null ? "memory_ok" : undefined,
    evaluated_at_ms: now,
  };
}

export function buildStopCandidates({
  projects,
  policies,
  getStopState,
  zone,
  now,
}: {
  projects: ProjectRow[];
  policies: Map<string, ProjectStopPolicyRow>;
  getStopState: (project_id: string) => ReturnType<typeof getProjectStopState>;
  zone: HostPressureZone;
  now: number;
}): StopCandidate[] {
  const candidates: StopCandidate[] = [];
  for (const row of projects) {
    const state = `${row.state ?? ""}`.trim();
    const canConsiderStarting = zone === "emergency" && state === "starting";
    if (state !== "running" && !canConsiderStarting) {
      continue;
    }
    const project_id = `${row.project_id ?? ""}`.trim();
    if (!project_id) continue;
    const policy = policies.get(project_id);
    const stopState = getStopState(project_id);
    const startupProtected =
      STARTUP_PROTECTION_MS > 0 &&
      stopState?.last_started_ms != null &&
      now - stopState.last_started_ms < STARTUP_PROTECTION_MS;
    if (startupProtected && zone !== "emergency") {
      continue;
    }
    const protectOverride = policy?.stop_override === "protect";
    if (protectOverride && zone !== "emergency") {
      continue;
    }
    const cooldownActive =
      stopState?.pressure_cooldown_until_ms != null &&
      stopState.pressure_cooldown_until_ms > now;
    if (cooldownActive && zone !== "emergency") {
      continue;
    }
    const runQuota = parseRunQuota(row.run_quota);
    const projectedMemoryLimitMb = Math.max(
      0,
      Math.floor(Number(runQuota?.memory_limit ?? 0) || 0),
    );
    const explanation: string[] = [];
    if (!policy) {
      explanation.push("policy_missing");
    }
    if (protectOverride) {
      explanation.push("override:protect");
    } else if (policy?.stop_override === "deprioritize") {
      explanation.push("override:deprioritize");
    }
    if (startupProtected) {
      explanation.push("startup_protected");
    }
    if (cooldownActive) {
      explanation.push("cooldown_active");
    }
    explanation.push(
      `priority:${Math.max(0, policy?.shared_compute_priority ?? 0)}`,
    );
    explanation.push(`state:${state}`);
    candidates.push({
      project_id,
      state,
      shared_compute_priority: Math.max(
        0,
        policy?.shared_compute_priority ?? 0,
      ),
      override_rank:
        policy?.stop_override === "deprioritize" ? 0 : protectOverride ? 2 : 1,
      startup_protected: startupProtected,
      protect_override: protectOverride,
      policy_missing: !policy,
      cooldown_active: cooldownActive,
      authoritative_last_edited_ms: Math.max(
        0,
        policy?.authoritative_last_edited_ms ?? 0,
      ),
      last_started_ms: Math.max(0, stopState?.last_started_ms ?? 0),
      projected_memory_limit_mb: projectedMemoryLimitMb,
      explanation,
    });
  }
  candidates.sort((left, right) => {
    if (left.override_rank !== right.override_rank) {
      return left.override_rank - right.override_rank;
    }
    if (left.shared_compute_priority !== right.shared_compute_priority) {
      return left.shared_compute_priority - right.shared_compute_priority;
    }
    if (left.startup_protected !== right.startup_protected) {
      return Number(left.startup_protected) - Number(right.startup_protected);
    }
    if (
      left.authoritative_last_edited_ms !== right.authoritative_last_edited_ms
    ) {
      return (
        left.authoritative_last_edited_ms - right.authoritative_last_edited_ms
      );
    }
    if (left.last_started_ms !== right.last_started_ms) {
      return left.last_started_ms - right.last_started_ms;
    }
    if (left.projected_memory_limit_mb !== right.projected_memory_limit_mb) {
      return right.projected_memory_limit_mb - left.projected_memory_limit_mb;
    }
    return left.project_id.localeCompare(right.project_id);
  });
  return candidates;
}

export function startHostPressureController({
  refreshMetrics,
  getCurrentMetrics,
  stopProject,
  reportPressureAction,
}: {
  refreshMetrics: () => Promise<HostCurrentMetrics | undefined>;
  getCurrentMetrics: () => HostCurrentMetrics | undefined;
  stopProject: (opts: {
    project_id: string;
    force?: boolean;
    pressure_zone: HostPressureZone;
    reason: string;
  }) => Promise<void>;
  reportPressureAction?: (opts: {
    project_id: string;
    action_status: "stopped" | "stop_failed";
    pressure_zone: HostPressureZone;
    reason: string;
    trigger: string;
    candidate_count: number;
    memory_used_percent?: number | null;
    memory_available_bytes?: number | null;
    occurred_at_ms: number;
  }) => Promise<void>;
}): HostPressureControllerHandle {
  let currentState: HostPressureState | undefined;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let pressureSinceMs: number | undefined;
  let settleUntilMs = 0;
  let lastActionAtMs: number | undefined;
  let lastActionProjectId: string | undefined;
  let lastActionStatus: StopActionStatus | undefined;
  let lastActionReason: string | undefined;
  const recentPressureStopsMs: number[] = [];

  const trimRecentStops = (now: number) => {
    while (
      recentPressureStopsMs.length > 0 &&
      recentPressureStopsMs[0] <= now - RECENT_PRESSURE_STOP_WINDOW_MS
    ) {
      recentPressureStopsMs.shift();
    }
  };

  const publishState = ({
    zone,
    reason,
    evaluated_at_ms,
    candidate_count,
  }: {
    zone: HostPressureZone;
    reason?: string;
    evaluated_at_ms: number;
    candidate_count?: number;
  }) => {
    trimRecentStops(evaluated_at_ms);
    currentState = {
      zone,
      ...(reason ? { reason } : {}),
      ...(pressureSinceMs != null ? { since_ms: pressureSinceMs } : {}),
      evaluated_at_ms,
      ...(candidate_count != null ? { candidate_count } : {}),
      ...(settleUntilMs > evaluated_at_ms
        ? { settle_until_ms: settleUntilMs }
        : {}),
      recent_pressure_stop_count: recentPressureStopsMs.length,
      ...(lastActionAtMs != null ? { last_action_at_ms: lastActionAtMs } : {}),
      ...(lastActionProjectId
        ? { last_action_project_id: lastActionProjectId }
        : {}),
      ...(lastActionStatus ? { last_action_status: lastActionStatus } : {}),
      ...(lastActionReason ? { last_action_reason: lastActionReason } : {}),
    };
  };

  const runOnce = async (trigger: string): Promise<void> => {
    const now = Date.now();
    const metrics = (await refreshMetrics()) ?? getCurrentMetrics();
    const classified = classifyHostPressure(metrics, now);
    if (!classified) {
      currentState = undefined;
      return;
    }
    if (classified.zone === "normal") {
      pressureSinceMs = undefined;
      settleUntilMs = 0;
      publishState({
        zone: classified.zone,
        reason: classified.reason,
        evaluated_at_ms: now,
        candidate_count: 0,
      });
      return;
    }
    if (pressureSinceMs == null) {
      pressureSinceMs = now;
    }
    const projects = listProjects();
    const policies = new Map(
      listProjectStopPolicies().map((row) => [row.project_id, row]),
    );
    const candidates = buildStopCandidates({
      projects,
      policies,
      getStopState: (project_id) => getProjectStopState(project_id),
      zone: classified.zone,
      now,
    });
    for (const candidate of candidates) {
      upsertProjectStopState({
        project_id: candidate.project_id,
        last_ranked_ms: now,
      });
    }
    if (classified.zone === "observe") {
      publishState({
        zone: classified.zone,
        reason: classified.reason,
        evaluated_at_ms: now,
        candidate_count: candidates.length,
      });
      return;
    }
    if (settleUntilMs > now) {
      lastActionStatus = "cooldown";
      lastActionReason = `settling_after_${trigger}`;
      publishState({
        zone: classified.zone,
        reason: classified.reason,
        evaluated_at_ms: now,
        candidate_count: candidates.length,
      });
      return;
    }
    if (candidates.length === 0) {
      lastActionAtMs = now;
      lastActionProjectId = undefined;
      lastActionStatus = "no_candidates";
      lastActionReason = classified.reason ?? "no_candidates";
      publishState({
        zone: classified.zone,
        reason: classified.reason,
        evaluated_at_ms: now,
        candidate_count: 0,
      });
      logger.warn("host pressure has no stop candidates", {
        zone: classified.zone,
        reason: classified.reason,
      });
      return;
    }
    const maxStops =
      classified.zone === "emergency" ? EMERGENCY_MAX_STOPS_PER_CYCLE : 1;
    let stoppedCount = 0;
    for (const candidate of candidates) {
      const reason = candidateExplanation(candidate);
      upsertProjectStopState({
        project_id: candidate.project_id,
        last_decision_reason: reason,
        last_decision_pressure_zone: classified.zone,
        last_ranked_ms: now,
      });
      try {
        await stopProject({
          project_id: candidate.project_id,
          force: true,
          pressure_zone: classified.zone,
          reason,
        });
        upsertProjectStopState({
          project_id: candidate.project_id,
          last_pressure_stop_ms: now,
          pressure_cooldown_until_ms: now + PRESSURE_PROJECT_COOLDOWN_MS,
          last_decision_reason: reason,
          last_decision_pressure_zone: classified.zone,
          last_ranked_ms: now,
        });
        recentPressureStopsMs.push(now);
        stoppedCount += 1;
        lastActionAtMs = now;
        lastActionProjectId = candidate.project_id;
        lastActionStatus = "stopped";
        lastActionReason = reason;
        logger.warn("host pressure stopped project", {
          project_id: candidate.project_id,
          zone: classified.zone,
          trigger,
          reason,
          memory_used_percent: metrics?.memory_used_percent,
          memory_available_bytes: metrics?.memory_available_bytes,
        });
        if (reportPressureAction) {
          try {
            await reportPressureAction({
              project_id: candidate.project_id,
              action_status: "stopped",
              pressure_zone: classified.zone,
              reason,
              trigger,
              candidate_count: candidates.length,
              memory_used_percent:
                metrics?.memory_used_percent != null
                  ? Number(metrics.memory_used_percent)
                  : null,
              memory_available_bytes:
                metrics?.memory_available_bytes != null
                  ? Number(metrics.memory_available_bytes)
                  : null,
              occurred_at_ms: now,
            });
          } catch (err) {
            logger.warn("host pressure action reporting failed", {
              project_id: candidate.project_id,
              zone: classified.zone,
              trigger,
              reason,
              action_status: "stopped",
              err: `${err}`,
            });
          }
        }
        if (stoppedCount >= maxStops) {
          break;
        }
      } catch (err) {
        lastActionAtMs = now;
        lastActionProjectId = candidate.project_id;
        lastActionStatus = "stop_failed";
        lastActionReason = reason;
        upsertProjectStopState({
          project_id: candidate.project_id,
          last_decision_reason: `stop_failed:${reason}`,
          last_decision_pressure_zone: classified.zone,
          last_ranked_ms: now,
        });
        logger.warn("host pressure stop failed", {
          project_id: candidate.project_id,
          zone: classified.zone,
          trigger,
          reason,
          err: `${err}`,
        });
        if (reportPressureAction) {
          try {
            await reportPressureAction({
              project_id: candidate.project_id,
              action_status: "stop_failed",
              pressure_zone: classified.zone,
              reason,
              trigger,
              candidate_count: candidates.length,
              memory_used_percent:
                metrics?.memory_used_percent != null
                  ? Number(metrics.memory_used_percent)
                  : null,
              memory_available_bytes:
                metrics?.memory_available_bytes != null
                  ? Number(metrics.memory_available_bytes)
                  : null,
              occurred_at_ms: now,
            });
          } catch (reportErr) {
            logger.warn("host pressure action reporting failed", {
              project_id: candidate.project_id,
              zone: classified.zone,
              trigger,
              reason,
              action_status: "stop_failed",
              err: `${reportErr}`,
            });
          }
        }
      }
    }
    settleUntilMs =
      now +
      (classified.zone === "emergency"
        ? EMERGENCY_SETTLE_MS
        : PRESSURE_SETTLE_MS);
    publishState({
      zone: classified.zone,
      reason: classified.reason,
      evaluated_at_ms: now,
      candidate_count: candidates.length,
    });
  };

  const tick = async (trigger: string) => {
    if (running) return;
    running = true;
    try {
      await runOnce(trigger);
    } catch (err) {
      logger.warn("host pressure evaluation failed", {
        trigger,
        err: `${err}`,
      });
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => {
    void tick("interval");
  }, CONTROLLER_INTERVAL_MS);
  timer.unref?.();
  void tick("startup");

  return {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    getCurrentState: () => currentState,
  };
}

export const _test = {
  classifyHostPressure,
  buildStopCandidates,
};
