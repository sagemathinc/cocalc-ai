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
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getActiveAccountEntitlementOverride } from "@cocalc/server/membership/entitlement-overrides";
import { getEffectiveMembershipUsageLimits } from "@cocalc/server/membership/effective-limits";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import getBalance from "@cocalc/server/purchases/get-balance";
import { hasUsageSubscription } from "@cocalc/server/purchases/stripe-usage-based-subscription";
import { hasPaymentMethod } from "@cocalc/server/purchases/stripe/get-payment-methods";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import {
  getDedicatedHostPostpaidUnbilledExposureLocal,
  getDedicatedHostWindowUsageLocal,
  isDedicatedHostLaneCurrentlyAllowed,
} from "./spend";

export type DedicatedHostAction = "create" | "start" | "resize";
export type DedicatedHostFundingMode =
  | "account-prepaid"
  | "account-postpaid"
  | "site-funded";

export interface DedicatedHostAdmissionDecision {
  allowed: boolean;
  code?:
    | "membership_hosts_not_allowed"
    | "two_factor_required"
    | "payment_method_required"
    | "automatic_billing_required"
    | "membership_host_spend_not_configured"
    | "prepaid_balance_required"
    | "prepaid_usage_window_exceeded"
    | "postpaid_usage_window_exceeded";
  reason?: string;
  funding_lane?: "prepaid" | "credit";
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
): "prepaid" | "credit" | undefined {
  if (snapshot.funding_mode === "site-funded") {
    return undefined;
  }
  const limits = snapshot.effective_limits ?? {};
  if (snapshot.funding_mode === "account-prepaid") {
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
  const postpaidEnabled =
    hasPositiveLimit(limits.credit_spend_limit_5h_usd) ||
    hasPositiveLimit(limits.credit_spend_limit_7d_usd);
  if (
    postpaidEnabled &&
    isDedicatedHostLaneCurrentlyAllowed({
      snapshot,
      funding_lane: "credit",
    })
  ) {
    return "credit";
  }
  return undefined;
}

export function applyDedicatedHostFundingModeOverride(
  snapshot: AccountLocalDedicatedHostPolicySnapshot,
  funding_mode_override?: DedicatedHostFundingMode,
): AccountLocalDedicatedHostPolicySnapshot {
  if (
    funding_mode_override == null ||
    funding_mode_override === snapshot.funding_mode
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    funding_mode: funding_mode_override,
  };
}

export function evaluateDedicatedHostAdmission({
  action,
  machine_cloud,
  snapshot,
  has_active_second_factor_override,
  funding_mode_override,
}: {
  action: DedicatedHostAction;
  machine_cloud?: string | null;
  snapshot: AccountLocalDedicatedHostPolicySnapshot;
  has_active_second_factor_override?: boolean;
  funding_mode_override?: DedicatedHostFundingMode;
}): DedicatedHostAdmissionDecision {
  const effectiveSnapshot = applyDedicatedHostFundingModeOverride(
    snapshot,
    funding_mode_override,
  );
  if (!isBillableDedicatedHostCloud(machine_cloud)) {
    return { allowed: true };
  }

  if (!effectiveSnapshot.can_create_hosts) {
    return {
      allowed: false,
      code: "membership_hosts_not_allowed",
      reason: "membership does not allow dedicated hosts",
    };
  }

  const hasSecondFactor =
    has_active_second_factor_override ??
    effectiveSnapshot.has_active_second_factor;

  if (!hasSecondFactor) {
    return {
      allowed: false,
      code: "two_factor_required",
      reason: `enable two-factor authentication to ${actionLabel(action)}`,
    };
  }

  if (effectiveSnapshot.funding_mode === "site-funded") {
    return { allowed: true };
  }

  if (!effectiveSnapshot.has_payment_method) {
    return {
      allowed: false,
      code: "payment_method_required",
      reason: `add a payment method before trying to ${actionLabel(action)}`,
    };
  }

  const limits = effectiveSnapshot.effective_limits ?? {};
  const funding_lane = selectDedicatedHostFundingLane(effectiveSnapshot);
  if (funding_lane) {
    return {
      allowed: true,
      funding_lane,
    };
  }

  if (effectiveSnapshot.funding_mode === "account-prepaid") {
    const balance = toDecimal(effectiveSnapshot.balance ?? 0);
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

  const postpaidEnabled =
    hasPositiveLimit(limits.credit_spend_limit_5h_usd) ||
    hasPositiveLimit(limits.credit_spend_limit_7d_usd);
  if (!postpaidEnabled) {
    return {
      allowed: false,
      code: "membership_host_spend_not_configured",
      reason:
        "membership tier does not currently configure postpaid dedicated-host spending",
    };
  }
  if (!effectiveSnapshot.has_usage_subscription) {
    return {
      allowed: false,
      code: "automatic_billing_required",
      reason: `set up automatic billing before trying to ${actionLabel(action)}`,
    };
  }
  return {
    allowed: false,
    code: "postpaid_usage_window_exceeded",
    reason: `your dedicated-host postpaid usage window is exhausted; wait for it to reset before trying to ${actionLabel(action)}`,
  };
}

export function getDedicatedHostFundingModeFromSettings(
  settings: Awaited<ReturnType<typeof getServerSettings>>,
): DedicatedHostFundingMode {
  switch (settings.project_hosts_funding_mode) {
    case "account-prepaid":
      return "account-prepaid";
    case "account-postpaid":
      return "account-postpaid";
    default:
      return "site-funded";
  }
}

export async function getDedicatedHostPolicySnapshotLocal(
  account_id: string,
): Promise<AccountLocalDedicatedHostPolicySnapshot> {
  const [membership, settings, admin_override] = await Promise.all([
    resolveMembershipForAccount(account_id),
    getServerSettings(),
    getActiveAccountEntitlementOverride(account_id),
  ]);
  const effective_limits = getEffectiveMembershipUsageLimits(membership);
  const funding_mode =
    admin_override?.dedicated_hosts?.funding_mode?.value ??
    getDedicatedHostFundingModeFromSettings(settings);
  const has_active_second_factor = await hasActiveSecondFactor(account_id);

  if (funding_mode === "site-funded") {
    return {
      account_id,
      membership_class: membership.class,
      can_create_hosts:
        membership.entitlements?.features?.create_hosts === true,
      funding_mode,
      effective_limits,
      has_active_second_factor,
      has_payment_method: false,
      has_usage_subscription: false,
      balance: moneyToDbString(0),
      postpaid_unbilled_exposure_usd: moneyToDbString(0),
      dedicated_host_window_usage: {
        prepaid_5h_usd: moneyToDbString(0),
        prepaid_7d_usd: moneyToDbString(0),
        credit_5h_usd: moneyToDbString(0),
        credit_7d_usd: moneyToDbString(0),
      },
      admin_override,
    };
  }

  const [
    has_payment_method,
    has_usage_subscription,
    balance,
    dedicated_host_window_usage,
    postpaid_unbilled_exposure_usd,
  ] = await Promise.all([
    hasPaymentMethod(account_id),
    hasUsageSubscription(account_id),
    getBalance({ account_id }),
    getDedicatedHostWindowUsageLocal(account_id),
    getDedicatedHostPostpaidUnbilledExposureLocal(account_id),
  ]);

  return {
    account_id,
    membership_class: membership.class,
    can_create_hosts: membership.entitlements?.features?.create_hosts === true,
    funding_mode,
    effective_limits,
    has_active_second_factor,
    has_payment_method,
    has_usage_subscription,
    balance,
    postpaid_unbilled_exposure_usd,
    dedicated_host_window_usage,
    admin_override,
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
  funding_mode_override,
}: {
  account_id: string;
  action: DedicatedHostAction;
  machine_cloud?: string | null;
  has_active_second_factor_override?: boolean;
  funding_mode_override?: DedicatedHostFundingMode;
}): Promise<void> {
  if (!isBillableDedicatedHostCloud(machine_cloud)) {
    return;
  }
  const decision = evaluateDedicatedHostAdmission({
    action,
    machine_cloud,
    snapshot: await getDedicatedHostPolicySnapshotForAccount({ account_id }),
    has_active_second_factor_override,
    funding_mode_override,
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
