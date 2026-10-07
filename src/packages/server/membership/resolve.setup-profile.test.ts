/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: jest.fn() })),
}));

import type { MembershipResolution } from "@cocalc/conat/hub/api/purchases";
import { applySetupProfileMembershipLimits } from "./resolve";

function freeMembership(): MembershipResolution {
  const usage_limits = {
    max_projects: 5,
    max_sponsored_running_projects: 1,
    total_storage_soft_bytes: 1,
    total_storage_hard_bytes: 2,
    egress_5h_bytes: 3,
    egress_7d_bytes: 4,
    cpu_5h_seconds: 5,
    cpu_7d_seconds: 6,
    browser_idle_timeout_seconds: 7,
    max_snapshots_per_project: 8,
    max_named_agents: 9,
    shared_compute_priority: 0,
  };
  return {
    class: "free",
    source: "free",
    entitlements: { usage_limits },
    effective_limits: { ...usage_limits },
  } as MembershipResolution;
}

describe("applySetupProfileMembershipLimits", () => {
  it("removes per-account usage limits on CoCalc Star", () => {
    const membership = freeMembership();
    const star = applySetupProfileMembershipLimits(membership, "star");
    for (const limits of [
      star.effective_limits,
      star.entitlements.usage_limits,
    ] as Record<string, unknown>[]) {
      expect(limits).not.toHaveProperty("max_projects");
      expect(limits).not.toHaveProperty("max_sponsored_running_projects");
      expect(limits).not.toHaveProperty("total_storage_hard_bytes");
      expect(limits).not.toHaveProperty("egress_7d_bytes");
      expect(limits).not.toHaveProperty("cpu_5h_seconds");
      expect(limits).not.toHaveProperty("browser_idle_timeout_seconds");
      // Per-project and agent settings keep their values.
      expect(limits).toMatchObject({
        max_snapshots_per_project: 8,
        max_named_agents: 9,
        shared_compute_priority: 0,
      });
    }
    expect(star.class).toBe("free");
    // The resolved membership itself is not mutated.
    expect(membership.effective_limits?.max_projects).toBe(5);
    expect(membership.entitlements.usage_limits?.max_projects).toBe(5);
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
