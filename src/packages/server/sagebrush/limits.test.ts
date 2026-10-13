/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockGetClusterAccountById = jest.fn();
const mockResolveMembership = jest.fn();
const mockRemoteGetMembership = jest.fn();
const mockCreateClient = jest.fn((_opts: any) => ({
  getMembership: mockRemoteGetMembership,
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: (...args: any[]) => mockGetClusterAccountById(...args),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "fabric",
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: (opts: any) => mockCreateClient(opts),
}));
jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipForAccount: (...args: any[]) =>
    mockResolveMembership(...args),
}));

import { getSagebrushLimits } from "./limits";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";

describe("getSagebrushLimits", () => {
  beforeEach(() => {
    mockGetClusterAccountById.mockReset();
    mockResolveMembership.mockReset();
    mockRemoteGetMembership.mockReset();
    mockCreateClient.mockClear();
  });

  it("reads the limits from the tier on the local home bay", async () => {
    mockGetClusterAccountById.mockResolvedValue({
      account_id: ACCOUNT,
      home_bay_id: "bay-0",
    });
    mockResolveMembership.mockResolvedValue({
      class: "pro",
      effective_limits: {
        sagebrush_storage_bytes: 100,
        sagebrush_max_file_bytes: 10,
        sagebrush_private_links: true,
      },
    });
    expect(await getSagebrushLimits(ACCOUNT)).toEqual({
      tier: "pro",
      storage_bytes: 100,
      max_file_bytes: 10,
      private_links: true,
    });
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("asks the home bay for an account homed elsewhere", async () => {
    mockGetClusterAccountById.mockResolvedValue({
      account_id: ACCOUNT,
      home_bay_id: "bay-2",
    });
    mockRemoteGetMembership.mockResolvedValue({
      class: "standard",
      effective_limits: {
        sagebrush_storage_bytes: 7,
        sagebrush_max_file_bytes: 3,
        sagebrush_private_links: false,
      },
    });
    expect(await getSagebrushLimits(ACCOUNT)).toMatchObject({
      tier: "standard",
      storage_bytes: 7,
    });
    expect(mockCreateClient).toHaveBeenCalledWith({
      client: "fabric",
      dest_bay: "bay-2",
    });
    expect(mockRemoteGetMembership).toHaveBeenCalledWith({
      account_id: ACCOUNT,
    });
    expect(mockResolveMembership).not.toHaveBeenCalled();
  });

  it("falls back to the free tier's values for a tier that sets none", async () => {
    mockGetClusterAccountById.mockResolvedValue({
      account_id: ACCOUNT,
      home_bay_id: "bay-0",
    });
    mockResolveMembership.mockResolvedValue({
      class: "custom",
      effective_limits: {},
    });
    expect(await getSagebrushLimits(ACCOUNT)).toEqual({
      tier: "custom",
      storage_bytes: 1_000_000_000,
      max_file_bytes: 100_000_000,
      private_links: false,
    });
  });

  it("has no limits for unknown, deleted or banned accounts", async () => {
    mockGetClusterAccountById.mockResolvedValue(null);
    expect(await getSagebrushLimits(ACCOUNT)).toBeUndefined();
    mockGetClusterAccountById.mockResolvedValue({
      account_id: ACCOUNT,
      banned: true,
    });
    expect(await getSagebrushLimits(ACCOUNT)).toBeUndefined();
    expect(await getSagebrushLimits("not-a-uuid")).toBeUndefined();
    expect(mockResolveMembership).not.toHaveBeenCalled();
  });
});
