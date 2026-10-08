/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  HostInterruptionRestorePolicy,
  HostPricingModel,
  HostSpotRecoveryPhase,
  HostSpotRecoveryPolicy,
  HostSpotRecoveryState,
} from "@cocalc/conat/hub/api/hosts";

export type SpotRestoreHostLike = {
  id?: string;
  status?: string;
  metadata?: Record<string, any>;
};

const INTENTIONAL_PENDING_ACTIONS = new Set([
  "stop",
  "restart",
  "hard_restart",
  "delete",
  "deprovision",
  "force_deprovision",
  "remove_connector",
  "upgrade_software",
  "reconcile_software",
]);

const INTENTIONAL_SUCCESS_ACTIONS = new Set([
  "stop",
  "delete",
  "deprovision",
  "force_deprovision",
  "remove_connector",
]);

const MAX_BACKOFF_SECONDS = 300;

export const DEFAULT_SPOT_RECOVERY_POLICY: Required<HostSpotRecoveryPolicy> =
  Object.freeze({
    spot_restore_retry_window_minutes: 10,
    spot_restore_backoff_seconds: 15,
    standard_fallback_enabled: true,
    standard_fallback_min_minutes: 20,
    // A second provider-confirmed preemption within this window opens a
    // circuit breaker instead of immediately cycling back to Spot again.
    rapid_preemption_window_minutes: 4 * 60,
    rapid_preemption_standard_hold_minutes: 24 * 60,
    spot_probe_interval_minutes: 10,
    spot_return_requires_probe: true,
    // Give each Spot machine type one restore attempt before advancing: the
    // attempt counter is incremented before the check, so 2 means one try.
    // This avoids spending the full retry window on capacity that is being
    // preempted immediately after boot. Values <= 0 also mean this default.
    max_restore_attempts_before_fallback: 2,
    max_standard_runtime_minutes: 24 * 60,
    alternate_spot_machine_types: [],
  });

export function normalizeHostPricingModelValue(
  value: unknown,
): HostPricingModel | undefined {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (normalized === "spot") return "spot";
  if (normalized === "on_demand" || normalized === "on-demand") {
    return "on_demand";
  }
  return undefined;
}

export function defaultInterruptionRestorePolicy(
  pricingModel?: HostPricingModel,
): HostInterruptionRestorePolicy {
  return pricingModel === "spot" ? "immediate" : "none";
}

export function normalizeInterruptionRestorePolicyValue(
  value: unknown,
): HostInterruptionRestorePolicy | undefined {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (normalized === "immediate") return "immediate";
  if (normalized === "none") return "none";
  return undefined;
}

export function desiredPricingModel(
  row: SpotRestoreHostLike,
): HostPricingModel {
  return (
    normalizeHostPricingModelValue(
      row.metadata?.desired_pricing_model ?? row.metadata?.pricing_model,
    ) ?? "on_demand"
  );
}

export function effectivePricingModel(
  row: SpotRestoreHostLike,
): HostPricingModel {
  return (
    normalizeHostPricingModelValue(row.metadata?.effective_pricing_model) ??
    desiredPricingModel(row)
  );
}

export function interruptionRestorePolicy(
  row: SpotRestoreHostLike,
): HostInterruptionRestorePolicy {
  const explicit = normalizeInterruptionRestorePolicyValue(
    row.metadata?.interruption_restore_policy,
  );
  if (explicit) return explicit;
  return defaultInterruptionRestorePolicy(desiredPricingModel(row));
}

export function normalizeSpotRecoveryPhase(
  value: unknown,
): HostSpotRecoveryPhase | undefined {
  switch (`${value ?? ""}`.trim()) {
    case "idle":
    case "retrying_spot":
    case "running_standard_fallback":
    case "probing_spot":
    case "returning_to_spot":
      return `${value}`.trim() as HostSpotRecoveryPhase;
    default:
      return undefined;
  }
}

function parsePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  const text = `${value ?? ""}`.trim();
  if (!text) return undefined;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set<string>(
      value
        .map((item: unknown) => `${item ?? ""}`.trim())
        .filter((item: string) => !!item),
    ),
  );
}

export function normalizeSpotRecoveryPolicy(
  value: unknown,
): Required<HostSpotRecoveryPolicy> | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const retryWindow =
    parsePositiveInt((value as any).spot_restore_retry_window_minutes) ??
    DEFAULT_SPOT_RECOVERY_POLICY.spot_restore_retry_window_minutes;
  const backoffSeconds =
    parsePositiveInt((value as any).spot_restore_backoff_seconds) ??
    DEFAULT_SPOT_RECOVERY_POLICY.spot_restore_backoff_seconds;
  const standardFallbackEnabled =
    typeof (value as any).standard_fallback_enabled === "boolean"
      ? (value as any).standard_fallback_enabled
      : DEFAULT_SPOT_RECOVERY_POLICY.standard_fallback_enabled;
  const standardFallbackMinMinutes =
    parsePositiveInt((value as any).standard_fallback_min_minutes) ??
    DEFAULT_SPOT_RECOVERY_POLICY.standard_fallback_min_minutes;
  const rapidPreemptionWindowMinutes =
    parsePositiveInt((value as any).rapid_preemption_window_minutes) ??
    DEFAULT_SPOT_RECOVERY_POLICY.rapid_preemption_window_minutes;
  const rapidPreemptionStandardHoldMinutes =
    parsePositiveInt((value as any).rapid_preemption_standard_hold_minutes) ??
    DEFAULT_SPOT_RECOVERY_POLICY.rapid_preemption_standard_hold_minutes;
  const spotProbeIntervalMinutes =
    parsePositiveInt((value as any).spot_probe_interval_minutes) ??
    DEFAULT_SPOT_RECOVERY_POLICY.spot_probe_interval_minutes;
  const spotReturnRequiresProbe =
    typeof (value as any).spot_return_requires_probe === "boolean"
      ? (value as any).spot_return_requires_probe
      : DEFAULT_SPOT_RECOVERY_POLICY.spot_return_requires_probe;
  const maxAttempts =
    parsePositiveInt((value as any).max_restore_attempts_before_fallback) ??
    DEFAULT_SPOT_RECOVERY_POLICY.max_restore_attempts_before_fallback;
  const maxStandardRuntimeMinutes =
    parsePositiveInt((value as any).max_standard_runtime_minutes) ??
    DEFAULT_SPOT_RECOVERY_POLICY.max_standard_runtime_minutes;
  const alternateSpotMachineTypes = Array.isArray(
    (value as any).alternate_spot_machine_types,
  )
    ? normalizeStringArray((value as any).alternate_spot_machine_types)
    : DEFAULT_SPOT_RECOVERY_POLICY.alternate_spot_machine_types;
  return {
    spot_restore_retry_window_minutes: retryWindow,
    spot_restore_backoff_seconds: backoffSeconds,
    standard_fallback_enabled: standardFallbackEnabled,
    standard_fallback_min_minutes: standardFallbackMinMinutes,
    rapid_preemption_window_minutes: rapidPreemptionWindowMinutes,
    rapid_preemption_standard_hold_minutes: rapidPreemptionStandardHoldMinutes,
    spot_probe_interval_minutes: spotProbeIntervalMinutes,
    spot_return_requires_probe: spotReturnRequiresProbe,
    max_restore_attempts_before_fallback: maxAttempts,
    max_standard_runtime_minutes: maxStandardRuntimeMinutes,
    alternate_spot_machine_types: alternateSpotMachineTypes,
  };
}

export function spotRecoveryPolicy(
  row: SpotRestoreHostLike,
): Required<HostSpotRecoveryPolicy> | undefined {
  const normalized = normalizeSpotRecoveryPolicy(
    row.metadata?.spot_recovery_policy,
  );
  if (normalized) return normalized;
  if (desiredPricingModel(row) !== "spot") return undefined;
  if (interruptionRestorePolicy(row) !== "immediate") return undefined;
  return { ...DEFAULT_SPOT_RECOVERY_POLICY };
}

export function normalizeSpotRecoveryState(
  value: unknown,
): HostSpotRecoveryState | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const phase =
    normalizeSpotRecoveryPhase((value as any).phase) ??
    ("idle" as HostSpotRecoveryPhase);
  const attempt = parsePositiveInt((value as any).attempt);
  const lastProbeResult =
    `${(value as any).last_probe_result ?? ""}`.trim() === "success"
      ? "success"
      : `${(value as any).last_probe_result ?? ""}`.trim() === "failure"
        ? "failure"
        : undefined;
  const lastProbeError = `${(value as any).last_probe_error ?? ""}`.trim();
  const activeMachineType =
    `${(value as any).active_machine_type ?? ""}`.trim();
  const triedMachineTypes = normalizeStringArray(
    (value as any).spot_machine_types_tried,
  );
  const triedRungs = normalizeStringArray((value as any).fallback_rungs_tried);
  const ladderCycle = parsePositiveInt((value as any).fallback_ladder_cycle);
  const transientRetries = parsePositiveInt((value as any).transient_retries);
  const transientRung = `${(value as any).transient_rung ?? ""}`.trim();
  return {
    phase,
    ...(normalizeIsoTimestamp((value as any).outage_started_at)
      ? {
          outage_started_at: normalizeIsoTimestamp(
            (value as any).outage_started_at,
          ),
        }
      : {}),
    ...(normalizeIsoTimestamp((value as any).last_recovered_at)
      ? {
          last_recovered_at: normalizeIsoTimestamp(
            (value as any).last_recovered_at,
          ),
        }
      : {}),
    ...(attempt != null ? { attempt } : {}),
    ...(normalizeIsoTimestamp((value as any).next_retry_at)
      ? { next_retry_at: normalizeIsoTimestamp((value as any).next_retry_at) }
      : {}),
    ...(normalizeIsoTimestamp((value as any).fallback_started_at)
      ? {
          fallback_started_at: normalizeIsoTimestamp(
            (value as any).fallback_started_at,
          ),
        }
      : {}),
    ...(normalizeIsoTimestamp((value as any).last_preempted_at)
      ? {
          last_preempted_at: normalizeIsoTimestamp(
            (value as any).last_preempted_at,
          ),
        }
      : {}),
    ...(normalizeIsoTimestamp((value as any).standard_hold_until)
      ? {
          standard_hold_until: normalizeIsoTimestamp(
            (value as any).standard_hold_until,
          ),
        }
      : {}),
    ...(normalizeIsoTimestamp((value as any).last_probe_at)
      ? { last_probe_at: normalizeIsoTimestamp((value as any).last_probe_at) }
      : {}),
    ...(lastProbeResult ? { last_probe_result: lastProbeResult } : {}),
    ...(lastProbeError ? { last_probe_error: lastProbeError } : {}),
    ...(normalizeIsoTimestamp((value as any).verification_started_at)
      ? {
          verification_started_at: normalizeIsoTimestamp(
            (value as any).verification_started_at,
          ),
        }
      : {}),
    ...(normalizeIsoTimestamp((value as any).verification_deadline_at)
      ? {
          verification_deadline_at: normalizeIsoTimestamp(
            (value as any).verification_deadline_at,
          ),
        }
      : {}),
    ...(activeMachineType ? { active_machine_type: activeMachineType } : {}),
    ...(normalizeIsoTimestamp((value as any).machine_type_attempt_started_at)
      ? {
          machine_type_attempt_started_at: normalizeIsoTimestamp(
            (value as any).machine_type_attempt_started_at,
          ),
        }
      : {}),
    ...(triedMachineTypes.length
      ? { spot_machine_types_tried: triedMachineTypes }
      : {}),
    ...(triedRungs.length ? { fallback_rungs_tried: triedRungs } : {}),
    ...(ladderCycle != null ? { fallback_ladder_cycle: ladderCycle } : {}),
    ...(transientRetries != null
      ? { transient_retries: transientRetries }
      : {}),
    ...(transientRung ? { transient_rung: transientRung } : {}),
  };
}

export function spotRecoveryState(
  row: SpotRestoreHostLike,
): HostSpotRecoveryState | undefined {
  const normalized = normalizeSpotRecoveryState(
    row.metadata?.spot_recovery_state,
  );
  if (normalized) return normalized;
  if (desiredPricingModel(row) !== "spot") return undefined;
  if (interruptionRestorePolicy(row) !== "immediate") return undefined;
  return { phase: "idle" };
}

export function desiredHostState(
  row: SpotRestoreHostLike,
): "running" | "stopped" {
  const explicit = `${row.metadata?.desired_state ?? ""}`.trim().toLowerCase();
  if (explicit === "running" || explicit === "stopped") {
    return explicit;
  }
  const status = `${row.status ?? ""}`.trim().toLowerCase();
  return ["running", "active", "starting", "restarting"].includes(status)
    ? "running"
    : "stopped";
}

export function isSpotRecoveryManagedHost(row: SpotRestoreHostLike): boolean {
  return (
    desiredPricingModel(row) === "spot" &&
    interruptionRestorePolicy(row) === "immediate"
  );
}

export function shouldAutoRestoreInterruptedSpotHost(
  row: SpotRestoreHostLike,
): boolean {
  if (!isSpotRecoveryManagedHost(row)) return false;
  if (`${row.status ?? ""}`.trim().toLowerCase() === "deprovisioned") {
    return false;
  }
  if (desiredHostState(row) !== "running") return false;
  const lastAction = `${row.metadata?.last_action ?? ""}`.trim().toLowerCase();
  const lastActionStatus = `${row.metadata?.last_action_status ?? ""}`
    .trim()
    .toLowerCase();
  if (
    lastActionStatus === "pending" &&
    INTENTIONAL_PENDING_ACTIONS.has(lastAction)
  ) {
    return false;
  }
  if (
    lastActionStatus === "success" &&
    INTENTIONAL_SUCCESS_ACTIONS.has(lastAction)
  ) {
    return false;
  }
  return true;
}

export function computeSpotRetryDelayMs(opts: {
  attempt: number;
  policy?: HostSpotRecoveryPolicy;
}): number {
  const policy = normalizeSpotRecoveryPolicy(opts.policy) ?? {
    ...DEFAULT_SPOT_RECOVERY_POLICY,
  };
  const attempt = Math.max(1, Math.floor(opts.attempt));
  const backoffSeconds = Math.min(
    MAX_BACKOFF_SECONDS,
    policy.spot_restore_backoff_seconds * 2 ** (attempt - 1),
  );
  return backoffSeconds * 1000;
}

export function spotRetryWindowMs(policy?: HostSpotRecoveryPolicy): number {
  const normalized = normalizeSpotRecoveryPolicy(policy) ?? {
    ...DEFAULT_SPOT_RECOVERY_POLICY,
  };
  return normalized.spot_restore_retry_window_minutes * 60 * 1000;
}

export function standardFallbackMinMs(policy?: HostSpotRecoveryPolicy): number {
  const normalized = normalizeSpotRecoveryPolicy(policy) ?? {
    ...DEFAULT_SPOT_RECOVERY_POLICY,
  };
  return normalized.standard_fallback_min_minutes * 60 * 1000;
}

export function rapidPreemptionWindowMs(
  policy?: HostSpotRecoveryPolicy,
): number {
  const normalized = normalizeSpotRecoveryPolicy(policy) ?? {
    ...DEFAULT_SPOT_RECOVERY_POLICY,
  };
  return normalized.rapid_preemption_window_minutes * 60 * 1000;
}

export function rapidPreemptionStandardHoldMs(
  policy?: HostSpotRecoveryPolicy,
): number {
  const normalized = normalizeSpotRecoveryPolicy(policy) ?? {
    ...DEFAULT_SPOT_RECOVERY_POLICY,
  };
  return normalized.rapid_preemption_standard_hold_minutes * 60 * 1000;
}

export function spotStandardHoldUntilMs(
  state?: HostSpotRecoveryState,
): number | undefined {
  if (!state?.standard_hold_until) return undefined;
  const value = new Date(state.standard_hold_until).getTime();
  return Number.isFinite(value) ? value : undefined;
}

export function spotStandardHoldIsActive(
  state?: HostSpotRecoveryState,
  now = new Date(),
): boolean {
  const holdUntil = spotStandardHoldUntilMs(state);
  return holdUntil != null && holdUntil > now.getTime();
}

export function recordProviderSpotPreemption(opts: {
  state?: HostSpotRecoveryState;
  policy?: HostSpotRecoveryPolicy;
  now?: Date;
}): {
  state: HostSpotRecoveryState;
  recorded: boolean;
  circuit_breaker_triggered: boolean;
} {
  const now = opts.now ?? new Date();
  const previous = normalizeSpotRecoveryState(opts.state) ?? { phase: "idle" };
  if (previous.phase !== "idle") {
    return {
      state: previous,
      recorded: false,
      circuit_breaker_triggered: false,
    };
  }
  const lastPreemptedAt = previous.last_preempted_at
    ? new Date(previous.last_preempted_at).getTime()
    : undefined;
  const rapid =
    lastPreemptedAt != null &&
    Number.isFinite(lastPreemptedAt) &&
    now.getTime() >= lastPreemptedAt &&
    now.getTime() - lastPreemptedAt <= rapidPreemptionWindowMs(opts.policy);
  const existingHoldUntil = spotStandardHoldUntilMs(previous);
  const nextHoldUntil = rapid
    ? Math.max(
        existingHoldUntil ?? 0,
        now.getTime() + rapidPreemptionStandardHoldMs(opts.policy),
      )
    : existingHoldUntil;
  // A new outage starts its own retry budget. Counters kept from an earlier
  // recovery made every later preemption skip Spot as "retry-window-exhausted".
  // Repeated preemptions are handled by the circuit breaker above instead.
  const {
    attempt: _attempt,
    next_retry_at: _nextRetryAt,
    fallback_started_at: _fallbackStartedAt,
    machine_type_attempt_started_at: _machineTypeAttemptStartedAt,
    spot_machine_types_tried: _spotMachineTypesTried,
    outage_started_at: _outageStartedAt,
    last_recovered_at: _lastRecoveredAt,
    verification_started_at: _verificationStartedAt,
    verification_deadline_at: _verificationDeadlineAt,
    fallback_rungs_tried: _fallbackRungsTried,
    fallback_ladder_cycle: _fallbackLadderCycle,
    transient_retries: _transientRetries,
    transient_rung: _transientRung,
    ...persistent
  } = previous;
  return {
    state: {
      ...persistent,
      last_preempted_at: now.toISOString(),
      ...(nextHoldUntil != null
        ? { standard_hold_until: new Date(nextHoldUntil).toISOString() }
        : {}),
    },
    recorded: true,
    circuit_breaker_triggered: rapid,
  };
}

export function standardFallbackProbeNotBeforeMs(opts: {
  state?: HostSpotRecoveryState;
  policy?: HostSpotRecoveryPolicy;
  now?: Date;
}): number {
  const nowMs = (opts.now ?? new Date()).getTime();
  const fallbackStartedAt = opts.state?.fallback_started_at
    ? new Date(opts.state.fallback_started_at).getTime()
    : nowMs;
  const minimumProbeAt =
    (Number.isFinite(fallbackStartedAt) ? fallbackStartedAt : nowMs) +
    standardFallbackMinMs(opts.policy);
  return Math.max(
    nowMs,
    minimumProbeAt,
    spotStandardHoldUntilMs(opts.state) ?? 0,
  );
}

export function maxStandardRuntimeMs(policy?: HostSpotRecoveryPolicy): number {
  const normalized = normalizeSpotRecoveryPolicy(policy) ?? {
    ...DEFAULT_SPOT_RECOVERY_POLICY,
  };
  return normalized.max_standard_runtime_minutes * 60 * 1000;
}

export function spotProbeIntervalMs(policy?: HostSpotRecoveryPolicy): number {
  const normalized = normalizeSpotRecoveryPolicy(policy) ?? {
    ...DEFAULT_SPOT_RECOVERY_POLICY,
  };
  return normalized.spot_probe_interval_minutes * 60 * 1000;
}
