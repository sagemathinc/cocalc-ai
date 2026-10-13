/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Upload limits for sagebrush.space, from the account's membership tier. The
// Sagebrush Worker reads them through /api/v2/sagebrush/limits. See
// docs/sagebrush.md.

import { getOAuthAccountState } from "@cocalc/server/auth/oauth/account-state";
import { getEffectiveMembershipUsageLimits } from "@cocalc/server/membership/effective-limits";
import { TIER_TEMPLATES } from "@cocalc/util/membership-tier-templates";

export interface SagebrushLimits {
  tier: string;
  storage_bytes: number;
  max_file_bytes: number;
  private_links: boolean;
}

// For a tier that sets none of the Sagebrush limits and has no built-in
// template to inherit them from.
const FALLBACK = TIER_TEMPLATES.free.usage_limits;

/** The account's Sagebrush limits, or undefined if the account does not
 * exist, was deleted or is banned. Its home bay checks the account and
 * resolves its membership in one call. */
export async function getSagebrushLimits(
  account_id: string,
): Promise<SagebrushLimits | undefined> {
  const account = await getOAuthAccountState(account_id, {
    include_membership: true,
  });
  if (account.state !== "live" || account.membership == null) return;
  const { membership } = account;
  const limits = getEffectiveMembershipUsageLimits(membership);
  return {
    tier: `${membership.class}`,
    storage_bytes:
      limits.sagebrush_storage_bytes ?? FALLBACK.sagebrush_storage_bytes,
    max_file_bytes:
      limits.sagebrush_max_file_bytes ?? FALLBACK.sagebrush_max_file_bytes,
    private_links:
      limits.sagebrush_private_links ?? FALLBACK.sagebrush_private_links,
  };
}
