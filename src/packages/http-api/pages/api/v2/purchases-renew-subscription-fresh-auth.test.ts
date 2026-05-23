/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetParams = jest.fn();
const mockRequireFreshAuth = jest.fn();
const mockRenewSubscription = jest.fn();

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

jest.mock("@cocalc/server/purchases/renew-subscription", () => ({
  __esModule: true,
  default: (...args: any[]) => mockRenewSubscription(...args),
}));

describe("purchase subscription renewal fresh auth", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetParams.mockReset().mockReturnValue({ subscription_id: 123 });
    mockRequireFreshAuth.mockReset().mockResolvedValue(undefined);
    mockRenewSubscription.mockReset().mockResolvedValue(456);
  });

  it("requires fresh auth before renewing a subscription from balance", async () => {
    mockRequireFreshAuth.mockRejectedValue(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./purchases/renew-subscription");
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
    expect(mockRenewSubscription).not.toHaveBeenCalled();
  });

  it("renews a subscription after fresh auth", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./purchases/renew-subscription");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ purchase_id: 456 });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
      allow_actor_impersonation: true,
    });
    expect(mockRenewSubscription).toHaveBeenCalledWith({
      account_id: "acct-1",
      subscription_id: 123,
    });
  });
});
