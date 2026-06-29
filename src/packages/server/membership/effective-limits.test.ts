/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getEffectiveMembershipUsageLimits } from "./effective-limits";

describe("membership effective limits", () => {
  it("normalizes public directory share limits", () => {
    expect(
      getEffectiveMembershipUsageLimits({
        entitlements: {
          usage_limits: {
            public_directory_shares: 37,
          },
        },
      }).public_directory_shares,
    ).toBe(37);

    expect(
      getEffectiveMembershipUsageLimits({
        entitlements: {
          usage_limits: {
            public_directory_shares: -1,
          },
        },
      }).public_directory_shares,
    ).toBeUndefined();
  });
});
