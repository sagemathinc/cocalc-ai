/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockGetOAuthAccountState = jest.fn();
jest.mock("@cocalc/server/auth/oauth/account-state", () => ({
  getOAuthAccountState: (...args: any[]) => mockGetOAuthAccountState(...args),
}));

import { getSagebrushLimits } from "./limits";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";

function live(membership: any) {
  return {
    state: "live",
    email_address: "ada@example.com",
    email_verified: true,
    display_name: "Ada",
    membership,
  };
}

describe("getSagebrushLimits", () => {
  beforeEach(() => mockGetOAuthAccountState.mockReset());

  it("reads the limits from the tier, resolved on the home bay with the account check", async () => {
    mockGetOAuthAccountState.mockResolvedValue(
      live({
        class: "pro",
        effective_limits: {
          sagebrush_storage_bytes: 100,
          sagebrush_max_file_bytes: 10,
          sagebrush_private_links: true,
        },
      }),
    );
    expect(await getSagebrushLimits(ACCOUNT)).toEqual({
      tier: "pro",
      storage_bytes: 100,
      max_file_bytes: 10,
      private_links: true,
    });
    expect(mockGetOAuthAccountState).toHaveBeenCalledWith(ACCOUNT, {
      include_membership: true,
    });
  });

  it("falls back to the free tier's values for a tier that sets none", async () => {
    mockGetOAuthAccountState.mockResolvedValue(
      live({ class: "custom", effective_limits: {} }),
    );
    expect(await getSagebrushLimits(ACCOUNT)).toEqual({
      tier: "custom",
      storage_bytes: 1_000_000_000,
      max_file_bytes: 100_000_000,
      private_links: false,
    });
  });

  it("has no limits for an account its home bay reports missing", async () => {
    mockGetOAuthAccountState.mockResolvedValue({ state: "missing" });
    expect(await getSagebrushLimits(ACCOUNT)).toBeUndefined();
  });

  it("fails, rather than reporting no account, when the home bay can't say", async () => {
    mockGetOAuthAccountState.mockRejectedValue(
      new Error("home bay is changing"),
    );
    await expect(getSagebrushLimits(ACCOUNT)).rejects.toThrow("changing");
  });
});
