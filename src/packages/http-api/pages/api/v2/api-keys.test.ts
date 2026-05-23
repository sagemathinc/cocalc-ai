/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockManageApiKeys = jest.fn();
const mockGetParams = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/api/manage", () => ({
  __esModule: true,
  default: (...args: any[]) => mockManageApiKeys(...args),
}));

jest.mock("@cocalc/http-api/lib/api/get-params", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetParams(...args),
}));

describe("/api/v2/api-keys", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockManageApiKeys.mockReset().mockResolvedValue([]);
    mockGetParams.mockReset().mockReturnValue({ action: "get" });
  });

  it("rejects API-key authentication for API-key management", async () => {
    const { req, res } = createMocks({
      method: "GET",
      headers: { authorization: "Bearer sk-cc-v2.key.secret" },
    });

    const { default: handler } = await import("./api-keys");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API keys cannot manage account API keys",
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockManageApiKeys).not.toHaveBeenCalled();
  });

  it("rejects legacy HTTP mutations so they cannot bypass fresh auth", async () => {
    mockGetParams.mockReturnValue({
      action: "create",
      name: "bypass",
      capabilities: ["account:read"],
    });
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./api-keys");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "legacy HTTP API key mutations are disabled",
    });
    expect(mockManageApiKeys).not.toHaveBeenCalled();
  });

  it("still allows cookie-authenticated API-key listing", async () => {
    const { req, res } = createMocks({ method: "GET" });

    const { default: handler } = await import("./api-keys");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ response: [] });
    expect(mockManageApiKeys).toHaveBeenCalledWith({
      account_id: "acct-1",
      action: "get",
      name: undefined,
      expire: undefined,
      capabilities: undefined,
      allowed_project_ids: undefined,
      id: undefined,
    });
  });
});
