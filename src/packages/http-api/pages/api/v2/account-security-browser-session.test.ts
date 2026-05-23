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

describe("browser-session-only account security routes", () => {
  beforeEach(() => {
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetRememberMeHash.mockReset().mockReturnValue("remember-me-hash");
    mockRequireFreshAuth.mockReset().mockResolvedValue(undefined);
    mockAssertNoImpersonation.mockReset().mockResolvedValue(undefined);
    mockDeleteAccount.mockReset().mockResolvedValue(undefined);
    mockClearAuthCookies.mockReset().mockResolvedValue(undefined);
    mockGetParams.mockReset().mockReturnValue({ name: "github" });
    mockUnlinkStrategy.mockReset().mockResolvedValue(undefined);
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
      error: "browser sign-in is required",
    });
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
      error: "browser sign-in is required",
    });
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
});
