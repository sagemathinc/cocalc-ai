/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const poolQueryMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: poolQueryMock }),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

describe("account security state cache", () => {
  beforeEach(() => {
    jest.resetModules();
    poolQueryMock.mockReset();
  });

  it("updates the in-memory cache when recording local ban state", async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          banned: true,
          revoked_before_ms: 1000,
          updated_ms: 2000,
        },
      ],
    });
    const {
      isAccountBannedCached,
      getAccountRevokedBeforeCached,
      recordAccountSecurityState,
    } = await import("./security-state");

    await recordAccountSecurityState({
      account_id: ACCOUNT_ID,
      banned: true,
      revoked_before_ms: 1000,
    });

    expect(isAccountBannedCached(ACCOUNT_ID)).toBe(true);
    expect(getAccountRevokedBeforeCached(ACCOUNT_ID)).toBe(1000);
  });

  it("syncs account security state deltas into the in-memory cache", async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          account_id: ACCOUNT_ID,
          banned: true,
          revoked_before_ms: null,
          updated_ms: 3000,
        },
      ],
    });
    const { isAccountBannedCached, syncAccountSecurityStateOnce } =
      await import("./security-state");

    await expect(syncAccountSecurityStateOnce()).resolves.toBe(1);

    expect(isAccountBannedCached(ACCOUNT_ID)).toBe(true);
  });
});
