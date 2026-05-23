/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let isAdminMock: jest.Mock;
let requireDangerousSessionAuthMock: jest.Mock;

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("./dangerous-session-auth", () => ({
  __esModule: true,
  requireDangerousSessionAuth: (...args: any[]) =>
    requireDangerousSessionAuthMock(...args),
}));

describe("site settings dangerous-session auth", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    isAdminMock = jest.fn(async () => true);
    requireDangerousSessionAuthMock = jest.fn(async () => {
      throw Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      });
    });
  });

  it("requires recent 2FA fresh auth before global site settings changes", async () => {
    const { setSiteSettings } = await import("./system");

    await expect(
      setSiteSettings({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        settings: [],
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: true,
    });
  });
});
