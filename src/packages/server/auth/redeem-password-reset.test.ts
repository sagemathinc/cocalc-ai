/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockRedeemReset = jest.fn();
const mockSetClusterAccountPasswordFromReset = jest.fn();
const mockGetStrategies = jest.fn();

jest.mock("@cocalc/server/auth/password-reset", () => ({
  redeemReset: (...args) => mockRedeemReset(...args),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  setClusterAccountPasswordFromReset: (...args) =>
    mockSetClusterAccountPasswordFromReset(...args),
}));

jest.mock("@cocalc/database/settings/get-sso-strategies", () => ({
  __esModule: true,
  default: (...args) => mockGetStrategies(...args),
}));

describe("redeemPasswordReset", () => {
  beforeEach(() => {
    jest.resetModules();
    mockRedeemReset.mockReset().mockResolvedValue({
      account_id: "00000000-0000-4000-8000-000000000001",
      email_address: "user@example.com",
      home_bay_id: "bay-0",
    });
    mockSetClusterAccountPasswordFromReset
      .mockReset()
      .mockResolvedValue(undefined);
    mockGetStrategies.mockReset().mockResolvedValue([]);
  });

  it("does not set a password when SSO is required for the reset email", async () => {
    mockGetStrategies.mockResolvedValue([
      {
        name: "google",
        display: "Google",
        backgroundColor: "#fff",
        public: true,
        exclusiveDomains: ["example.com"],
        doNotHide: false,
      },
    ]);

    const { default: redeemPasswordReset } =
      await import("./redeem-password-reset");

    await expect(
      redeemPasswordReset("correct horse battery staple 12345!", "reset-id"),
    ).rejects.toThrow("Use Google single sign-on to access this account.");
    expect(mockSetClusterAccountPasswordFromReset).not.toHaveBeenCalled();
  });
});
