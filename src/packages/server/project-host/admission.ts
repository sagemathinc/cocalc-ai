/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  AccountLocalDedicatedHostAdmissionSnapshot,
  AccountLocalDedicatedHostPolicySnapshot,
  AccountLocalGetDedicatedHostPolicySnapshotRequest,
} from "@cocalc/conat/inter-bay/api";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { normalizeProviderId } from "@cocalc/cloud";
import type { PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { hasActiveSecondFactor } from "@cocalc/server/auth/two-factor";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getActiveAccountEntitlementOverride } from "@cocalc/server/membership/entitlement-overrides";
import { getEffectiveMembershipUsageLimits } from "@cocalc/server/membership/effective-limits";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { executeBillingAuthorityCommand } from "@cocalc/server/purchases/billing-authority/client";
import { isBillingAuthorityEnabled } from "@cocalc/server/purchases/billing-authority/config";
import getBalance from "@cocalc/server/purchases/get-balance";
import { getAccountFundingHolds } from "@cocalc/server/purchases/get-spendable-balance";
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
    const balance = toDecimal(
      snapshot.prepaid_spendable_balance ?? snapshot.balance ?? 0,
    );
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

  const limits = effectiveSnapshot.effective_limits ?? {};
  const funding_lane = selectDedicatedHostFundingLane(effectiveSnapshot);
  if (funding_lane) {
    return {
      allowed: true,
      funding_lane,
    };
  }

  if (effectiveSnapshot.funding_mode === "account-prepaid") {
    const balance = toDecimal(
      effectiveSnapshot.prepaid_spendable_balance ??
        effectiveSnapshot.balance ??
        0,
    );
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
  if (!effectiveSnapshot.has_payment_method) {
    return {
      allowed: false,
      code: "payment_method_required",
      reason: `add a payment method before trying to ${actionLabel(action)}`,
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

export async function getDedicatedHostAdmissionSnapshotLocal(
  account_id: string,
): Promise<AccountLocalDedicatedHostAdmissionSnapshot> {
  const [membership, settings, admin_override, has_active_second_factor] =
    await Promise.all([
      resolveMembershipForAccount(account_id),
      getServerSettings(),
      getActiveAccountEntitlementOverride(account_id),
      hasActiveSecondFactor(account_id),
    ]);
  return {
    account_id,
    membership_class: membership.class,
    can_create_hosts: membership.entitlements?.features?.create_hosts === true,
    funding_mode:
      admin_override?.dedicated_hosts?.funding_mode?.value ??
      getDedicatedHostFundingModeFromSettings(settings),
    effective_limits: getEffectiveMembershipUsageLimits(membership),
    has_active_second_factor,
    admin_override,
  };
}

export async function getDedicatedHostAdmissionSnapshotForAccount(
  account_id: string,
): Promise<AccountLocalDedicatedHostAdmissionSnapshot> {
  const location = await resolveAccountHomeBay({
    account_id,
    user_account_id: account_id,
  });
  const home_bay_id =
    `${location.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (home_bay_id === getConfiguredBayId()) {
    return await getDedicatedHostAdmissionSnapshotLocal(account_id);
  }
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: home_bay_id,
  }).getDedicatedHostAdmissionSnapshot({ account_id });
}

interface DedicatedHostFinancialSnapshot {
  has_payment_method: boolean;
  has_usage_subscription: boolean;
  balance: string;
  prepaid_spendable_balance: string;
  postpaid_committed_usd: string;
  postpaid_unbilled_exposure_usd: string;
  dedicated_host_window_usage: AccountLocalDedicatedHostPolicySnapshot["dedicated_host_window_usage"];
}

export interface DedicatedHostProviderReadiness {
  has_payment_method: boolean;
}

/** Stripe-backed readiness is deliberately fetched before account financial
 * locks are acquired. Database-backed subscription and exposure state is still
 * read under the transaction that makes the admission decision. */
export async function getDedicatedHostProviderReadinessLocal(
  account_id: string,
): Promise<DedicatedHostProviderReadiness> {
  return { has_payment_method: await hasPaymentMethod(account_id) };
}

export async function getDedicatedHostFinancialSnapshotLocal(
  account_id: string,
  {
    needs_postpaid_snapshot,
    client,
    has_payment_method_override,
  }: {
    needs_postpaid_snapshot: boolean;
    client?: PoolClient;
    has_payment_method_override?: boolean;
  },
): Promise<DedicatedHostFinancialSnapshot> {
  const [
    balance,
    dedicated_host_window_usage,
    postpaid_unbilled_exposure_usd,
    holds,
  ] = await Promise.all([
    getBalance({ account_id, client, noSave: true }),
    getDedicatedHostWindowUsageLocal(account_id, { client }),
    getDedicatedHostPostpaidUnbilledExposureLocal(account_id, { client }),
    getAccountFundingHolds({ account_id, client }),
  ]);
  const [has_payment_method, has_usage_subscription] = needs_postpaid_snapshot
    ? await Promise.all([
        has_payment_method_override ?? hasPaymentMethod(account_id),
        hasUsageSubscription(account_id, client),
      ])
    : [false, false];
  return {
    has_payment_method,
    has_usage_subscription,
    balance: moneyToDbString(balance),
    prepaid_spendable_balance: moneyToDbString(
      toDecimal(balance).minus(holds.prepaid_held_usd),
    ),
    postpaid_committed_usd: holds.postpaid_committed_usd,
    postpaid_unbilled_exposure_usd: moneyToDbString(
      postpaid_unbilled_exposure_usd,
    ),
    dedicated_host_window_usage,
  };
}

export async function getDedicatedHostPolicySnapshotLocal(
  account_id: string,
  {
    funding_mode_override,
    client,
    admission_snapshot,
    has_payment_method_override,
  }: {
    funding_mode_override?: DedicatedHostFundingMode;
    client?: PoolClient;
    admission_snapshot?: AccountLocalDedicatedHostAdmissionSnapshot;
    has_payment_method_override?: boolean;
  } = {},
): Promise<AccountLocalDedicatedHostPolicySnapshot> {
  const admission =
    admission_snapshot ??
    (await getDedicatedHostAdmissionSnapshotLocal(account_id));
  if (admission.account_id !== account_id) {
    throw new Error("Dedicated-host admission snapshot account mismatch.");
  }
  const { funding_mode } = admission;
  const needs_account_billing_snapshot =
    funding_mode !== "site-funded" ||
    (funding_mode_override != null && funding_mode_override !== "site-funded");

  if (!needs_account_billing_snapshot) {
    return {
      ...admission,
      has_payment_method: false,
      has_usage_subscription: false,
      balance: moneyToDbString(0),
      prepaid_spendable_balance: moneyToDbString(0),
      postpaid_unbilled_exposure_usd: moneyToDbString(0),
      dedicated_host_window_usage: {
        prepaid_5h_usd: moneyToDbString(0),
        prepaid_7d_usd: moneyToDbString(0),
        credit_5h_usd: moneyToDbString(0),
        credit_7d_usd: moneyToDbString(0),
      },
    };
  }

  const needs_postpaid_snapshot =
    funding_mode === "account-postpaid" ||
    funding_mode_override === "account-postpaid";
  const financial =
    isBillingAuthorityEnabled() && !client
      ? await executeBillingAuthorityCommand<DedicatedHostFinancialSnapshot>(
          {
            kind: "account-local",
            operation: "get-dedicated-host-financial-snapshot",
            input: { account_id, needs_postpaid_snapshot },
            actor_account_id: account_id,
          },
          { read: true },
        )
      : await getDedicatedHostFinancialSnapshotLocal(account_id, {
          needs_postpaid_snapshot,
          client,
          has_payment_method_override,
        });

  return {
    ...admission,
    ...financial,
  };
}

export async function getDedicatedHostPolicySnapshotForAccount({
  account_id,
  funding_mode_override,
}: AccountLocalGetDedicatedHostPolicySnapshotRequest): Promise<AccountLocalDedicatedHostPolicySnapshot> {
  const location = await resolveAccountHomeBay({
    account_id,
    user_account_id: account_id,
  });
  const home_bay_id =
    `${location.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (home_bay_id === getConfiguredBayId()) {
    return await getDedicatedHostPolicySnapshotLocal(account_id, {
      funding_mode_override,
    });
  }
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: home_bay_id,
  }).getDedicatedHostPolicySnapshot({
    account_id,
    funding_mode_override,
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
    snapshot: await getDedicatedHostPolicySnapshotForAccount({
      account_id,
      funding_mode_override,
    }),
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
