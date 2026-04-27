/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ManagedProjectEgressCategory } from "@cocalc/server/membership/managed-egress";
import {
  getManagedEgressUsageForAccount,
  getProjectOwnerAccountId,
} from "@cocalc/server/membership/managed-egress";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";

export interface ManagedProjectEgressPolicy {
  account_id?: string;
  category: ManagedProjectEgressCategory;
  allowed: boolean;
  blocked_by?: "5h" | "7d";
  managed_egress_5h_bytes?: number;
  managed_egress_7d_bytes?: number;
  egress_5h_bytes?: number;
  egress_7d_bytes?: number;
  managed_egress_categories_5h_bytes?: Record<string, number>;
  managed_egress_categories_7d_bytes?: Record<string, number>;
}

export async function getManagedProjectEgressPolicy(opts: {
  project_id: string;
  category: ManagedProjectEgressCategory;
}): Promise<ManagedProjectEgressPolicy> {
  const account_id = await getProjectOwnerAccountId(opts.project_id);
  if (!account_id) {
    return {
      category: opts.category,
      allowed: true,
    };
  }
  const resolution = await resolveMembershipForAccount(account_id);
  const usageLimits = resolution.entitlements?.usage_limits ?? {};
  const egress_5h_bytes =
    typeof usageLimits.egress_5h_bytes === "number" &&
    Number.isFinite(usageLimits.egress_5h_bytes)
      ? usageLimits.egress_5h_bytes
      : undefined;
  const egress_7d_bytes =
    typeof usageLimits.egress_7d_bytes === "number" &&
    Number.isFinite(usageLimits.egress_7d_bytes)
      ? usageLimits.egress_7d_bytes
      : undefined;
  const usage = await getManagedEgressUsageForAccount({
    account_id,
    limit5h: egress_5h_bytes,
    limit7d: egress_7d_bytes,
  });
  const blocked_by = usage.over_managed_egress_5h
    ? "5h"
    : usage.over_managed_egress_7d
      ? "7d"
      : undefined;
  return {
    account_id,
    category: opts.category,
    allowed: blocked_by == null,
    blocked_by,
    managed_egress_5h_bytes: usage.managed_egress_5h_bytes,
    managed_egress_7d_bytes: usage.managed_egress_7d_bytes,
    egress_5h_bytes,
    egress_7d_bytes,
    managed_egress_categories_5h_bytes:
      usage.managed_egress_categories_5h_bytes,
    managed_egress_categories_7d_bytes:
      usage.managed_egress_categories_7d_bytes,
  };
}
