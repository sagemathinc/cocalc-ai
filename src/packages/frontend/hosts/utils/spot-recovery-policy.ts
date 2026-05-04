/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  HostInterruptionRestorePolicy,
  HostPricingModel,
  HostSpotRecoveryPolicy,
} from "@cocalc/conat/hub/api/hosts";

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

export function defaultRestorePolicy(
  pricingModel: HostPricingModel | undefined,
): HostInterruptionRestorePolicy {
  return pricingModel === "spot" ? "immediate" : "none";
}

function parsePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function parseNonNegativeInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

export function normalizeSpotRecoveryPolicy(
  value: unknown,
): Required<HostSpotRecoveryPolicy> | undefined {
  if (value == null || typeof value !== "object") return undefined;
  return {
    spot_restore_retry_window_minutes:
      parsePositiveInt(
        (value as HostSpotRecoveryPolicy).spot_restore_retry_window_minutes,
      ) ?? DEFAULT_SPOT_RECOVERY_POLICY.spot_restore_retry_window_minutes,
    spot_restore_backoff_seconds:
      parsePositiveInt(
        (value as HostSpotRecoveryPolicy).spot_restore_backoff_seconds,
      ) ?? DEFAULT_SPOT_RECOVERY_POLICY.spot_restore_backoff_seconds,
    standard_fallback_enabled:
      typeof (value as HostSpotRecoveryPolicy).standard_fallback_enabled ===
      "boolean"
        ? !!(value as HostSpotRecoveryPolicy).standard_fallback_enabled
        : DEFAULT_SPOT_RECOVERY_POLICY.standard_fallback_enabled,
    standard_fallback_min_minutes:
      parsePositiveInt(
        (value as HostSpotRecoveryPolicy).standard_fallback_min_minutes,
      ) ?? DEFAULT_SPOT_RECOVERY_POLICY.standard_fallback_min_minutes,
    spot_probe_interval_minutes:
      parsePositiveInt(
        (value as HostSpotRecoveryPolicy).spot_probe_interval_minutes,
      ) ?? DEFAULT_SPOT_RECOVERY_POLICY.spot_probe_interval_minutes,
    spot_return_requires_probe:
      typeof (value as HostSpotRecoveryPolicy).spot_return_requires_probe ===
      "boolean"
        ? !!(value as HostSpotRecoveryPolicy).spot_return_requires_probe
        : DEFAULT_SPOT_RECOVERY_POLICY.spot_return_requires_probe,
    max_restore_attempts_before_fallback:
      parseNonNegativeInt(
        (value as HostSpotRecoveryPolicy).max_restore_attempts_before_fallback,
      ) ?? DEFAULT_SPOT_RECOVERY_POLICY.max_restore_attempts_before_fallback,
    max_standard_runtime_minutes:
      parsePositiveInt(
        (value as HostSpotRecoveryPolicy).max_standard_runtime_minutes,
      ) ?? DEFAULT_SPOT_RECOVERY_POLICY.max_standard_runtime_minutes,
  };
}

export function isSpotRecoveryPolicyActive({
  pricingModel,
  interruptionRestorePolicy,
}: {
  pricingModel?: HostPricingModel;
  interruptionRestorePolicy?: HostInterruptionRestorePolicy;
}): boolean {
  return pricingModel === "spot" && interruptionRestorePolicy === "immediate";
}

export function activeSpotRecoveryPolicy({
  pricingModel,
  interruptionRestorePolicy,
  spotRecoveryPolicy,
}: {
  pricingModel?: HostPricingModel;
  interruptionRestorePolicy?: HostInterruptionRestorePolicy;
  spotRecoveryPolicy?: HostSpotRecoveryPolicy;
}): Required<HostSpotRecoveryPolicy> | undefined {
  if (
    !isSpotRecoveryPolicyActive({ pricingModel, interruptionRestorePolicy })
  ) {
    return undefined;
  }
  return (
    normalizeSpotRecoveryPolicy(spotRecoveryPolicy) ?? {
      ...DEFAULT_SPOT_RECOVERY_POLICY,
    }
  );
}

export function equalSpotRecoveryPolicies(
  left: HostSpotRecoveryPolicy | undefined,
  right: HostSpotRecoveryPolicy | undefined,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
