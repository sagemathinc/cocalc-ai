/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetParams = jest.fn();
const mockRequireFreshAuth = jest.fn();
const mockCancelSubscription = jest.fn();
const mockResumeSubscription = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/http-api/lib/api/get-params", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetParams(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  requireFreshAuth: (...args: any[]) => mockRequireFreshAuth(...args),
}));

jest.mock("@cocalc/server/purchases/cancel-subscription", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCancelSubscription(...args),
}));

jest.mock("@cocalc/server/purchases/resume-subscription", () => ({
  __esModule: true,
  default: (...args: any[]) => mockResumeSubscription(...args),
}));

describe("subscription state mutation fresh auth", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetParams
      .mockReset()
      .mockReturnValue({ subscription_id: 123, reason: "test" });
    mockRequireFreshAuth.mockReset().mockResolvedValue(undefined);
    mockCancelSubscription.mockReset().mockResolvedValue(undefined);
    mockResumeSubscription.mockReset().mockResolvedValue(undefined);
  });

  it("requires fresh auth before canceling a subscription", async () => {
    mockRequireFreshAuth.mockRejectedValue(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./purchases/cancel-subscription");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "fresh auth is required",
      code: "fresh_auth_required",
    });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
      allow_actor_impersonation: true,
    });
    expect(mockCancelSubscription).not.toHaveBeenCalled();
  });

  it("requires fresh auth before resuming a subscription", async () => {
    mockRequireFreshAuth.mockRejectedValue(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./purchases/resume-subscription");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "fresh auth is required",
      code: "fresh_auth_required",
    });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
      allow_actor_impersonation: true,
    });
    expect(mockResumeSubscription).not.toHaveBeenCalled();
  });

  it("allows canceling a subscription after fresh auth", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./purchases/cancel-subscription");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "ok" });
    expect(mockCancelSubscription).toHaveBeenCalledWith({
      account_id: "acct-1",
      subscription_id: 123,
      reason: "test",
    });
  });

  it("allows resuming a subscription after fresh auth", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./purchases/resume-subscription");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "ok" });
    expect(mockResumeSubscription).toHaveBeenCalledWith({
      account_id: "acct-1",
      subscription_id: 123,
    });
  });
});
