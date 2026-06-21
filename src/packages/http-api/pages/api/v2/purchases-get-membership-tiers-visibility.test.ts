/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockUserIsInGroup = jest.fn();
const mockGetMembershipTiers = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: (...args: any[]) => mockUserIsInGroup(...args),
}));

jest.mock("@cocalc/server/membership/tiers", () => ({
  getMembershipTiers: (...args: any[]) => mockGetMembershipTiers(...args),
}));

jest.mock("@cocalc/util/membership-tier-presentation", () => ({
  buildMembershipTierPresentation: (tier: { id: string }) => ({
    heading: tier.id,
  }),
}));

const tiers = [
  {
    id: "store",
    label: "Store",
    store_visible: true,
    team_visible: false,
    course_store_visible: false,
    disabled: false,
  },
  {
    id: "team",
    label: "Team",
    store_visible: false,
    team_visible: true,
    course_store_visible: false,
    disabled: false,
  },
  {
    id: "course",
    label: "Course",
    store_visible: false,
    team_visible: false,
    course_store_visible: true,
    disabled: false,
  },
  {
    id: "private",
    label: "Private",
    store_visible: false,
    team_visible: false,
    course_store_visible: false,
    disabled: false,
  },
  {
    id: "disabled",
    label: "Disabled",
    store_visible: true,
    team_visible: false,
    course_store_visible: false,
    disabled: true,
  },
];

describe("get-membership-tiers visibility", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue(undefined);
    mockUserIsInGroup.mockReset().mockResolvedValue(false);
    mockGetMembershipTiers
      .mockReset()
      .mockImplementation(async ({ includeDisabled }) =>
        includeDisabled ? tiers : tiers.filter((tier) => !tier.disabled),
      );
  });

  it("only returns visible enabled tiers to public callers", async () => {
    const { req, res } = createMocks({ method: "GET" });

    const { default: handler } =
      await import("./purchases/get-membership-tiers");
    await handler(req, res);

    expect(mockGetMembershipTiers).toHaveBeenCalledWith({
      includeDisabled: false,
    });
    expect(mockUserIsInGroup).not.toHaveBeenCalled();
    expect(res._getJSONData().tiers.map((tier) => tier.id)).toEqual([
      "store",
      "team",
      "course",
    ]);
  });

  it("returns non-disabled tiers to signed-in non-admin callers", async () => {
    mockGetAccountId.mockResolvedValue("user-1");
    const { req, res } = createMocks({ method: "GET" });

    const { default: handler } =
      await import("./purchases/get-membership-tiers");
    await handler(req, res);

    expect(mockUserIsInGroup).toHaveBeenCalledWith("user-1", "admin");
    expect(mockGetMembershipTiers).toHaveBeenCalledWith({
      includeDisabled: false,
    });
    expect(res._getJSONData().tiers.map((tier) => tier.id)).toEqual([
      "store",
      "team",
      "course",
      "private",
    ]);
  });

  it("returns all tiers to admin callers", async () => {
    mockGetAccountId.mockResolvedValue("admin-1");
    mockUserIsInGroup.mockResolvedValue(true);
    const { req, res } = createMocks({ method: "GET" });

    const { default: handler } =
      await import("./purchases/get-membership-tiers");
    await handler(req, res);

    expect(mockGetMembershipTiers).toHaveBeenCalledWith({
      includeDisabled: true,
    });
    expect(res._getJSONData().tiers.map((tier) => tier.id)).toEqual([
      "store",
      "team",
      "course",
      "private",
      "disabled",
    ]);
  });
});
