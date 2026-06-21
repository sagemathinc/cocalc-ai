/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockRecentAttempts = jest.fn();
const mockCreateReset = jest.fn();
const mockSendPasswordResetEmail = jest.fn();
const mockGetRequiresToken = jest.fn();
const mockGetClusterAccountByEmail = jest.fn();
const mockGetStrategies = jest.fn();
const mockRedeemPasswordReset = jest.fn();

jest.mock("@cocalc/server/auth/password-reset", () => ({
  recentAttempts: (...args) => mockRecentAttempts(...args),
  createReset: (...args) => mockCreateReset(...args),
}));

jest.mock("@cocalc/server/email/password-reset", () => ({
  __esModule: true,
  default: (...args) => mockSendPasswordResetEmail(...args),
}));

jest.mock("@cocalc/server/auth/tokens/get-requires-token", () => ({
  __esModule: true,
  default: (...args) => mockGetRequiresToken(...args),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountByEmail: (...args) => mockGetClusterAccountByEmail(...args),
}));

jest.mock("@cocalc/database/settings/get-sso-strategies", () => ({
  __esModule: true,
  default: (...args) => mockGetStrategies(...args),
}));

jest.mock("@cocalc/server/auth/redeem-password-reset", () => ({
  __esModule: true,
  default: (...args) => mockRedeemPasswordReset(...args),
}));

describe("/api/v2/auth/password-reset", () => {
  beforeEach(() => {
    mockRecentAttempts.mockReset().mockResolvedValue(0);
    mockCreateReset.mockReset().mockResolvedValue("reset-id");
    mockSendPasswordResetEmail.mockReset().mockResolvedValue(undefined);
    mockGetRequiresToken.mockReset().mockResolvedValue(false);
    mockGetClusterAccountByEmail.mockReset().mockResolvedValue({
      account_id: "00000000-0000-4000-8000-000000000001",
      email_address: "user@example.com",
      home_bay_id: "bay-0",
    });
    mockGetStrategies.mockReset().mockResolvedValue([]);
  });

  it("rejects non-POST password reset requests", async () => {
    const { req, res } = createMocks({
      method: "GET",
      url: "/api/v2/auth/password-reset",
      body: { email: "user@example.com" },
    });

    const { default: passwordReset } = await import("./password-reset");
    await passwordReset(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.getHeader("Allow")).toBe("POST");
    expect(res._getJSONData()).toEqual({ error: "method_not_allowed" });
    expect(mockCreateReset).not.toHaveBeenCalled();
    expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("does not issue password resets for SSO-required domains", async () => {
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
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/password-reset",
      body: { email: "user@example.com" },
    });

    const { default: passwordReset } = await import("./password-reset");
    await passwordReset(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      error: "Use Google single sign-on to access this account.",
    });
    expect(mockCreateReset).not.toHaveBeenCalled();
    expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
  });
});

describe("/api/v2/auth/redeem-password-reset", () => {
  beforeEach(() => {
    mockRedeemPasswordReset
      .mockReset()
      .mockResolvedValue("00000000-0000-4000-8000-000000000001");
  });

  it("rejects non-POST password reset redemption", async () => {
    const { req, res } = createMocks({
      method: "GET",
      url: "/api/v2/auth/redeem-password-reset",
      body: {
        password: "correct horse battery staple 12345!",
        passwordResetId: "reset-id",
      },
    });

    const { default: redeemPasswordReset } =
      await import("./redeem-password-reset");
    await redeemPasswordReset(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.getHeader("Allow")).toBe("POST");
    expect(res._getJSONData()).toEqual({ error: "method_not_allowed" });
    expect(mockRedeemPasswordReset).not.toHaveBeenCalled();
  });

  it("resets the password without signing the browser in", async () => {
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/redeem-password-reset",
      body: {
        password: "correct horse battery staple 12345!",
        passwordResetId: "reset-id",
      },
    });

    const { default: redeemPasswordReset } =
      await import("./redeem-password-reset");
    await redeemPasswordReset(req, res);

    expect(mockRedeemPasswordReset).toHaveBeenCalledWith(
      "correct horse battery staple 12345!",
      "reset-id",
    );
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      success:
        "Password reset successfully. Please sign in with your new password.",
    });
  });
});
