/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AccountLocalDedicatedHostPolicySnapshot } from "@cocalc/conat/inter-bay/api";
import {
  moneyToDbString,
  toDecimal,
  type MoneyValue,
} from "@cocalc/util/money";
import type { DedicatedHostFundingLane } from "./spend";

export const DEDICATED_HOST_BILLING_WARNING_RUNWAY_HOURS = 2;
export const DEDICATED_HOST_BILLING_DRAIN_RUNWAY_HOURS = 1;
export const DEDICATED_HOST_BILLING_DISK_GRACE_HOURS = 72;

export type DedicatedHostBillingEnforcementState =
  | "ok"
  | "at_risk"
  | "draining"
  | "stopped_billing_blocked"
  | "deprovision_pending"
  | "deprovisioned_recoverable";

export type DedicatedHostBillingRecoveryAction =
  | "add_funds"
  | "fix_payment"
  | "support_limit_increase";

export type DedicatedHostBillingEnforcementAction =
  | "none"
  | "mark_at_risk"
  | "request_drain";

export interface DedicatedHostBillingEnforcementMetadata {
  state: DedicatedHostBillingEnforcementState;
  reason_code?: string;
  reason?: string;
  first_detected_at?: string;
  at_risk_at?: string;
  drain_requested_at?: string;
  drain_completed_at?: string;
  final_backup_status?: "unknown" | "running" | "succeeded" | "failed";
  final_backup_completed_at?: string;
  stopped_at?: string;
  grace_until?: string;
  deprovision_after?: string;
  deprovision_requested_at?: string;
  deprovisioned_at?: string;
  recovery_actions?: DedicatedHostBillingRecoveryAction[];
  hourly_cost_usd?: MoneyValue;
  limiting_runway_hours?: number;
  limiting_window?: string;
}

export interface DedicatedHostBillingEnforcementDecision {
  state: DedicatedHostBillingEnforcementState;
  action: DedicatedHostBillingEnforcementAction;
  reason_code?: string;
  reason?: string;
  recovery_actions: DedicatedHostBillingRecoveryAction[];
  limiting_runway_hours?: number;
  limiting_window?: string;
}

function positiveLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return;
  }
  return value;
}

function runwayHours({
  limit,
  used,
  hourly,
}: {
  limit: unknown;
  used: MoneyValue;
  hourly: ReturnType<typeof toDecimal>;
}): number | undefined {
  const normalizedLimit = positiveLimit(limit);
  if (normalizedLimit == null) return;
  if (hourly.lte(0)) return;
  return toDecimal(normalizedLimit)
    .minus(toDecimal(used))
    .div(hourly)
    .toNumber();
}

function pushRunway(
  runways: Array<{ window: string; hours: number }>,
  window: string,
  hours: number | undefined,
): void {
  if (hours == null || !Number.isFinite(hours)) return;
  runways.push({ window, hours });
}

function mostUrgentRunway(
  runways: Array<{ window: string; hours: number }>,
): { window: string; hours: number } | undefined {
  return runways
    .slice()
    .sort((a, b) => a.hours - b.hours || a.window.localeCompare(b.window))[0];
}

function prepaidReason(
  snapshot: AccountLocalDedicatedHostPolicySnapshot,
  limitingWindow?: string,
): { code: string; reason: string } {
  if (toDecimal(snapshot.balance ?? 0).lte(0)) {
    return {
      code: "prepaid_balance_exhausted",
      reason: "prepaid balance is exhausted",
    };
  }
  switch (limitingWindow) {
    case "prepaid_5h":
      return {
        code: "prepaid_usage_window_5h_exhausted",
        reason: "prepaid 5-hour dedicated-host usage window is exhausted",
      };
    case "prepaid_7d":
      return {
        code: "prepaid_usage_window_7d_exhausted",
        reason: "prepaid 7-day dedicated-host usage window is exhausted",
      };
    default:
      return {
        code: "prepaid_runway_low",
        reason: "prepaid dedicated-host runway is too low",
      };
  }
}

function creditReason(
  snapshot: AccountLocalDedicatedHostPolicySnapshot,
  limitingWindow?: string,
): { code: string; reason: string } {
  if (!snapshot.has_payment_method) {
    return {
      code: "payment_method_required",
      reason: "payment method is required for dedicated-host billing",
    };
  }
  if (!snapshot.has_usage_subscription) {
    return {
      code: "automatic_billing_required",
      reason: "automatic billing is required for dedicated-host billing",
    };
  }
  switch (limitingWindow) {
    case "credit_5h":
      return {
        code: "postpaid_usage_window_5h_exhausted",
        reason: "postpaid 5-hour dedicated-host usage window is exhausted",
      };
    case "credit_7d":
      return {
        code: "postpaid_usage_window_7d_exhausted",
        reason: "postpaid 7-day dedicated-host usage window is exhausted",
      };
    case "postpaid_unbilled":
      return {
        code: "postpaid_unbilled_limit_exhausted",
        reason: "postpaid unbilled dedicated-host exposure limit is exhausted",
      };
    default:
      return {
        code: "postpaid_runway_low",
        reason: "postpaid dedicated-host runway is too low",
      };
  }
}

function reasonForLane({
  snapshot,
  funding_lane,
  limitingWindow,
}: {
  snapshot: AccountLocalDedicatedHostPolicySnapshot;
  funding_lane: DedicatedHostFundingLane;
  limitingWindow?: string;
}): { code: string; reason: string } {
  return funding_lane === "prepaid"
    ? prepaidReason(snapshot, limitingWindow)
    : creditReason(snapshot, limitingWindow);
}

function recoveryActionsForLane(
  funding_lane: DedicatedHostFundingLane,
): DedicatedHostBillingRecoveryAction[] {
  return funding_lane === "prepaid"
    ? ["add_funds", "support_limit_increase"]
    : ["fix_payment", "support_limit_increase"];
}

export function evaluateDedicatedHostBillingEnforcement({
  snapshot,
  funding_lane,
  hourly_cost_usd,
  lane_allowed,
  warning_runway_hours = DEDICATED_HOST_BILLING_WARNING_RUNWAY_HOURS,
  drain_runway_hours = DEDICATED_HOST_BILLING_DRAIN_RUNWAY_HOURS,
}: {
  snapshot: AccountLocalDedicatedHostPolicySnapshot;
  funding_lane: DedicatedHostFundingLane;
  hourly_cost_usd: MoneyValue;
  lane_allowed: boolean;
  warning_runway_hours?: number;
  drain_runway_hours?: number;
}): DedicatedHostBillingEnforcementDecision {
  const hourly = toDecimal(hourly_cost_usd);
  const limits = snapshot.effective_limits ?? {};
  const usage = snapshot.dedicated_host_window_usage;
  const runways: Array<{ window: string; hours: number }> = [];

  if (funding_lane === "prepaid") {
    if (hourly.gt(0)) {
      pushRunway(
        runways,
        "prepaid_balance",
        toDecimal(snapshot.balance ?? 0)
          .div(hourly)
          .toNumber(),
      );
    }
    pushRunway(
      runways,
      "prepaid_5h",
      runwayHours({
        limit: limits.prepaid_host_usage_limit_5h_usd,
        used: usage.prepaid_5h_usd,
        hourly,
      }),
    );
    pushRunway(
      runways,
      "prepaid_7d",
      runwayHours({
        limit: limits.prepaid_host_usage_limit_7d_usd,
        used: usage.prepaid_7d_usd,
        hourly,
      }),
    );
  } else {
    pushRunway(
      runways,
      "credit_5h",
      runwayHours({
        limit: limits.credit_spend_limit_5h_usd,
        used: usage.credit_5h_usd,
        hourly,
      }),
    );
    pushRunway(
      runways,
      "credit_7d",
      runwayHours({
        limit: limits.credit_spend_limit_7d_usd,
        used: usage.credit_7d_usd,
        hourly,
      }),
    );
    pushRunway(
      runways,
      "postpaid_unbilled",
      runwayHours({
        limit: Number(toDecimal(snapshot.postpaid_unbilled_limit_usd ?? 0)),
        used: snapshot.postpaid_unbilled_exposure_usd,
        hourly,
      }),
    );
  }

  const limiting = mostUrgentRunway(runways);
  const reason = reasonForLane({
    snapshot,
    funding_lane,
    limitingWindow: limiting?.window,
  });
  const recovery_actions = recoveryActionsForLane(funding_lane);

  if (!lane_allowed || (limiting && limiting.hours <= drain_runway_hours)) {
    return {
      state: "draining",
      action: "request_drain",
      reason_code: reason.code,
      reason: reason.reason,
      recovery_actions,
      limiting_runway_hours: limiting?.hours,
      limiting_window: limiting?.window,
    };
  }

  if (limiting && limiting.hours <= warning_runway_hours) {
    return {
      state: "at_risk",
      action: "mark_at_risk",
      reason_code: reason.code,
      reason: reason.reason,
      recovery_actions,
      limiting_runway_hours: limiting.hours,
      limiting_window: limiting.window,
    };
  }

  return {
    state: "ok",
    action: "none",
    recovery_actions: [],
    limiting_runway_hours: limiting?.hours,
    limiting_window: limiting?.window,
  };
}

export function buildDedicatedHostBillingEnforcementMetadata({
  previous,
  decision,
  hourly_cost_usd,
  now = new Date(),
}: {
  previous?: DedicatedHostBillingEnforcementMetadata | null;
  decision: DedicatedHostBillingEnforcementDecision;
  hourly_cost_usd: MoneyValue;
  now?: Date;
}): DedicatedHostBillingEnforcementMetadata {
  const nowIso = now.toISOString();
  if (decision.state === "ok") {
    return { state: "ok" };
  }
  return {
    ...(previous ?? {}),
    state: decision.state,
    reason_code: decision.reason_code,
    reason: decision.reason,
    first_detected_at: previous?.first_detected_at ?? nowIso,
    ...(decision.state === "at_risk"
      ? { at_risk_at: previous?.at_risk_at ?? nowIso }
      : {}),
    ...(decision.state === "draining"
      ? {
          drain_requested_at: previous?.drain_requested_at ?? nowIso,
          final_backup_status:
            previous?.final_backup_status === "succeeded" ||
            previous?.final_backup_status === "failed"
              ? previous.final_backup_status
              : "running",
        }
      : {}),
    recovery_actions: decision.recovery_actions,
    hourly_cost_usd: moneyToDbString(hourly_cost_usd),
    limiting_runway_hours: decision.limiting_runway_hours,
    limiting_window: decision.limiting_window,
  };
}
