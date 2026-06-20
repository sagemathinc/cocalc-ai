/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const isAccountBannedCachedMock = jest.fn();

jest.mock("@cocalc/server/accounts/security-state", () => ({
  __esModule: true,
  isAccountBannedCached: (...args: any[]) => isAccountBannedCachedMock(...args),
  startAccountSecurityStateSyncLoop: jest.fn(),
}));

jest.mock("./ai-sessions", () => ({
  __esModule: true,
  interrupt: jest.fn(),
  interruptAll: jest.fn(),
  list: jest.fn(),
  upsertProjectHostSession: jest.fn(),
}));

describe("hub conat api banned account enforcement", () => {
  const account_id = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    isAccountBannedCachedMock.mockReset();
  });

  it("rejects account-scoped API requests from an already-connected banned account", async () => {
    isAccountBannedCachedMock.mockReturnValue(true);
    const { handleApiRequest } = await import("./index");
    const respond = jest.fn(async () => undefined);

    await handleApiRequest({
      request: {
        name: "system.ping",
        args: [],
      },
      mesg: {
        subject: `hub.account.${account_id}.api`,
        respond,
      },
    });

    expect(isAccountBannedCachedMock).toHaveBeenCalledWith(account_id);
    expect(respond).toHaveBeenCalledWith(null, {
      headers: {
        error: "account is banned",
        error_attrs: { code: 403, subject: undefined },
      },
    });
  });
});
