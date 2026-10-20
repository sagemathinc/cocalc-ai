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
          sagebrush_sync_enabled: true,
          sagebrush_sync_version_bytes: 7,
          sagebrush_sync_read_bytes_per_day: 300,
          sagebrush_sync_retention_days: 30,
        },
      }),
    );
    expect(await getSagebrushLimits(ACCOUNT)).toEqual({
      tier: "pro",
      storage_bytes: 100,
      max_file_bytes: 10,
      private_links: true,
      sync: {
        enabled: true,
        version_bytes: 7,
        read_bytes_per_day: 300,
        retention_days: 30,
      },
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
      sync: {
        enabled: false,
        version_bytes: 100_000_000,
        read_bytes_per_day: 2_000_000_000,
        retention_days: 90,
      },
    });
  });

  it("never answers a sync value Sagebrush can't read: it uses the fallback's", async () => {
    mockGetOAuthAccountState.mockResolvedValue(
      live({
        class: "custom",
        effective_limits: {
          sagebrush_sync_enabled: "yes",
          sagebrush_sync_version_bytes: Number.MAX_SAFE_INTEGER + 1,
          sagebrush_sync_read_bytes_per_day: 1e20,
          sagebrush_sync_retention_days: 1.5,
        },
      }),
    );
    expect((await getSagebrushLimits(ACCOUNT))?.sync).toEqual({
      enabled: false,
      version_bytes: 100_000_000,
      read_bytes_per_day: 2_000_000_000,
      retention_days: 90,
    });
    mockGetOAuthAccountState.mockResolvedValue(
      live({
        class: "custom",
        effective_limits: {
          sagebrush_sync_version_bytes: Number.MAX_SAFE_INTEGER,
          sagebrush_sync_read_bytes_per_day: 0,
        },
      }),
    );
    const sync = (await getSagebrushLimits(ACCOUNT))?.sync;
    expect(sync?.version_bytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(sync?.read_bytes_per_day).toBe(0);
  });

  it("never answers a storage limit Sagebrush can't read: it uses the fallback's", async () => {
    mockGetOAuthAccountState.mockResolvedValue(
      live({
        class: "custom",
        effective_limits: {
          sagebrush_storage_bytes: 1e20,
          sagebrush_max_file_bytes: 2.5,
          sagebrush_private_links: "yes",
        },
      }),
    );
    const limits = await getSagebrushLimits(ACCOUNT);
    expect(limits?.storage_bytes).toBe(1_000_000_000);
    expect(limits?.max_file_bytes).toBe(100_000_000);
    expect(limits?.private_links).toBe(false);
  });

  it("always answers the sync block, off for a tier that turns sync off", async () => {
    mockGetOAuthAccountState.mockResolvedValue(
      live({
        class: "basic",
        effective_limits: {
          sagebrush_storage_bytes: 5,
          sagebrush_sync_enabled: false,
        },
      }),
    );
    const limits = await getSagebrushLimits(ACCOUNT);
    expect(limits?.sync.enabled).toBe(false);
    expect(Object.keys(limits?.sync ?? {}).sort()).toEqual([
      "enabled",
      "read_bytes_per_day",
      "retention_days",
      "version_bytes",
    ]);
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
