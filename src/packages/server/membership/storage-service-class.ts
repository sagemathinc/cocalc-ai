/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MembershipResolution } from "@cocalc/conat/hub/api/purchases";

export type StorageServiceClass = "paying" | "free";

export function storageFundingAccountId({
  owner_account_id,
  usage_account_id,
  users,
}: {
  owner_account_id: string | null;
  usage_account_id: string | null;
  users: Record<string, { group?: string }> | null;
}): string | null {
  const usageId = usage_account_id?.trim();
  if (usageId && users?.[usageId]?.group) return usageId;
  return owner_account_id?.trim() || null;
}

export function storageServiceClassFromMembership(
  resolution: MembershipResolution,
): StorageServiceClass {
  return (resolution.source === "subscription" &&
    Number(resolution.subscription_cost) > 0) ||
    (resolution.source === "grant" &&
      (resolution.grant_purchase_id != null ||
        resolution.site_license_id != null ||
        resolution.team_license_id != null))
    ? "paying"
    : "free";
}
