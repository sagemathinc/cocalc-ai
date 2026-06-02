/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MembershipDetails } from "@cocalc/conat/hub/api/purchases";

export const MEMBERSHIP_DETAILS_REFRESHED_EVENT =
  "cocalc:membership-details-refreshed";

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
