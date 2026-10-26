/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const withAccountRehomeWriteFenceMock = jest.fn();
const endAllSignInSessionsMock = jest.fn();
const recordAccountRevocationMock = jest.fn();
const recordAccountSecurityStateMock = jest.fn();
const clearIsBannedCacheMock = jest.fn();
const stopRunningProjectsForBannedAccountMock = jest.fn();
const ensureAccountBanTimestampSchemaMock = jest.fn();

jest.mock("./ban-timestamp", () => ({
  __esModule: true,
  ensureAccountBanTimestampSchema: (...args: any[]) =>
    ensureAccountBanTimestampSchemaMock(...args),
}));

jest.mock("@cocalc/server/accounts/rehome-fence", () => ({
  __esModule: true,
  withAccountRehomeWriteFence: (...args: any[]) =>
    withAccountRehomeWriteFenceMock(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  __esModule: true,
  endAllSignInSessions: (...args: any[]) => endAllSignInSessionsMock(...args),
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

jest.mock("./stop-banned-projects", () => ({
  __esModule: true,
  stopRunningProjectsForBannedAccount: (...args: any[]) =>
    stopRunningProjectsForBannedAccountMock(...args),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

describe("account ban", () => {
  beforeEach(() => {
    jest.resetModules();
    withAccountRehomeWriteFenceMock.mockReset();
    endAllSignInSessionsMock.mockReset().mockResolvedValue(undefined);
    recordAccountRevocationMock.mockReset().mockResolvedValue(undefined);
    recordAccountSecurityStateMock.mockReset().mockResolvedValue(undefined);
    clearIsBannedCacheMock.mockReset();
    stopRunningProjectsForBannedAccountMock
      .mockReset()
      .mockResolvedValue({ stopped: 0, failed: 0, total: 0 });
    ensureAccountBanTimestampSchemaMock
      .mockReset()
      .mockResolvedValue(undefined);
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
    endAllSignInSessionsMock.mockImplementation(async () => {
      calls.push("end-sign-in-sessions");
    });
    recordAccountRevocationMock.mockImplementation(async () => {
      calls.push("record-host-revocation");
    });
    stopRunningProjectsForBannedAccountMock.mockImplementation(async () => {
      calls.push("stop-running-projects");
    });
    recordAccountSecurityStateMock.mockImplementation(async () => {
      calls.push("record-security-state");
    });

    const { banUser } = await import("./ban");
    await banUser(ACCOUNT_ID);

    expect(clearIsBannedCacheMock).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(endAllSignInSessionsMock).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(recordAccountRevocationMock).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.any(Number),
      { banned: true },
    );
    expect(stopRunningProjectsForBannedAccountMock).toHaveBeenCalledWith(
      ACCOUNT_ID,
    );
    expect(calls).toEqual([
      "mark-banned",
      "end-sign-in-sessions",
      "record-host-revocation",
      "stop-running-projects",
    ]);
  });

  it("clears ban cache when unbanning", async () => {
    const { removeUserBan } = await import("./ban");
    await removeUserBan(ACCOUNT_ID);

    expect(clearIsBannedCacheMock).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(endAllSignInSessionsMock).not.toHaveBeenCalled();
    expect(recordAccountRevocationMock).not.toHaveBeenCalled();
    expect(stopRunningProjectsForBannedAccountMock).not.toHaveBeenCalled();
    expect(recordAccountSecurityStateMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      banned: false,
    });
  });
});
