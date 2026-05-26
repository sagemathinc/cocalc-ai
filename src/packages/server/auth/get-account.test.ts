/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let queryMock: jest.Mock;
let ensureAccountSecurityStateReadyMock: jest.Mock;
let isAccountBannedCachedMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: (...args: any[]) =>
    ensureAccountSecurityStateReadyMock(...args),
  isAccountBannedCached: (...args: any[]) => isAccountBannedCachedMock(...args),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/server/auth/api", () => ({
  getAccountFromApiKey: jest.fn(async () => undefined),
}));

describe("auth/get-account remember_me ban enforcement", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    ensureAccountSecurityStateReadyMock = jest.fn(async () => undefined);
    isAccountBannedCachedMock = jest.fn(() => false);
    queryMock = jest.fn(async () => ({
      rows: [
        {
          account_id: ACCOUNT_ID,
          expire: new Date("2999-01-01T00:00:00Z"),
        },
      ],
    }));
  });

  it("rejects remember_me cookies for accounts banned in the replicated security cache", async () => {
    isAccountBannedCachedMock = jest.fn(() => true);
    const { getAccountIdFromRememberMe } = await import("./get-account");

    await expect(
      getAccountIdFromRememberMe("remember-me-hash"),
    ).resolves.toBeUndefined();

    expect(ensureAccountSecurityStateReadyMock).toHaveBeenCalled();
    expect(isAccountBannedCachedMock).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it("accepts an unexpired remember_me cookie when the replicated security cache allows it", async () => {
    const { getAccountIdFromRememberMe } = await import("./get-account");

    await expect(getAccountIdFromRememberMe("remember-me-hash")).resolves.toBe(
      ACCOUNT_ID,
    );

    expect(ensureAccountSecurityStateReadyMock).toHaveBeenCalled();
    expect(isAccountBannedCachedMock).toHaveBeenCalledWith(ACCOUNT_ID);
  });
});
