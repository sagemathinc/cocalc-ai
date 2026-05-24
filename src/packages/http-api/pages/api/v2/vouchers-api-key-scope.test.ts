/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetParams = jest.fn();
const mockGetVoucherCodes = jest.fn();
const mockGetRecentlyCreatedVouchers = jest.fn();
const mockSetVoucherCodeNotes = jest.fn();
const mockRedeemVoucher = jest.fn();
const mockRequireFreshAuth = jest.fn();
const mockGetTransactionClient = jest.fn();
const mockIsPurchaseAllowed = jest.fn();
const mockCreateVouchers = jest.fn();
const mockUserIsInGroup = jest.fn();
const mockChargeForUnpaidVouchers = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/http-api/lib/api/get-params", () => ({
  __esModule: true,
  default: (...args) => mockGetParams(...args),
}));

jest.mock("@cocalc/server/vouchers/get-voucher-codes", () => ({
  __esModule: true,
  default: (...args) => mockGetVoucherCodes(...args),
}));

jest.mock("@cocalc/server/vouchers/recent-vouchers", () => ({
  __esModule: true,
  default: (...args) => mockGetRecentlyCreatedVouchers(...args),
}));

jest.mock("@cocalc/server/vouchers/set-voucher-code-notes", () => ({
  __esModule: true,
  default: (...args) => mockSetVoucherCodeNotes(...args),
}));

jest.mock("@cocalc/server/vouchers/redeem", () => ({
  __esModule: true,
  default: (...args) => mockRedeemVoucher(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  requireFreshAuth: (...args) => mockRequireFreshAuth(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  getTransactionClient: (...args) => mockGetTransactionClient(...args),
}));

jest.mock("@cocalc/server/purchases/is-purchase-allowed", () => ({
  isPurchaseAllowed: (...args) => mockIsPurchaseAllowed(...args),
}));

jest.mock("@cocalc/server/vouchers/create-vouchers", () => ({
  __esModule: true,
  default: (...args) => mockCreateVouchers(...args),
}));

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: (...args) => mockUserIsInGroup(...args),
}));

jest.mock("@cocalc/server/vouchers/charge-for-unpaid-vouchers", () => ({
  __esModule: true,
  default: (...args) => mockChargeForUnpaidVouchers(...args),
}));

describe("voucher management API-key scope", () => {
  const denied = {
    error: "API keys are not allowed to manage voucher codes",
  };
  const createDenied = {
    error: "API keys are not allowed to create voucher codes",
  };
  const redeemDenied = {
    error: "API keys are not allowed to redeem voucher codes",
  };

  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetParams.mockReset().mockReturnValue({
      id: "voucher-1",
      code: "CODE-123456",
      notes: "issued to student",
      recent: "1 week",
    });
    mockGetVoucherCodes.mockReset().mockResolvedValue([
      {
        code: "CODE-123456",
        notes: "issued to student",
      },
    ]);
    mockGetRecentlyCreatedVouchers.mockReset().mockResolvedValue([
      {
        id: "voucher-1",
        title: "Course vouchers",
        count: 1,
      },
    ]);
    mockSetVoucherCodeNotes.mockReset().mockResolvedValue(undefined);
    mockRedeemVoucher.mockReset().mockResolvedValue([
      {
        type: "cash",
        amount: 25,
        purchase_id: 10,
      },
    ]);
    mockRequireFreshAuth.mockReset().mockResolvedValue(undefined);
    mockGetTransactionClient.mockReset().mockResolvedValue({
      query: jest.fn(),
      release: jest.fn(),
    });
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
    mockChargeForUnpaidVouchers.mockReset().mockResolvedValue({});
  });

  it.each([
    ["./vouchers/get-voucher-codes", mockGetVoucherCodes],
    ["./vouchers/recent-vouchers", mockGetRecentlyCreatedVouchers],
    ["./vouchers/set-voucher-code-notes", mockSetVoucherCodeNotes],
  ])("rejects API-key access to %s", async (modulePath, backendCall) => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: {},
    });

    const { default: handler } = await import(modulePath);
    await handler(req, res);

    expect(res._getJSONData()).toEqual(denied);
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(backendCall).not.toHaveBeenCalled();
  });

  it("rejects API-key voucher redemption before account resolution", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: { code: "CODE-123456" },
    });

    const { default: handler } = await import("./vouchers/redeem");
    await handler(req, res);

    expect(res._getJSONData()).toEqual(redeemDenied);
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockRedeemVoucher).not.toHaveBeenCalled();
  });

  it("rejects API-key voucher creation before account resolution or fresh auth", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: { amount: 25, count: 2, title: "Course vouchers" },
    });

    const { default: handler } = await import("./vouchers/create");
    await handler(req, res);

    expect(res._getJSONData()).toEqual(createDenied);
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockRequireFreshAuth).not.toHaveBeenCalled();
    expect(mockGetTransactionClient).not.toHaveBeenCalled();
    expect(mockCreateVouchers).not.toHaveBeenCalled();
  });

  it("rejects API-key unpaid-voucher charging before account resolution", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
    });

    const { default: handler } =
      await import("./vouchers/charge-for-unpaid-vouchers");
    await handler(req, res);

    expect(res._getJSONData()).toEqual(denied);
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockUserIsInGroup).not.toHaveBeenCalled();
    expect(mockRequireFreshAuth).not.toHaveBeenCalled();
    expect(mockChargeForUnpaidVouchers).not.toHaveBeenCalled();
  });

  it("keeps browser-session voucher redemption", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { code: "CODE-123456" },
    });

    const { default: handler } = await import("./vouchers/redeem");
    await handler(req, res);

    expect(res._getJSONData()).toEqual([
      {
        type: "cash",
        amount: 25,
        purchase_id: 10,
      },
    ]);
    expect(mockRedeemVoucher).toHaveBeenCalledWith({
      account_id: "acct-1",
      code: "CODE-123456",
    });
  });

  it("keeps browser-session voucher-code retrieval", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { id: "voucher-1" },
    });

    const { default: handler } = await import("./vouchers/get-voucher-codes");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      codes: [
        {
          code: "CODE-123456",
          notes: "issued to student",
        },
      ],
      success: true,
    });
    expect(mockGetVoucherCodes).toHaveBeenCalledWith({
      account_id: "acct-1",
      id: "voucher-1",
    });
  });
});
