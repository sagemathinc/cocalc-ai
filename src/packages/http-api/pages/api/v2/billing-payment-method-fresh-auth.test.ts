/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockRequireFreshAuth = jest.fn();
const mockGetParams = jest.fn();
const mockCreatePaymentMethod = jest.fn();
const mockDeletePaymentMethod = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  requireFreshAuth: (...args: any[]) => mockRequireFreshAuth(...args),
}));

jest.mock("@cocalc/http-api/lib/api/get-params", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetParams(...args),
}));

jest.mock("@cocalc/server/billing/create-payment-method", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCreatePaymentMethod(...args),
}));

jest.mock("@cocalc/server/billing/delete-payment-method", () => ({
  __esModule: true,
  default: (...args: any[]) => mockDeletePaymentMethod(...args),
}));

describe("legacy billing payment method routes", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockRequireFreshAuth.mockReset().mockResolvedValue(undefined);
    mockGetParams.mockReset().mockReturnValue({ id: "pm_123" });
    mockCreatePaymentMethod.mockReset().mockResolvedValue(undefined);
    mockDeletePaymentMethod.mockReset().mockResolvedValue(undefined);
  });

  it("requires fresh auth before creating a payment method", async () => {
    mockRequireFreshAuth.mockRejectedValue(new Error("fresh auth is required"));
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./billing/create-payment-method");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ error: "fresh auth is required" });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
      allow_actor_impersonation: true,
    });
    expect(mockCreatePaymentMethod).not.toHaveBeenCalled();
  });

  it("creates a payment method after fresh auth", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./billing/create-payment-method");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ success: true });
    expect(mockCreatePaymentMethod).toHaveBeenCalledWith("acct-1", "pm_123");
  });

  it("requires fresh auth before deleting a payment method", async () => {
    mockRequireFreshAuth.mockRejectedValue(new Error("fresh auth is required"));
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./billing/delete-payment-method");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ error: "fresh auth is required" });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
      allow_actor_impersonation: true,
    });
    expect(mockDeletePaymentMethod).not.toHaveBeenCalled();
  });

  it("deletes a payment method after fresh auth", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./billing/delete-payment-method");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ success: true });
    expect(mockDeletePaymentMethod).toHaveBeenCalledWith("acct-1", "pm_123");
  });
});
