/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: jest.fn() })),
}));

import {
  STAR_FREE_TIER_TEMPLATE,
  STAR_GENEROUS_USAGE_LIMITS,
  STAR_RETAINED_USAGE_LIMITS,
  STAR_UNLIMITED_USAGE_LIMITS,
  TIER_TEMPLATES,
} from "@cocalc/util/membership-tier-templates";
import {
  getEffectiveMembershipUsageLimits,
  normalizeMembershipEffectiveLimits,
} from "./effective-limits";
import { membershipTierMapFromTiers } from "./tiers";

describe("CoCalc Star free tier on the server", () => {
  const previous = process.env.COCALC_SETUP_PROFILE;
  afterEach(() => {
    if (previous == null) delete process.env.COCALC_SETUP_PROFILE;
    else process.env.COCALC_SETUP_PROFILE = previous;
  });

  it("classifies every effective usage limit", () => {
    const classified = new Set<string>([
      ...STAR_UNLIMITED_USAGE_LIMITS,
      ...STAR_GENEROUS_USAGE_LIMITS,
      ...STAR_RETAINED_USAGE_LIMITS,
    ]);
    expect(
      Object.keys(normalizeMembershipEffectiveLimits({})).filter(
        (key) => !classified.has(key),
      ),
    ).toEqual([]);
  });

  it("uses the Star free tier on Star and the stock one elsewhere", () => {
    process.env.COCALC_SETUP_PROFILE = "star";
    const star = membershipTierMapFromTiers([]).free;
    expect(star).toBe(STAR_FREE_TIER_TEMPLATE);
    const limits = getEffectiveMembershipUsageLimits({
      entitlements: { usage_limits: star.usage_limits as any },
    });
    expect(limits.max_projects).toBeUndefined();
    expect(limits.max_sponsored_running_projects).toBeUndefined();
    expect(limits.rootfs_oci_images).toBe(true);

    delete process.env.COCALC_SETUP_PROFILE;
    expect(membershipTierMapFromTiers([]).free).toBe(TIER_TEMPLATES.free);
  });
});
