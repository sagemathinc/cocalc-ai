/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetRememberMeHash = jest.fn();
const mockRequireFreshAuth = jest.fn();
const mockAssertNoImpersonation = jest.fn();
const mockDeleteAccount = jest.fn();
const mockClearAuthCookies = jest.fn();
const mockGetParams = jest.fn();
const mockUnlinkStrategy = jest.fn();
const mockSetEmailAddress = jest.fn();
const mockSetPassword = jest.fn();
const mockStartTwoFactorSetup = jest.fn();
const mockConfirmTwoFactorSetup = jest.fn();
const mockDisableTwoFactor = jest.fn();
const mockUserIsInGroup = jest.fn();
const mockBanUser = jest.fn();
const mockRemoveUserBan = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/auth/remember-me", () => ({
  getRememberMeHash: (...args: any[]) => mockGetRememberMeHash(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  requireFreshAuth: (...args: any[]) => mockRequireFreshAuth(...args),
}));

jest.mock("@cocalc/server/auth/impersonation", () => ({
  assertNoImpersonationForSubjectSecurityAction: (...args: any[]) =>
    mockAssertNoImpersonation(...args),
}));

jest.mock("@cocalc/server/accounts/delete", () => ({
  __esModule: true,
  default: (...args: any[]) => mockDeleteAccount(...args),
}));

jest.mock("@cocalc/server/auth/clear-auth-cookies", () => ({
  __esModule: true,
  default: (...args: any[]) => mockClearAuthCookies(...args),
}));

jest.mock("@cocalc/http-api/lib/api/get-params", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetParams(...args),
}));

jest.mock("@cocalc/server/auth/sso/unlink-strategy", () => ({
  __esModule: true,
  default: (...args: any[]) => mockUnlinkStrategy(...args),
}));

jest.mock("@cocalc/server/accounts/set-email-address", () => ({
  __esModule: true,
  default: (...args: any[]) => mockSetEmailAddress(...args),
}));

jest.mock("@cocalc/server/accounts/set-password", () => ({
  __esModule: true,
  default: (...args: any[]) => mockSetPassword(...args),
}));

jest.mock("@cocalc/server/auth/two-factor", () => ({
  startTwoFactorSetup: (...args: any[]) => mockStartTwoFactorSetup(...args),
  confirmTwoFactorSetup: (...args: any[]) => mockConfirmTwoFactorSetup(...args),
  disableTwoFactor: (...args: any[]) => mockDisableTwoFactor(...args),
}));

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: (...args: any[]) => mockUserIsInGroup(...args),
}));

jest.mock("@cocalc/server/accounts/ban", () => ({
  banUser: (...args: any[]) => mockBanUser(...args),
  removeUserBan: (...args: any[]) => mockRemoveUserBan(...args),
}));

describe("browser-session-only account security routes", () => {
  const originalDisableApiValidation =
    process.env.COCALC_DISABLE_API_VALIDATION;

  beforeAll(() => {
    process.env.COCALC_DISABLE_API_VALIDATION = "yes";
  });

  afterAll(() => {
    if (originalDisableApiValidation == null) {
      delete process.env.COCALC_DISABLE_API_VALIDATION;
    } else {
      process.env.COCALC_DISABLE_API_VALIDATION = originalDisableApiValidation;
    }
  });

  beforeEach(() => {
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetRememberMeHash.mockReset().mockReturnValue("remember-me-hash");
    mockRequireFreshAuth.mockReset().mockResolvedValue(undefined);
    mockAssertNoImpersonation.mockReset().mockResolvedValue(undefined);
    mockDeleteAccount.mockReset().mockResolvedValue(undefined);
    mockClearAuthCookies.mockReset().mockResolvedValue(undefined);
    mockGetParams.mockReset().mockReturnValue({ name: "github" });
    mockUnlinkStrategy.mockReset().mockResolvedValue(undefined);
    mockSetEmailAddress.mockReset().mockResolvedValue({
      email_address: "new@example.com",
      already_verified: false,
    });
    mockSetPassword.mockReset().mockResolvedValue(undefined);
    mockStartTwoFactorSetup.mockReset().mockResolvedValue({
      factor_id: "factor-1",
      secret: "secret",
      issuer: "CoCalc",
      account_label: "user@example.com",
      otpauth_url: "otpauth://totp/CoCalc:user@example.com?secret=secret",
    });
    mockConfirmTwoFactorSetup.mockReset().mockResolvedValue({
      recovery_codes: ["recovery-code"],
    });
    mockDisableTwoFactor.mockReset().mockResolvedValue(undefined);
    mockUserIsInGroup.mockReset().mockResolvedValue(true);
    mockBanUser.mockReset().mockResolvedValue(undefined);
    mockRemoveUserBan.mockReset().mockResolvedValue(undefined);
  });

  it("rejects API-key-only account deletion", async () => {
    mockGetRememberMeHash.mockReturnValue(undefined);
    const { req, res } = createMocks({
      method: "POST",
      headers: { authorization: "Bearer sk-cc-v2.key.secret" },
    });

    const { default: handler } = await import("./accounts/delete");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API keys are not allowed to delete accounts",
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockRequireFreshAuth).not.toHaveBeenCalled();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockClearAuthCookies).not.toHaveBeenCalled();
  });

  it("rejects account deletion without fresh auth", async () => {
    mockRequireFreshAuth.mockRejectedValue(new Error("fresh auth is required"));
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./accounts/delete");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "fresh auth is required",
    });
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockClearAuthCookies).not.toHaveBeenCalled();
  });

  it("allows browser-authenticated account deletion", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./accounts/delete");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "success" });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
    });
    expect(mockAssertNoImpersonation).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
      action: "delete the account",
    });
    expect(mockDeleteAccount).toHaveBeenCalledWith("acct-1");
    expect(mockClearAuthCookies).toHaveBeenCalledWith({ req, res });
  });

  it("rejects API-key-only SSO unlinking", async () => {
    mockGetRememberMeHash.mockReturnValue(undefined);
    const { req, res } = createMocks({
      method: "POST",
      headers: { authorization: "Bearer sk-cc-v2.key.secret" },
    });

    const { default: handler } = await import("./auth/unlink-strategy");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API keys are not allowed to unlink sign-in methods",
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockRequireFreshAuth).not.toHaveBeenCalled();
    expect(mockUnlinkStrategy).not.toHaveBeenCalled();
  });

  it("rejects SSO unlinking without fresh auth", async () => {
    mockRequireFreshAuth.mockRejectedValue(new Error("fresh auth is required"));
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./auth/unlink-strategy");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "fresh auth is required",
    });
    expect(mockUnlinkStrategy).not.toHaveBeenCalled();
  });

  it("allows browser-authenticated SSO unlinking", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./auth/unlink-strategy");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "ok" });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
    });
    expect(mockAssertNoImpersonation).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
      action: "unlink single sign-on",
    });
    expect(mockUnlinkStrategy).toHaveBeenCalledWith({
      account_id: "acct-1",
      name: "github",
    });
  });

  it("rejects email address changes without fresh auth", async () => {
    mockGetParams.mockReturnValue({
      email_address: "new@example.com",
      password: "correct horse battery staple",
    });
    mockRequireFreshAuth.mockRejectedValue(new Error("fresh auth is required"));
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./accounts/set-email-address");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "fresh auth is required",
    });
    expect(mockSetEmailAddress).not.toHaveBeenCalled();
  });

  it("rejects API-key-only email address changes before account resolution", async () => {
    mockGetParams.mockReturnValue({
      email_address: "new@example.com",
      password: "correct horse battery staple",
    });
    const { req, res } = createMocks({
      method: "POST",
      headers: { authorization: "Bearer sk-cc-v2.key.secret" },
    });

    const { default: handler } = await import("./accounts/set-email-address");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API keys are not allowed to change email addresses",
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockRequireFreshAuth).not.toHaveBeenCalled();
    expect(mockSetEmailAddress).not.toHaveBeenCalled();
  });

  it("allows fresh-authenticated email address changes", async () => {
    mockGetParams.mockReturnValue({
      email_address: "new@example.com",
      password: "correct horse battery staple",
    });
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./accounts/set-email-address");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      status: "success",
      email_address: "new@example.com",
      already_verified: false,
    });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
    });
    expect(mockSetEmailAddress).toHaveBeenCalledWith({
      account_id: "acct-1",
      email_address: "new@example.com",
      password: "correct horse battery staple",
    });
  });

  it("rejects password changes without fresh auth", async () => {
    mockGetParams.mockReturnValue({
      currentPassword: "old-password",
      newPassword: "new-password",
    });
    mockRequireFreshAuth.mockRejectedValue(new Error("fresh auth is required"));
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./accounts/set-password");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "fresh auth is required",
    });
    expect(mockSetPassword).not.toHaveBeenCalled();
  });

  it("rejects API-key-only password changes before account resolution", async () => {
    mockGetParams.mockReturnValue({
      currentPassword: "old-password",
      newPassword: "new-password",
    });
    const { req, res } = createMocks({
      method: "POST",
      headers: { authorization: "Bearer sk-cc-v2.key.secret" },
    });

    const { default: handler } = await import("./accounts/set-password");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API keys are not allowed to change passwords",
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockRequireFreshAuth).not.toHaveBeenCalled();
    expect(mockSetPassword).not.toHaveBeenCalled();
  });

  it("allows fresh-authenticated password changes", async () => {
    mockGetParams.mockReturnValue({
      currentPassword: "old-password",
      newPassword: "new-password",
    });
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./accounts/set-password");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "success" });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
    });
    expect(mockSetPassword).toHaveBeenCalledWith(
      "acct-1",
      "old-password",
      "new-password",
    );
  });

  it("rejects authenticator-app two-factor setup start without fresh auth", async () => {
    mockRequireFreshAuth.mockRejectedValue(new Error("fresh auth is required"));
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./auth/2fa/setup/start");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "fresh auth is required",
    });
    expect(mockStartTwoFactorSetup).not.toHaveBeenCalled();
  });

  it("allows fresh-authenticated authenticator-app two-factor setup start", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./auth/2fa/setup/start");
    await handler(req, res);

    expect(res._getJSONData()).toMatchObject({
      factor_id: "factor-1",
      secret: "secret",
    });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
    });
    expect(mockStartTwoFactorSetup).toHaveBeenCalledWith({
      account_id: "acct-1",
    });
  });

  it("rejects authenticator-app two-factor setup confirmation without fresh auth", async () => {
    mockGetParams.mockReturnValue({
      factor_id: "factor-1",
      code: "123456",
    });
    mockRequireFreshAuth.mockRejectedValue(new Error("fresh auth is required"));
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./auth/2fa/setup/confirm");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "fresh auth is required",
    });
    expect(mockConfirmTwoFactorSetup).not.toHaveBeenCalled();
  });

  it("allows fresh-authenticated authenticator-app two-factor setup confirmation", async () => {
    mockGetParams.mockReturnValue({
      factor_id: "factor-1",
      code: "123456",
    });
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./auth/2fa/setup/confirm");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      recovery_codes: ["recovery-code"],
    });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
    });
    expect(mockConfirmTwoFactorSetup).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
      factor_id: "factor-1",
      code: "123456",
    });
  });

  it("rejects API-key-only two-factor disable before account resolution", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { authorization: "Bearer sk-cc-v2.key.secret" },
    });

    const { default: handler } = await import("./auth/2fa/disable");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API keys are not allowed to disable two-factor authentication",
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockDisableTwoFactor).not.toHaveBeenCalled();
  });

  it("rejects admin account bans without fresh auth", async () => {
    mockGetParams.mockReturnValue({ account_id: "subject-1" });
    mockRequireFreshAuth.mockRejectedValue(new Error("fresh auth is required"));
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./accounts/ban");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "fresh auth is required",
    });
    expect(mockBanUser).not.toHaveBeenCalled();
  });

  it("allows fresh-authenticated admin account bans", async () => {
    mockGetParams.mockReturnValue({ account_id: "subject-1" });
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./accounts/ban");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "success" });
    expect(mockUserIsInGroup).toHaveBeenCalledWith("acct-1", "admin");
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
    });
    expect(mockBanUser).toHaveBeenCalledWith("subject-1");
  });

  it("rejects admin account unbans without fresh auth", async () => {
    mockGetParams.mockReturnValue({ account_id: "subject-1" });
    mockRequireFreshAuth.mockRejectedValue(new Error("fresh auth is required"));
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./accounts/remove-ban");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "fresh auth is required",
    });
    expect(mockRemoveUserBan).not.toHaveBeenCalled();
  });

  it("allows fresh-authenticated admin account unbans", async () => {
    mockGetParams.mockReturnValue({ account_id: "subject-1" });
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./accounts/remove-ban");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "success" });
    expect(mockUserIsInGroup).toHaveBeenCalledWith("acct-1", "admin");
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
    });
    expect(mockRemoveUserBan).toHaveBeenCalledWith("subject-1");
  });
});
