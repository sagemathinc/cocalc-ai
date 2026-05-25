/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetParams = jest.fn();
const mockUserIsInGroup = jest.fn();
const mockEditNews = jest.fn();
const mockClearNewsCache = jest.fn();
const mockGetNewsItem = jest.fn();
const mockGetAdminNewsIndex = jest.fn();
const mockGetMoneyData = jest.fn();
const mockGetBalance = jest.fn();
const mockGetPurchases = jest.fn();
const mockThrottle = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/http-api/lib/api/get-params", () => ({
  __esModule: true,
  default: (...args) => mockGetParams(...args),
}));

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: (...args) => mockUserIsInGroup(...args),
}));

jest.mock("@cocalc/server/news/edit", () => ({
  __esModule: true,
  default: (...args) => mockEditNews(...args),
}));

jest.mock("@cocalc/database/postgres/news", () => ({
  clearCache: (...args) => mockClearNewsCache(...args),
  getAdminIndex: (...args) => mockGetAdminNewsIndex(...args),
  getNewsItem: (...args) => mockGetNewsItem(...args),
}));

jest.mock("@cocalc/server/salesloft/money", () => ({
  getMoneyData: (...args) => mockGetMoneyData(...args),
}));

jest.mock("@cocalc/server/purchases/get-balance", () => ({
  __esModule: true,
  default: (...args) => mockGetBalance(...args),
}));

jest.mock("@cocalc/server/purchases/get-purchases", () => ({
  __esModule: true,
  default: (...args) => mockGetPurchases(...args),
}));

jest.mock("@cocalc/util/api/throttle", () => ({
  __esModule: true,
  default: (...args) => mockThrottle(...args),
}));

describe("admin HTTP routes API-key scope", () => {
  const denied = {
    error: "API keys are not allowed to use admin HTTP API routes",
  };

  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("admin-acct");
    mockGetParams.mockReset().mockReturnValue({
      account_id: "user-acct",
      id: 1,
      text: "body",
      title: "title",
    });
    mockUserIsInGroup.mockReset().mockResolvedValue(true);
    mockEditNews.mockReset().mockResolvedValue({ id: 1 });
    mockClearNewsCache.mockReset();
    mockGetNewsItem.mockReset().mockResolvedValue({ id: 1 });
    mockGetAdminNewsIndex.mockReset().mockResolvedValue([]);
    mockGetMoneyData.mockReset().mockResolvedValue({});
    mockGetBalance.mockReset().mockResolvedValue({ balance: 0 });
    mockGetPurchases.mockReset().mockResolvedValue({ purchases: [] });
    mockThrottle.mockReset();
  });

  it.each([
    ["./news/edit", mockEditNews],
    ["./news/admin-get", mockGetNewsItem],
    ["./news/admin-list", mockGetAdminNewsIndex],
    ["./salesloft/money", mockGetMoneyData],
    ["./purchases/get-balance-admin", mockGetBalance],
    ["./purchases/get-purchases-admin", mockGetPurchases],
  ])("rejects API-key access to %s", async (modulePath, backendCall) => {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        Authorization: "Bearer cocalc_api_key_test",
        "content-type": "application/json",
      },
      body: {
        account_id: "user-acct",
        id: 1,
        text: "body",
        title: "title",
      },
    });

    const { default: handler } = await import(modulePath);
    await handler(req, res);

    expect(res._getJSONData()).toEqual(denied);
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockUserIsInGroup).not.toHaveBeenCalled();
    expect(mockThrottle).not.toHaveBeenCalled();
    expect(backendCall).not.toHaveBeenCalled();
  });
});
