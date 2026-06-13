/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  membershipTierVisibleForVerifiedInstructorEmail,
  normalizeMembershipTierCourseAllowedDomains,
} from "./membership-tier-domains";

describe("membership tier course allowed domains", () => {
  it("normalizes admin-entered exact and wildcard domains", () => {
    expect(
      normalizeMembershipTierCourseAllowedDomains([
        " @UCLA.EDU ",
        "*.math.ucla.edu",
        "bad domain",
        "ucla.edu.",
      ]),
    ).toEqual(["ucla.edu", "*.math.ucla.edu"]);
  });

  it("leaves unrestricted tiers visible", () => {
    expect(
      membershipTierVisibleForVerifiedInstructorEmail({
        emailAddress: undefined,
        emailVerified: false,
        tier: {},
      }),
    ).toBe(true);
  });

  it("requires a verified matching instructor email for restricted tiers", () => {
    const tier = { course_allowed_domains: ["ucla.edu", "*.school.edu"] };
    expect(
      membershipTierVisibleForVerifiedInstructorEmail({
        emailAddress: "instructor@ucla.edu",
        emailVerified: true,
        tier,
      }),
    ).toBe(true);
    expect(
      membershipTierVisibleForVerifiedInstructorEmail({
        emailAddress: "instructor@dept.school.edu",
        emailVerified: true,
        tier,
      }),
    ).toBe(true);
    expect(
      membershipTierVisibleForVerifiedInstructorEmail({
        emailAddress: "instructor@example.edu",
        emailVerified: true,
        tier,
      }),
    ).toBe(false);
    expect(
      membershipTierVisibleForVerifiedInstructorEmail({
        emailAddress: "instructor@ucla.edu",
        emailVerified: false,
        tier,
      }),
    ).toBe(false);
  });
});
