/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { HostFundingMode } from "@cocalc/conat/hub/api/hosts";
import type {
  MembershipEffectiveLimits,
  MembershipResolution,
} from "@cocalc/conat/hub/api/purchases";

export type HostFundingModeOption = {
  value: HostFundingMode;
  label: string;
};

function hasPositiveLimit(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasPrepaidFunding(limits?: MembershipEffectiveLimits): boolean {
  return (
    hasPositiveLimit(limits?.prepaid_host_usage_limit_5h_usd) ||
    hasPositiveLimit(limits?.prepaid_host_usage_limit_7d_usd)
  );
}

function hasPostpaidFunding(limits?: MembershipEffectiveLimits): boolean {
  return (
    hasPositiveLimit(limits?.credit_spend_limit_5h_usd) ||
    hasPositiveLimit(limits?.credit_spend_limit_7d_usd)
  );
}

export function isBillableHostProvider(provider?: string | null): boolean {
  return !!provider && provider !== "none" && provider !== "self-host";
}

export function getHostFundingModeOptions({
  isAdmin,
  membership,
}: {
  isAdmin: boolean;
  membership?: MembershipResolution | null;
}): HostFundingModeOption[] {
  const limits = membership?.effective_limits;
  const options: HostFundingModeOption[] = [];
  if (isAdmin) {
    options.push({
      value: "site-funded",
      label: "Site-funded",
    });
  }
  if (isAdmin || hasPostpaidFunding(limits)) {
    options.push({
      value: "account-postpaid",
      label: "Postpaid to this account",
    });
  }
  if (isAdmin || hasPrepaidFunding(limits)) {
    options.push({
      value: "account-prepaid",
      label: "Prepaid from this account",
    });
  }
  return options;
}

export function defaultHostFundingMode({
  options,
  current,
}: {
  options: HostFundingModeOption[];
  current?: HostFundingMode | null;
}): HostFundingMode | undefined {
  if (current && options.some((option) => option.value === current)) {
    return current;
  }
  return options[0]?.value;
}
