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
    spot_probe_interval_minutes: 10,
    spot_return_requires_probe: true,
    max_restore_attempts_before_fallback: 0,
    max_standard_runtime_minutes: 24 * 60,
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
  return {
    spot_restore_retry_window_minutes: retryWindow,
    spot_restore_backoff_seconds: backoffSeconds,
    standard_fallback_enabled: standardFallbackEnabled,
    standard_fallback_min_minutes: standardFallbackMinMinutes,
    spot_probe_interval_minutes: spotProbeIntervalMinutes,
    spot_return_requires_probe: spotReturnRequiresProbe,
    max_restore_attempts_before_fallback: maxAttempts,
    max_standard_runtime_minutes: maxStandardRuntimeMinutes,
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
  return {
    phase,
    ...(normalizeIsoTimestamp((value as any).outage_started_at)
      ? {
          outage_started_at: normalizeIsoTimestamp(
            (value as any).outage_started_at,
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

export function spotProbeIntervalMs(policy?: HostSpotRecoveryPolicy): number {
  const normalized = normalizeSpotRecoveryPolicy(policy) ?? {
    ...DEFAULT_SPOT_RECOVERY_POLICY,
  };
  return normalized.spot_probe_interval_minutes * 60 * 1000;
}
