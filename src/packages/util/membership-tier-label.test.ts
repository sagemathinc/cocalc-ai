/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  assertValidMembershipTierLabel,
  boundedMembershipTierLabel,
  MAX_MEMBERSHIP_TIER_LABEL_LENGTH,
} from "./membership-tier-label";

describe("membership tier labels", () => {
  it("bounds legacy labels used in external billing descriptions", () => {
    expect(
      boundedMembershipTierLabel({ id: "fallback", label: "x".repeat(500) }),
    ).toHaveLength(MAX_MEMBERSHIP_TIER_LABEL_LENGTH);
    expect(boundedMembershipTierLabel({ id: "fallback" })).toBe("fallback");
  });

  it("rejects new labels beyond the billing-safe limit", () => {
    expect(() =>
      assertValidMembershipTierLabel(
        "x".repeat(MAX_MEMBERSHIP_TIER_LABEL_LENGTH + 1),
      ),
    ).toThrow("at most 100 characters");
  });
});
