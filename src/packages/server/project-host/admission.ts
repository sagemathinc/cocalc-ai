/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  AccountLocalDedicatedHostPolicySnapshot,
  AccountLocalGetDedicatedHostPolicySnapshotRequest,
} from "@cocalc/conat/inter-bay/api";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { normalizeProviderId } from "@cocalc/cloud";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { hasActiveSecondFactor } from "@cocalc/server/auth/two-factor";
import { getEffectiveMembershipUsageLimits } from "@cocalc/server/membership/effective-limits";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import getBalance from "@cocalc/server/purchases/get-balance";
import { hasPaymentMethod } from "@cocalc/server/purchases/stripe/get-payment-methods";
import { toDecimal } from "@cocalc/util/money";
import {
  getDedicatedHostWindowUsageLocal,
  isDedicatedHostLaneCurrentlyAllowed,
} from "./spend";

export type DedicatedHostAction = "create" | "start" | "resize";

export interface DedicatedHostAdmissionDecision {
  allowed: boolean;
  code?:
    | "membership_hosts_not_allowed"
    | "two_factor_required"
    | "payment_method_required"
    | "membership_host_spend_not_configured"
    | "prepaid_balance_required"
    | "prepaid_usage_window_exceeded";
  reason?: string;
  funding_lane?: "prepaid";
}

function actionLabel(action: DedicatedHostAction): string {
  switch (action) {
    case "create":
      return "create dedicated hosts";
    case "start":
      return "start dedicated hosts";
    case "resize":
      return "resize dedicated hosts";
    default:
      return "use dedicated hosts";
  }
}

function hasPositiveLimit(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isBillableDedicatedHostCloud(cloud?: string | null): boolean {
  const provider = normalizeProviderId(cloud);
  return !!provider && provider !== "self-host" && provider !== "local";
}

export function selectDedicatedHostFundingLane(
  snapshot: AccountLocalDedicatedHostPolicySnapshot,
): "prepaid" | undefined {
  const limits = snapshot.effective_limits ?? {};
  const balance = toDecimal(snapshot.balance ?? 0);
  const prepaidEnabled =
    hasPositiveLimit(limits.prepaid_host_usage_limit_5h_usd) ||
    hasPositiveLimit(limits.prepaid_host_usage_limit_7d_usd);

  if (
    prepaidEnabled &&
    balance.gt(0) &&
    isDedicatedHostLaneCurrentlyAllowed({
      snapshot,
      funding_lane: "prepaid",
    })
  ) {
    return "prepaid";
  }
  return undefined;
}

export function evaluateDedicatedHostAdmission({
  action,
  machine_cloud,
  snapshot,
  has_active_second_factor_override,
}: {
  action: DedicatedHostAction;
  machine_cloud?: string | null;
  snapshot: AccountLocalDedicatedHostPolicySnapshot;
  has_active_second_factor_override?: boolean;
}): DedicatedHostAdmissionDecision {
  if (!isBillableDedicatedHostCloud(machine_cloud)) {
    return { allowed: true };
  }

  if (!snapshot.can_create_hosts) {
    return {
      allowed: false,
      code: "membership_hosts_not_allowed",
      reason: "membership does not allow dedicated hosts",
    };
  }

  const hasSecondFactor =
    has_active_second_factor_override ?? snapshot.has_active_second_factor;

  if (!hasSecondFactor) {
    return {
      allowed: false,
      code: "two_factor_required",
      reason: `enable two-factor authentication to ${actionLabel(action)}`,
    };
  }

  if (!snapshot.has_payment_method) {
    return {
      allowed: false,
      code: "payment_method_required",
      reason: `add a payment method before trying to ${actionLabel(action)}`,
    };
  }

  const limits = snapshot.effective_limits ?? {};
  const balance = toDecimal(snapshot.balance ?? 0);
  const prepaidEnabled =
    hasPositiveLimit(limits.prepaid_host_usage_limit_5h_usd) ||
    hasPositiveLimit(limits.prepaid_host_usage_limit_7d_usd);

  if (!prepaidEnabled) {
    return {
      allowed: false,
      code: "membership_host_spend_not_configured",
      reason:
        "membership tier does not currently configure prepaid dedicated-host spending",
    };
  }

  const funding_lane = selectDedicatedHostFundingLane(snapshot);
  if (funding_lane) {
    return {
      allowed: true,
      funding_lane,
    };
  }

  if (prepaidEnabled && balance.gt(0)) {
    return {
      allowed: false,
      code: "prepaid_usage_window_exceeded",
      reason: `your dedicated-host prepaid usage window is exhausted; wait for it to reset before trying to ${actionLabel(action)}`,
    };
  }

  return {
    allowed: false,
    code: "prepaid_balance_required",
    reason: `add prepaid credit before trying to ${actionLabel(action)}`,
  };
}

export async function getDedicatedHostPolicySnapshotLocal(
  account_id: string,
): Promise<AccountLocalDedicatedHostPolicySnapshot> {
  const membership = await resolveMembershipForAccount(account_id);
  const effective_limits = getEffectiveMembershipUsageLimits(membership);
  const [
    has_active_second_factor,
    has_payment_method,
    balance,
    dedicated_host_window_usage,
  ] = await Promise.all([
    hasActiveSecondFactor(account_id),
    hasPaymentMethod(account_id),
    getBalance({ account_id }),
    getDedicatedHostWindowUsageLocal(account_id),
  ]);

  return {
    account_id,
    membership_class: membership.class,
    can_create_hosts: membership.entitlements?.features?.create_hosts === true,
    effective_limits,
    has_active_second_factor,
    has_payment_method,
    balance,
    dedicated_host_window_usage,
  };
}

export async function getDedicatedHostPolicySnapshotForAccount({
  account_id,
}: AccountLocalGetDedicatedHostPolicySnapshotRequest): Promise<AccountLocalDedicatedHostPolicySnapshot> {
  const location = await resolveAccountHomeBay({
    account_id,
    user_account_id: account_id,
  });
  const home_bay_id =
    `${location.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (home_bay_id === getConfiguredBayId()) {
    return await getDedicatedHostPolicySnapshotLocal(account_id);
  }
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: home_bay_id,
  }).getDedicatedHostPolicySnapshot({
    account_id,
  });
}

export async function assertDedicatedHostAdmissionForAccount({
  account_id,
  action,
  machine_cloud,
  has_active_second_factor_override,
}: {
  account_id: string;
  action: DedicatedHostAction;
  machine_cloud?: string | null;
  has_active_second_factor_override?: boolean;
}): Promise<void> {
  if (!isBillableDedicatedHostCloud(machine_cloud)) {
    return;
  }
  const decision = evaluateDedicatedHostAdmission({
    action,
    machine_cloud,
    snapshot: await getDedicatedHostPolicySnapshotForAccount({ account_id }),
    has_active_second_factor_override,
  });
  if (decision.allowed) {
    return;
  }
  throw Object.assign(
    new Error(decision.reason ?? "dedicated host action is not allowed"),
    {
      code: decision.code,
      details: decision,
    },
  );
}
