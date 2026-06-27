/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetParams = jest.fn();
const mockGetRememberMeHash = jest.fn();
const mockRequireFreshAuth = jest.fn();
const mockApproveCliLoginChallenge = jest.fn();
const mockVerifyHomeBayRetryToken = jest.fn();
const mockGetClusterAccountById = jest.fn();
const mockIssueHomeBayRetryToken = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/http-api/lib/api/get-params", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetParams(...args),
}));

jest.mock("@cocalc/server/auth/remember-me", () => ({
  getRememberMeHash: (...args: any[]) => mockGetRememberMeHash(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  requireFreshAuth: (...args: any[]) => mockRequireFreshAuth(...args),
}));

jest.mock("@cocalc/server/auth/cli-auth", () => ({
  approveCliLoginChallenge: (...args: any[]) =>
    mockApproveCliLoginChallenge(...args),
}));

jest.mock("@cocalc/server/auth/home-bay-retry-token", () => ({
  issueHomeBayRetryToken: (...args: any[]) =>
    mockIssueHomeBayRetryToken(...args),
  verifyHomeBayRetryToken: (...args: any[]) =>
    mockVerifyHomeBayRetryToken(...args),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: (...args: any[]) => mockGetClusterAccountById(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-2",
}));

describe("/api/v2/auth/cli/login/approve fresh auth", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetParams.mockReset().mockReturnValue({ challenge_id: "challenge-1" });
    mockGetRememberMeHash.mockReset().mockReturnValue("session-hash");
    mockRequireFreshAuth.mockReset().mockResolvedValue(undefined);
    mockApproveCliLoginChallenge
      .mockReset()
      .mockResolvedValue({ approved: true });
    mockVerifyHomeBayRetryToken.mockReset().mockReturnValue({
      account_id: "acct-remote",
      home_bay_id: "bay-2",
      purpose: "cli-login",
      challenge_id: "challenge-1",
    });
    mockGetClusterAccountById.mockReset().mockResolvedValue({
      account_id: "acct-remote",
      home_bay_id: "bay-2",
    });
    mockIssueHomeBayRetryToken.mockReset().mockReturnValue({
      token: "approval-token",
      expires_at: 123456,
    });
  });

  it("requires fresh auth before approving a CLI login", async () => {
    mockRequireFreshAuth.mockRejectedValue(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./auth/cli/login/approve");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "fresh auth is required",
      code: "fresh_auth_required",
    });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
    });
    expect(mockApproveCliLoginChallenge).not.toHaveBeenCalled();
  });

  it("approves a CLI login after fresh auth", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./auth/cli/login/approve");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ approved: true });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
    });
    expect(mockApproveCliLoginChallenge).toHaveBeenCalledWith({
      challenge_id: "challenge-1",
      account_id: "acct-1",
    });
  });

  it("approves a remote-home CLI login with a signed approval token", async () => {
    mockGetParams.mockReturnValue({
      challenge_id: "challenge-1",
      approval_token: "approval-token",
      approval_home_bay_id: "bay-2",
    });
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./auth/cli/login/approve");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ approved: true });
    expect(mockVerifyHomeBayRetryToken).toHaveBeenCalledWith({
      token: "approval-token",
      home_bay_id: "bay-2",
      challenge_id: "challenge-1",
      purpose: "cli-login",
    });
    expect(mockRequireFreshAuth).not.toHaveBeenCalled();
    expect(mockApproveCliLoginChallenge).toHaveBeenCalledWith({
      challenge_id: "challenge-1",
      account_id: "acct-remote",
    });
  });
});

describe("/api/v2/auth/cli/login/approval-token", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-remote");
    mockGetParams.mockReset().mockReturnValue({ challenge_id: "challenge-1" });
    mockGetRememberMeHash.mockReset().mockReturnValue("session-hash");
    mockRequireFreshAuth.mockReset().mockResolvedValue(undefined);
    mockGetClusterAccountById.mockReset().mockResolvedValue({
      account_id: "acct-remote",
      home_bay_id: "bay-2",
    });
    mockIssueHomeBayRetryToken.mockReset().mockReturnValue({
      token: "approval-token",
      expires_at: 123456,
    });
  });

  it("issues a fresh-auth-protected CLI login approval token on the home bay", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./auth/cli/login/approval-token");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      token: "approval-token",
      expires_at: 123456,
      account_id: "acct-remote",
      home_bay_id: "bay-2",
    });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-remote",
    });
    expect(mockIssueHomeBayRetryToken).toHaveBeenCalledWith({
      account_id: "acct-remote",
      challenge_id: "challenge-1",
      home_bay_id: "bay-2",
      purpose: "cli-login",
      ttl_seconds: 5 * 60,
    });
  });
});
