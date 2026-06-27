/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getHubApiAdmissionDecision,
  getHubApiLowPriorityMaximum,
  getHubApiReservedCapacity,
  isLowPriorityHubApiMethod,
} from "./admission";

describe("hub api admission", () => {
  it("classifies account usage polling as low priority", () => {
    expect(isLowPriorityHubApiMethod("purchases.getMembershipDetails")).toBe(
      true,
    );
    expect(isLowPriorityHubApiMethod("purchases.getAccountUsageOverview")).toBe(
      true,
    );
    expect(isLowPriorityHubApiMethod("purchases.getManagedEgressHistory")).toBe(
      true,
    );
    expect(
      isLowPriorityHubApiMethod("purchases.getManagedEgressAdminOverview"),
    ).toBe(true);
    expect(
      isLowPriorityHubApiMethod("purchases.getManagedEgressAdminHistory"),
    ).toBe(true);
    expect(isLowPriorityHubApiMethod("purchases.getAIUsage")).toBe(true);
    expect(isLowPriorityHubApiMethod("db.userQuery")).toBe(false);
  });

  it("reserves capacity from low-priority calls", () => {
    expect(getHubApiReservedCapacity(200)).toBe(40);
    expect(getHubApiLowPriorityMaximum(200)).toBe(160);

    expect(
      getHubApiAdmissionDecision({
        active: 160,
        maximum: 200,
        key: "purchases.getMembershipDetails",
      }),
    ).toMatchObject({
      allowed: false,
      source: "hub-api-low-priority",
      maximum: 160,
    });

    expect(
      getHubApiAdmissionDecision({
        active: 160,
        maximum: 200,
        key: "db.userQuery",
      }),
    ).toMatchObject({
      allowed: true,
      source: "hub-api",
      maximum: 200,
    });
  });

  it("still enforces the hard cap for ordinary calls", () => {
    expect(
      getHubApiAdmissionDecision({
        active: 200,
        maximum: 200,
        key: "db.userQuery",
      }),
    ).toMatchObject({
      allowed: false,
      source: "hub-api",
      maximum: 200,
    });
  });
});
