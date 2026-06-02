/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  AccountUsageOverview,
  MembershipDetails,
} from "@cocalc/conat/hub/api/purchases";

export const MEMBERSHIP_DETAILS_REFRESHED_EVENT =
  "cocalc:membership-details-refreshed";
export const ACCOUNT_USAGE_OVERVIEW_REFRESHED_EVENT =
  "cocalc:account-usage-overview-refreshed";

export function dispatchMembershipDetailsRefreshed(
  details: MembershipDetails,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<MembershipDetails>(MEMBERSHIP_DETAILS_REFRESHED_EVENT, {
      detail: details,
    }),
  );
}

export function getMembershipDetailsRefreshedEventDetail(
  event: Event,
): MembershipDetails | undefined {
  return (event as CustomEvent<MembershipDetails>).detail;
}

export function dispatchAccountUsageOverviewRefreshed(
  overview: AccountUsageOverview,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AccountUsageOverview>(
      ACCOUNT_USAGE_OVERVIEW_REFRESHED_EVENT,
      {
        detail: overview,
      },
    ),
  );
}

export function getAccountUsageOverviewRefreshedEventDetail(
  event: Event,
): AccountUsageOverview | undefined {
  return (event as CustomEvent<AccountUsageOverview>).detail;
}
