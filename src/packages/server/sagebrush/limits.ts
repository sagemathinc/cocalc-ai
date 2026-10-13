/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Upload limits for sagebrush.space, from the account's membership tier. The
// Sagebrush Worker reads them through /api/v2/sagebrush/limits. See
// docs/sagebrush.md.

import type { MembershipResolution } from "@cocalc/conat/hub/api/purchases";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { getEffectiveMembershipUsageLimits } from "@cocalc/server/membership/effective-limits";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { isValidUUID } from "@cocalc/util/misc";
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

async function getMembership(
  account_id: string,
  home_bay_id: string,
): Promise<MembershipResolution> {
  if (home_bay_id === getConfiguredBayId()) {
    return await resolveMembershipForAccount(account_id);
  }
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: home_bay_id,
  }).getMembership({ account_id });
}

/** The account's Sagebrush limits, or undefined if the account does not
 * exist, was deleted or is banned. */
export async function getSagebrushLimits(
  account_id: string,
): Promise<SagebrushLimits | undefined> {
  if (!isValidUUID(account_id)) return;
  const account = await getClusterAccountById(account_id);
  if (account == null || account.banned) return;
  const home_bay_id =
    `${account.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  const membership = await getMembership(account_id, home_bay_id);
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
