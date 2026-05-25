/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const withAccountRehomeWriteFenceMock = jest.fn();
const deleteAllRememberMeMock = jest.fn();
const revokeAllAuthSessionsMock = jest.fn();
const recordAccountRevocationMock = jest.fn();
const recordAccountSecurityStateMock = jest.fn();
const clearIsBannedCacheMock = jest.fn();

jest.mock("@cocalc/server/accounts/rehome-fence", () => ({
  __esModule: true,
  withAccountRehomeWriteFence: (...args: any[]) =>
    withAccountRehomeWriteFenceMock(...args),
}));

jest.mock("@cocalc/server/auth/remember-me", () => ({
  __esModule: true,
  deleteAllRememberMe: (...args: any[]) => deleteAllRememberMeMock(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  __esModule: true,
  revokeAllAuthSessions: (...args: any[]) => revokeAllAuthSessionsMock(...args),
}));

jest.mock("@cocalc/server/accounts/revocation", () => ({
  __esModule: true,
  recordAccountRevocation: (...args: any[]) =>
    recordAccountRevocationMock(...args),
}));

jest.mock("@cocalc/server/accounts/security-state", () => ({
  __esModule: true,
  recordAccountSecurityState: (...args: any[]) =>
    recordAccountSecurityStateMock(...args),
}));

jest.mock("./is-banned", () => ({
  __esModule: true,
  clearIsBannedCache: (...args: any[]) => clearIsBannedCacheMock(...args),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

describe("account ban", () => {
  beforeEach(() => {
    jest.resetModules();
    withAccountRehomeWriteFenceMock.mockReset();
    deleteAllRememberMeMock.mockReset().mockResolvedValue(undefined);
    revokeAllAuthSessionsMock.mockReset().mockResolvedValue(undefined);
    recordAccountRevocationMock.mockReset().mockResolvedValue(undefined);
    recordAccountSecurityStateMock.mockReset().mockResolvedValue(undefined);
    clearIsBannedCacheMock.mockReset();
    withAccountRehomeWriteFenceMock.mockImplementation(async ({ fn }) => {
      await fn({
        query: jest.fn(async () => ({ rows: [], rowCount: 1 })),
      });
    });
  });

  it("invalidates active account credentials when banning", async () => {
    const calls: string[] = [];
    withAccountRehomeWriteFenceMock.mockImplementation(async ({ fn }) => {
      calls.push("mark-banned");
      await fn({
        query: jest.fn(async () => ({ rows: [], rowCount: 1 })),
      });
    });
    deleteAllRememberMeMock.mockImplementation(async () => {
      calls.push("delete-remember-me");
    });
    revokeAllAuthSessionsMock.mockImplementation(async () => {
      calls.push("revoke-auth-sessions");
    });
    recordAccountRevocationMock.mockImplementation(async () => {
      calls.push("record-host-revocation");
    });
    recordAccountSecurityStateMock.mockImplementation(async () => {
      calls.push("record-security-state");
    });

    const { banUser } = await import("./ban");
    await banUser(ACCOUNT_ID);

    expect(clearIsBannedCacheMock).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(deleteAllRememberMeMock).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(revokeAllAuthSessionsMock).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(recordAccountRevocationMock).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.any(Number),
      { banned: true },
    );
    expect(calls).toEqual([
      "mark-banned",
      "delete-remember-me",
      "revoke-auth-sessions",
      "record-host-revocation",
    ]);
  });

  it("clears ban cache when unbanning", async () => {
    const { removeUserBan } = await import("./ban");
    await removeUserBan(ACCOUNT_ID);

    expect(clearIsBannedCacheMock).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(deleteAllRememberMeMock).not.toHaveBeenCalled();
    expect(revokeAllAuthSessionsMock).not.toHaveBeenCalled();
    expect(recordAccountRevocationMock).not.toHaveBeenCalled();
    expect(recordAccountSecurityStateMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      banned: false,
    });
  });
});
