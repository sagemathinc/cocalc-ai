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
});
