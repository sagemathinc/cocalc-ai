/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetParams = jest.fn();
const mockGetBalance = jest.fn();
const mockGetPurchases = jest.fn();
const mockGetStatements = jest.fn();
const mockGetSubscriptions = jest.fn();
const mockGetLiveSubscriptions = jest.fn();
const mockGetUnpaidInvoices = jest.fn();
const mockGetChargesThisMonthByService = jest.fn();
const mockThrottle = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/http-api/lib/api/get-params", () => ({
  __esModule: true,
  default: (...args) => mockGetParams(...args),
}));

jest.mock("@cocalc/util/api/throttle", () => ({
  __esModule: true,
  default: (...args) => mockThrottle(...args),
}));

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(false),
}));

jest.mock("@cocalc/server/purchases/get-balance", () => ({
  __esModule: true,
  default: (...args) => mockGetBalance(...args),
}));

jest.mock("@cocalc/server/purchases/get-purchases", () => ({
  __esModule: true,
  default: (...args) => mockGetPurchases(...args),
}));

jest.mock("@cocalc/server/purchases/statements/get-statements", () => ({
  __esModule: true,
  default: (...args) => mockGetStatements(...args),
}));

jest.mock("@cocalc/server/purchases/get-subscriptions", () => ({
  __esModule: true,
  default: (...args) => mockGetSubscriptions(...args),
}));

jest.mock("@cocalc/server/purchases/get-live-subscriptions", () => ({
  __esModule: true,
  default: (...args) => mockGetLiveSubscriptions(...args),
}));

jest.mock("@cocalc/server/purchases/get-unpaid-invoices", () => ({
  __esModule: true,
  default: (...args) => mockGetUnpaidInvoices(...args),
}));

jest.mock("@cocalc/server/purchases/get-charges", () => ({
  getChargesThisMonthByService: (...args) =>
    mockGetChargesThisMonthByService(...args),
}));

describe("billing account read routes API-key scope", () => {
  const denied = {
    error: "API keys are not allowed to access billing account details",
  };

  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetParams
      .mockReset()
      .mockReturnValue({ interval: "month", limit: 10, offset: 0 });
    mockGetBalance.mockReset().mockResolvedValue({ balance: 12 });
    mockGetPurchases.mockReset().mockResolvedValue({ purchases: [] });
    mockGetStatements.mockReset().mockResolvedValue({ statements: [] });
    mockGetSubscriptions.mockReset().mockResolvedValue({ subscriptions: [] });
    mockGetLiveSubscriptions.mockReset().mockResolvedValue([]);
    mockGetUnpaidInvoices.mockReset().mockResolvedValue([]);
    mockGetChargesThisMonthByService.mockReset().mockResolvedValue({});
    mockThrottle.mockReset();
  });

  it.each([
    ["./purchases/get-balance", mockGetBalance],
    ["./purchases/get-purchases", mockGetPurchases],
    ["./purchases/get-statements", mockGetStatements],
    ["./purchases/get-subscriptions", mockGetSubscriptions],
    ["./purchases/get-live-subscriptions", mockGetLiveSubscriptions],
    ["./purchases/get-unpaid-invoices", mockGetUnpaidInvoices],
    ["./purchases/get-charges-by-service", mockGetChargesThisMonthByService],
  ])("rejects API-key access to %s", async (modulePath, backendCall) => {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        Authorization: "Bearer cocalc_api_key_test",
        "content-type": "application/json",
      },
      body: { interval: "month" },
    });

    const { default: handler } = await import(modulePath);
    await handler(req, res);

    expect(res._getJSONData()).toEqual(denied);
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockThrottle).not.toHaveBeenCalled();
    expect(backendCall).not.toHaveBeenCalled();
  });

  it("keeps browser-session balance reads", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: {},
    });

    const { default: handler } = await import("./purchases/get-balance");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ balance: 12 });
    expect(mockGetBalance).toHaveBeenCalledWith({ account_id: "acct-1" });
  });
});
