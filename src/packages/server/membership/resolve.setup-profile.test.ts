/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: jest.fn() })),
}));

import type { MembershipResolution } from "@cocalc/conat/hub/api/purchases";
import { TIER_TEMPLATES } from "@cocalc/util/membership-tier-templates";
import { normalizeMembershipEffectiveLimits } from "./effective-limits";
import {
  applySetupProfileMembershipLimits,
  STAR_PROJECT_DEFAULTS,
  STAR_GENEROUS_USAGE_LIMITS,
  STAR_RETAINED_USAGE_LIMITS,
  STAR_UNLIMITED_USAGE_LIMITS,
} from "./resolve";

const classified = [
  ...STAR_UNLIMITED_USAGE_LIMITS,
  ...STAR_GENEROUS_USAGE_LIMITS,
  ...STAR_RETAINED_USAGE_LIMITS,
] as string[];

function freeMembership(): MembershipResolution {
  const usage_limits = structuredClone(TIER_TEMPLATES.free.usage_limits);
  return {
    class: "free",
    source: "free",
    entitlements: {
      usage_limits,
      project_defaults: structuredClone(TIER_TEMPLATES.free.project_defaults),
    },
    effective_limits: normalizeMembershipEffectiveLimits(usage_limits),
  } as MembershipResolution;
}

describe("applySetupProfileMembershipLimits", () => {
  it("classifies every usage limit exactly once", () => {
    expect(new Set(classified).size).toBe(classified.length);
    const known = new Set([
      ...Object.keys(normalizeMembershipEffectiveLimits({})),
      ...Object.values(TIER_TEMPLATES).flatMap((tier) =>
        Object.keys(tier.usage_limits ?? {}),
      ),
    ]);
    expect([...known].filter((key) => !classified.includes(key))).toEqual([]);
    expect(classified.filter((key) => !known.has(key))).toEqual([]);
  });

  it("lifts the free tier's per-account limits on CoCalc Star", () => {
    const membership = freeMembership();
    const star = applySetupProfileMembershipLimits(membership, "star");
    const admin = TIER_TEMPLATES.admin.usage_limits as Record<string, unknown>;
    const free = TIER_TEMPLATES.free.usage_limits as Record<string, unknown>;
    for (const limits of [
      star.effective_limits,
      star.entitlements.usage_limits,
    ] as Record<string, unknown>[]) {
      for (const key of STAR_UNLIMITED_USAGE_LIMITS) {
        expect(limits[key]).toBeUndefined();
      }
      for (const key of STAR_GENEROUS_USAGE_LIMITS) {
        expect(limits[key]).toEqual(admin[key]);
      }
      for (const key of STAR_RETAINED_USAGE_LIMITS) {
        if (key in free) expect(limits[key]).toEqual(free[key]);
      }
    }
    expect(star.effective_limits?.rootfs_oci_images).toBe(true);
    expect(star.class).toBe("free");
    // The resolved membership itself is not mutated.
    expect(membership.effective_limits?.max_projects).toBe(
      TIER_TEMPLATES.free.usage_limits.max_projects,
    );
    expect(membership.entitlements.usage_limits?.max_projects).toBe(
      TIER_TEMPLATES.free.usage_limits.max_projects,
    );
  });

  it("gives Star projects moderate sizes without shrinking larger tiers", () => {
    const free = applySetupProfileMembershipLimits(freeMembership(), "star");
    expect(free.entitlements.project_defaults).toEqual({
      ...TIER_TEMPLATES.free.project_defaults,
      ...STAR_PROJECT_DEFAULTS,
    });
    const admin = applySetupProfileMembershipLimits(
      {
        ...freeMembership(),
        class: "admin",
        entitlements: {
          project_defaults: structuredClone(
            TIER_TEMPLATES.admin.project_defaults,
          ),
        },
      } as MembershipResolution,
      "star",
    );
    expect(admin.entitlements.project_defaults).toEqual(
      TIER_TEMPLATES.admin.project_defaults,
    );
    const none = applySetupProfileMembershipLimits(
      { ...freeMembership(), entitlements: {} } as MembershipResolution,
      "star",
    );
    expect(none.entitlements.project_defaults).toEqual(STAR_PROJECT_DEFAULTS);
  });

  it("keeps membership limits on every other site", () => {
    const membership = freeMembership();
    expect(applySetupProfileMembershipLimits(membership, undefined)).toBe(
      membership,
    );
    expect(applySetupProfileMembershipLimits(membership, "launchpad")).toBe(
      membership,
    );
  });
});
