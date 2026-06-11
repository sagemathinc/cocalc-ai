/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetParams = jest.fn();
const mockGetCurrentAuthSession = jest.fn();
const mockRequireDangerousSessionAuth = jest.fn();
const mockUserIsInGroup = jest.fn();
const mockAdminPurchase = jest.fn();
const mockCreateRefund = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/http-api/lib/api/get-params", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetParams(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  getCurrentAuthSession: (...args: any[]) => mockGetCurrentAuthSession(...args),
}));

jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (...args: any[]) =>
    mockRequireDangerousSessionAuth(...args),
}));

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: (...args: any[]) => mockUserIsInGroup(...args),
}));

jest.mock("@cocalc/server/purchases/admin-purchase", () => ({
  __esModule: true,
  default: (...args: any[]) => mockAdminPurchase(...args),
}));

jest.mock("@cocalc/server/purchases/create-refund", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCreateRefund(...args),
}));

describe("admin purchase/refund fresh auth", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("admin-1");
    mockGetParams.mockReset().mockReturnValue({
      comment: "manual comp",
      interval: "month",
      membership_class: "member",
      price: 10,
      product: "membership",
      purchase_id: 123,
      reason: "requested_by_customer",
      source: "free",
      user_account_id: "user-1",
    });
    mockGetCurrentAuthSession.mockReset().mockResolvedValue({
      session_hash: "fresh-session-hash",
    });
    mockRequireDangerousSessionAuth.mockReset().mockResolvedValue(undefined);
    mockUserIsInGroup.mockReset().mockResolvedValue(true);
    mockAdminPurchase.mockReset().mockResolvedValue({ purchase_id: 456 });
    mockCreateRefund.mockReset().mockResolvedValue(789);
  });

  it("requires recent dangerous auth before admin-assisted purchase", async () => {
    mockRequireDangerousSessionAuth.mockRejectedValue(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./purchases/admin-purchase");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "fresh auth is required",
      code: "fresh_auth_required",
    });
    expect(mockRequireDangerousSessionAuth).toHaveBeenCalledWith({
      account_id: "admin-1",
      session_hash: "fresh-session-hash",
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
    expect(mockAdminPurchase).not.toHaveBeenCalled();
  });

  it("requires recent second factor before admin refund", async () => {
    mockRequireDangerousSessionAuth.mockRejectedValue(
      Object.assign(new Error("recent two-factor verification is required"), {
        code: "two_factor_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./purchases/create-refund");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "recent two-factor verification is required",
      code: "two_factor_required",
    });
    expect(mockRequireDangerousSessionAuth).toHaveBeenCalledWith({
      account_id: "admin-1",
      session_hash: "fresh-session-hash",
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
    expect(mockCreateRefund).not.toHaveBeenCalled();
  });

  it("allows admin-assisted purchase after fresh auth", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./purchases/admin-purchase");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ purchase_id: 456 });
    expect(mockRequireDangerousSessionAuth).toHaveBeenCalledWith({
      account_id: "admin-1",
      session_hash: "fresh-session-hash",
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
    expect(mockAdminPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        admin_account_id: "admin-1",
        user_account_id: "user-1",
      }),
    );
  });

  it("passes admin balance adjustment fields after fresh auth", async () => {
    mockGetParams.mockReturnValue({
      balance_admin_note: "support ticket 123",
      balance_user_note: "Goodwill credit",
      price: 25,
      product: "balance",
      source: "free",
      user_account_id: "user-1",
    });
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./purchases/admin-purchase");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ purchase_id: 456 });
    expect(mockAdminPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        admin_account_id: "admin-1",
        balance_admin_note: "support ticket 123",
        balance_user_note: "Goodwill credit",
        price: 25,
        product: "balance",
        user_account_id: "user-1",
      }),
    );
  });

  it("allows admin refund after fresh auth", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./purchases/create-refund");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ id: 789 });
    expect(mockRequireDangerousSessionAuth).toHaveBeenCalledWith({
      account_id: "admin-1",
      session_hash: "fresh-session-hash",
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
    expect(mockCreateRefund).toHaveBeenCalledWith({
      account_id: "admin-1",
      notes: undefined,
      purchase_id: 123,
      reason: "requested_by_customer",
    });
  });
});
