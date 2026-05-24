/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetParams = jest.fn();
const mockUserIsInGroup = jest.fn();
const mockUserQuery = jest.fn();

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

jest.mock("@cocalc/database/user-query", () => ({
  __esModule: true,
  default: (...args) => mockUserQuery(...args),
}));

describe("/api/v2/accounts/set-name API-key scope", () => {
  const accountId = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue(accountId);
    mockGetParams.mockReset().mockReturnValue({
      first_name: "Ada",
      last_name: "Lovelace",
    });
    mockUserIsInGroup.mockReset().mockResolvedValue(false);
    mockUserQuery.mockReset().mockResolvedValue(undefined);
  });

  it("rejects API-key account-name edits before account resolution", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        Authorization: "Bearer cocalc_api_key_test",
        "content-type": "application/json",
      },
      body: {
        first_name: "Mallory",
      },
    });

    const { default: handler } = await import("./set-name");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API keys are not allowed to edit account names",
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockUserIsInGroup).not.toHaveBeenCalled();
    expect(mockUserQuery).not.toHaveBeenCalled();
  });

  it("keeps browser-session account-name edits", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {
        first_name: "Ada",
        last_name: "Lovelace",
      },
    });

    const { default: handler } = await import("./set-name");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "success" });
    expect(mockUserQuery).toHaveBeenCalledWith({
      account_id: accountId,
      query: {
        accounts: {
          first_name: "Ada",
          last_name: "Lovelace",
        },
      },
    });
  });
});
