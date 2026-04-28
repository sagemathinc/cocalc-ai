/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MembershipDetails } from "@cocalc/conat/hub/api/purchases";
import {
  MANAGED_EGRESS_WARNING_THRESHOLD,
  getManagedEgressWindowWarnings,
} from "./managed-egress-warning";

function makeDetails({
  limit5h = 0,
  limit7d = 0,
  used5h = 0,
  used7d = 0,
}: {
  limit5h?: number;
  limit7d?: number;
  used5h?: number;
  used7d?: number;
}): MembershipDetails {
  return {
    selected: {
      class: "member",
      source: "subscription",
      entitlements: {
        usage_limits: {
          egress_5h_bytes: limit5h,
          egress_7d_bytes: limit7d,
        },
      },
    },
    candidates: [],
    usage_status: {
      collected_at: new Date().toISOString(),
      owned_project_count: 0,
      sampled_project_count: 0,
      unsampled_project_count: 0,
      total_storage_bytes: 0,
      managed_egress_5h_bytes: used5h,
      managed_egress_7d_bytes: used7d,
    },
  };
}

describe("getManagedEgressWindowWarnings", () => {
  it("returns no warning below the threshold", () => {
    const details = makeDetails({
      limit5h: 1000,
      used5h: Math.floor(1000 * (MANAGED_EGRESS_WARNING_THRESHOLD - 0.01)),
    });
    expect(getManagedEgressWindowWarnings(details)).toEqual([]);
  });

  it("returns warnings at or above the threshold", () => {
    const details = makeDetails({
      limit5h: 1000,
      used5h: 900,
      limit7d: 5000,
      used7d: 5200,
    });
    expect(getManagedEgressWindowWarnings(details)).toEqual([
      expect.objectContaining({
        window: "7d",
        over: true,
        percent: 104,
      }),
      expect.objectContaining({
        window: "5h",
        over: false,
        percent: 90,
      }),
    ]);
  });

  it("prefers over-limit windows before near-limit windows", () => {
    const details = makeDetails({
      limit5h: 1000,
      used5h: 980,
      limit7d: 5000,
      used7d: 5100,
    });
    const warnings = getManagedEgressWindowWarnings(details);
    expect(warnings[0]).toEqual(
      expect.objectContaining({
        window: "7d",
        over: true,
      }),
    );
    expect(warnings[1]).toEqual(
      expect.objectContaining({
        window: "5h",
        over: false,
      }),
    );
  });
});
