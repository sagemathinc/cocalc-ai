/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const resolveRuntimeMembershipMock = jest.fn();

jest.mock("./runtime-resolution", () => ({
  resolveRuntimeMembership: (...args: any[]) =>
    resolveRuntimeMembershipMock(...args),
}));

import { STAR_FREE_TIER_TEMPLATE } from "@cocalc/util/membership-tier-templates";
import { getMembershipRuntimeSchedulingForAccount } from "./project-defaults";

describe("project internet access from the membership tier", () => {
  it("passes on an explicit tier setting", async () => {
    resolveRuntimeMembershipMock.mockResolvedValue({
      class: "free",
      entitlements: {
        features: STAR_FREE_TIER_TEMPLATE.features,
        usage_limits: STAR_FREE_TIER_TEMPLATE.usage_limits,
      },
    });
    await expect(
      getMembershipRuntimeSchedulingForAccount("account"),
    ).resolves.toEqual({
      io_class: "standard",
      shared_compute_priority: 0,
      project_network: true,
    });
  });

  it("leaves it unset when the tier does not choose", async () => {
    resolveRuntimeMembershipMock.mockResolvedValue({
      class: "free",
      entitlements: { features: {}, usage_limits: {} },
    });
    const scheduling =
      await getMembershipRuntimeSchedulingForAccount("account");
    expect(scheduling).not.toHaveProperty("project_network");
  });
});
