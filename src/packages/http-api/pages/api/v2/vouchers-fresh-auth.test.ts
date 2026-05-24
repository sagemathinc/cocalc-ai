/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetParams = jest.fn();
const mockRequireFreshAuth = jest.fn();
const mockGetTransactionClient = jest.fn();
const mockIsPurchaseAllowed = jest.fn();
const mockCreateVouchers = jest.fn();
const mockUserIsInGroup = jest.fn();
const mockChargeForUnpaidVouchers = jest.fn();

const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

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

jest.mock("@cocalc/database/pool", () => ({
  getTransactionClient: (...args: any[]) => mockGetTransactionClient(...args),
}));

jest.mock("@cocalc/server/purchases/is-purchase-allowed", () => ({
  isPurchaseAllowed: (...args: any[]) => mockIsPurchaseAllowed(...args),
}));

jest.mock("@cocalc/server/vouchers/create-vouchers", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCreateVouchers(...args),
}));

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: (...args: any[]) => mockUserIsInGroup(...args),
}));

jest.mock("@cocalc/server/vouchers/charge-for-unpaid-vouchers", () => ({
  __esModule: true,
  default: (...args: any[]) => mockChargeForUnpaidVouchers(...args),
}));

describe("voucher fresh auth", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetParams.mockReset().mockReturnValue({
      amount: 25,
      count: 2,
      title: "Course vouchers",
    });
    mockRequireFreshAuth.mockReset().mockResolvedValue(undefined);
    mockGetTransactionClient.mockReset().mockResolvedValue(mockClient);
    mockIsPurchaseAllowed.mockReset().mockResolvedValue({
      allowed: true,
      chargeAmount: 0,
    });
    mockCreateVouchers.mockReset().mockResolvedValue({
      id: 7,
      amount: 25,
      codes: ["AAA", "BBB"],
    });
    mockUserIsInGroup.mockReset().mockResolvedValue(true);
    mockChargeForUnpaidVouchers.mockReset().mockResolvedValue({
      7: {
        status: "ok",
        purchased: { quantity: 1, time: "2026-05-23T00:00:00.000Z" },
      },
    });
    mockClient.query.mockReset().mockResolvedValue(undefined);
    mockClient.release.mockReset();
  });

  it("rejects voucher creation before opening a transaction without fresh auth", async () => {
    mockRequireFreshAuth.mockRejectedValue(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./vouchers/create");
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
    expect(mockGetTransactionClient).not.toHaveBeenCalled();
    expect(mockCreateVouchers).not.toHaveBeenCalled();
  });

  it("creates vouchers after fresh auth", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./vouchers/create");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      id: 7,
      amount: 25,
      codes: ["AAA", "BBB"],
    });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
      allow_actor_impersonation: true,
    });
    expect(mockIsPurchaseAllowed).toHaveBeenCalledWith({
      account_id: "acct-1",
      client: mockClient,
      cost: 50,
      service: "voucher",
    });
    expect(mockCreateVouchers).toHaveBeenCalledWith({
      account_id: "acct-1",
      active: expect.any(Date),
      amount: 25,
      cancelBy: null,
      client: mockClient,
      expire: null,
      numVouchers: 2,
      title: "Course vouchers",
      whenPay: "now",
    });
    expect(mockClient.query).toHaveBeenCalledWith("COMMIT");
    expect(mockClient.release).toHaveBeenCalled();
  });

  it("requires fresh auth before charging unpaid expired vouchers", async () => {
    mockRequireFreshAuth.mockRejectedValue(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./vouchers/charge-for-unpaid-vouchers");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "fresh auth is required",
      code: "fresh_auth_required",
    });
    expect(mockUserIsInGroup).toHaveBeenCalledWith("acct-1", "admin");
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
      allow_actor_impersonation: true,
    });
    expect(mockChargeForUnpaidVouchers).not.toHaveBeenCalled();
  });

  it("charges unpaid expired vouchers after admin fresh auth", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./vouchers/charge-for-unpaid-vouchers");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      7: {
        status: "ok",
        purchased: { quantity: 1, time: "2026-05-23T00:00:00.000Z" },
      },
      success: true,
    });
    expect(mockUserIsInGroup).toHaveBeenCalledWith("acct-1", "admin");
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
      allow_actor_impersonation: true,
    });
    expect(mockChargeForUnpaidVouchers).toHaveBeenCalled();
  });
});
