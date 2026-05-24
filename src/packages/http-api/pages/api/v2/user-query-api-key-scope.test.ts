/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetParams = jest.fn();
const mockUserQuery = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/http-api/lib/api/get-params", () => ({
  __esModule: true,
  default: (...args) => mockGetParams(...args),
}));

jest.mock("@cocalc/database/user-query", () => ({
  __esModule: true,
  default: (...args) => mockUserQuery(...args),
}));

describe("user-query API-key scope", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetParams.mockReset().mockReturnValue({
      query: {
        accounts: {
          account_id: null,
          email_address: null,
        },
      },
    });
    mockUserQuery.mockReset().mockResolvedValue({
      accounts: {
        account_id: "acct-1",
        email_address: "user@example.com",
      },
    });
  });

  it("rejects API-key access before account resolution", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        Authorization: "Bearer cocalc_api_key_test",
        "content-type": "application/json",
      },
      body: {
        query: {
          accounts: {
            account_id: null,
            email_address: null,
          },
        },
      },
    });

    const { default: handler } = await import("./user-query");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API keys are not allowed to use user-query",
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockUserQuery).not.toHaveBeenCalled();
  });

  it("keeps browser-session user-query behavior", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {
        query: {
          accounts: {
            account_id: null,
            email_address: null,
          },
        },
      },
    });

    const { default: handler } = await import("./user-query");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      query: {
        accounts: {
          account_id: "acct-1",
          email_address: "user@example.com",
        },
      },
    });
    expect(mockUserQuery).toHaveBeenCalledWith({
      account_id: "acct-1",
      query: {
        accounts: {
          account_id: null,
          email_address: null,
        },
      },
    });
  });
});
