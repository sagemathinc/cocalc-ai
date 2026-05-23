/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetParams = jest.fn();
const mockRequireFreshAuth = jest.fn();
const mockSetPurchaseQuota = jest.fn();
const mockGetPurchaseQuotas = jest.fn();
const mockResetClosingDate = jest.fn();

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

jest.mock("@cocalc/server/purchases/purchase-quotas", () => ({
  setPurchaseQuota: (...args: any[]) => mockSetPurchaseQuota(...args),
  getPurchaseQuotas: (...args: any[]) => mockGetPurchaseQuotas(...args),
}));

jest.mock("@cocalc/server/purchases/reset-closing-date", () => ({
  __esModule: true,
  default: (...args: any[]) => mockResetClosingDate(...args),
}));

describe("spending-control fresh auth", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetParams
      .mockReset()
      .mockReturnValue({ service: "project-upgrade", value: "100" });
    mockRequireFreshAuth.mockReset().mockResolvedValue(undefined);
    mockSetPurchaseQuota.mockReset().mockResolvedValue(undefined);
    mockGetPurchaseQuotas.mockReset().mockResolvedValue({
      minBalance: 0,
      services: { "project-upgrade": 100 },
    });
    mockResetClosingDate.mockReset().mockResolvedValue(undefined);
  });

  it("requires fresh auth before changing a spending limit", async () => {
    mockRequireFreshAuth.mockRejectedValue(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./purchases/set-quota");
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
    expect(mockSetPurchaseQuota).not.toHaveBeenCalled();
  });

  it("requires fresh auth before resetting statement closing date", async () => {
    mockRequireFreshAuth.mockRejectedValue(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./purchases/reset-closing-date");
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
    expect(mockResetClosingDate).not.toHaveBeenCalled();
  });

  it("changes a spending limit after fresh auth", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./purchases/set-quota");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      minBalance: 0,
      services: { "project-upgrade": 100 },
    });
    expect(mockSetPurchaseQuota).toHaveBeenCalledWith({
      account_id: "acct-1",
      service: "project-upgrade",
      value: 100,
    });
  });

  it("resets statement closing date after fresh auth", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./purchases/reset-closing-date");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "ok" });
    expect(mockResetClosingDate).toHaveBeenCalledWith("acct-1");
  });
});
