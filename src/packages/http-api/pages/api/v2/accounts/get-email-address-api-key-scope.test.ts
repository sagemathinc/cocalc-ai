/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetAccountFromApiKey = jest.fn();
const mockGetEmailAddress = jest.fn();
const mockGetParams = jest.fn();
const mockUserIsInGroup = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/auth/api", () => ({
  getAccountFromApiKey: (...args) => mockGetAccountFromApiKey(...args),
}));

jest.mock("@cocalc/server/accounts/get-email-address", () => ({
  __esModule: true,
  default: (...args) => mockGetEmailAddress(...args),
}));

jest.mock("@cocalc/http-api/lib/api/get-params", () => ({
  __esModule: true,
  default: (...args) => mockGetParams(...args),
}));

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: (...args) => mockUserIsInGroup(...args),
}));

describe("/api/v2/accounts/get-email-address API-key scope", () => {
  const target_account_id = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("admin-1");
    mockGetAccountFromApiKey.mockReset().mockResolvedValue({
      account_id: "admin-1",
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["account:read"],
      allowed_project_ids: [],
    });
    mockGetParams
      .mockReset()
      .mockReturnValue({ account_id: target_account_id });
    mockUserIsInGroup
      .mockReset()
      .mockImplementation(async (_account, group) => {
        return group === "admin";
      });
    mockGetEmailAddress.mockReset().mockResolvedValue("user@example.com");
  });

  it("requires account read capability for API-key privileged email lookup", async () => {
    mockGetAccountFromApiKey.mockResolvedValue({
      account_id: "admin-1",
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["project:list"],
      allowed_project_ids: [],
    });
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        Authorization: "Bearer cocalc_api_key_test",
        "Content-Type": "application/json",
      },
      body: { account_id: target_account_id },
    });

    const { default: handler } = await import("./get-email-address");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API key lacks required capability 'account:read'",
    });
    expect(mockUserIsInGroup).not.toHaveBeenCalled();
    expect(mockGetEmailAddress).not.toHaveBeenCalled();
  });

  it("allows API-key privileged email lookup with account read capability", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        Authorization: "Bearer cocalc_api_key_test",
        "Content-Type": "application/json",
      },
      body: { account_id: target_account_id },
    });

    const { default: handler } = await import("./get-email-address");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      email_address: "user@example.com",
    });
    expect(mockUserIsInGroup).toHaveBeenCalledWith("admin-1", "partner");
    expect(mockUserIsInGroup).toHaveBeenCalledWith("admin-1", "admin");
    expect(mockGetEmailAddress).toHaveBeenCalledWith(target_account_id);
  });

  it("keeps browser-session privileged email lookup behavior", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { account_id: target_account_id },
    });

    const { default: handler } = await import("./get-email-address");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      email_address: "user@example.com",
    });
    expect(mockGetAccountFromApiKey).not.toHaveBeenCalled();
    expect(mockGetEmailAddress).toHaveBeenCalledWith(target_account_id);
  });
});
