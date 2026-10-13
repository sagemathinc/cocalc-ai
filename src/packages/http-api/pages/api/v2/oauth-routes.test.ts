/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

// HTTP behavior of the OAuth token endpoint and the Sagebrush limits
// endpoint, as specified in docs/sagebrush.md.

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

let mockSettings: Record<string, unknown> = {};
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => mockSettings,
}));
const mockGetSagebrushLimits = jest.fn();
jest.mock("@cocalc/server/sagebrush/limits", () => ({
  getSagebrushLimits: (...args: any[]) => mockGetSagebrushLimits(...args),
}));
const mockGetAccountId = jest.fn();
jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: jest.fn(),
}));
jest.mock("@cocalc/server/auth/impersonation", () => ({
  assertNoImpersonationForSubjectSecurityAction: jest.fn(),
}));

const BASIC = `Basic ${Buffer.from("sagebrush:client-secret").toString("base64")}`;
const ACCOUNT = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  mockSettings = { sagebrush_client_secret: "client-secret" };
  mockGetSagebrushLimits.mockReset();
  mockGetAccountId.mockReset();
});

describe("POST /api/v2/auth/oauth/token", () => {
  async function post(body: object, authorization?: string) {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(authorization ? { authorization } : {}),
      },
      body,
    });
    const { default: handler } = await import("./auth/oauth/token");
    await handler(req, res);
    return res;
  }

  it("answers 401 invalid_client without the right client secret", async () => {
    for (const authorization of [
      undefined,
      `Basic ${Buffer.from("sagebrush:wrong").toString("base64")}`,
      "Bearer cocalc_api_key",
    ]) {
      const res = await post(
        { grant_type: "authorization_code" },
        authorization,
      );
      expect(res._getStatusCode()).toBe(401);
      expect(res._getJSONData()).toEqual({ error: "invalid_client" });
      expect(res.getHeader("Cache-Control")).toBe("no-store");
    }
  });

  it("answers 401 while the client is turned off", async () => {
    mockSettings = { sagebrush_client_secret: "" };
    const res = await post({ grant_type: "authorization_code" }, BASIC);
    expect(res._getStatusCode()).toBe(401);
  });

  it("answers 400 for a bad grant type or missing parameters", async () => {
    let res = await post({ grant_type: "password" }, BASIC);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ error: "unsupported_grant_type" });
    res = await post({ grant_type: "authorization_code" }, BASIC);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ error: "invalid_request" });
  });

  it("only accepts POST", async () => {
    const { req, res } = createMocks({ method: "GET" });
    const { default: handler } = await import("./auth/oauth/token");
    await handler(req, res);
    expect(res._getStatusCode()).toBe(405);
  });
});

describe("GET /api/v2/sagebrush/limits", () => {
  async function get(query: object, authorization?: string, method = "GET") {
    const { req, res } = createMocks({
      method,
      query,
      headers: authorization ? { authorization } : {},
    });
    const { default: handler } = await import("./sagebrush/limits");
    await handler(req, res);
    return res;
  }

  it("returns the limits", async () => {
    mockGetSagebrushLimits.mockResolvedValue({
      tier: "free",
      storage_bytes: 1,
      max_file_bytes: 2,
      private_links: false,
    });
    const res = await get({ account_id: ACCOUNT }, BASIC);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      tier: "free",
      storage_bytes: 1,
      max_file_bytes: 2,
      private_links: false,
    });
    expect(mockGetSagebrushLimits).toHaveBeenCalledWith(ACCOUNT);
  });

  it("answers 404 no_account for an unknown, deleted or banned account", async () => {
    mockGetSagebrushLimits.mockResolvedValue(undefined);
    const res = await get({ account_id: ACCOUNT }, BASIC);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).toEqual({ error: "no_account" });
  });

  it("answers 401 without the client secret, before looking anything up", async () => {
    const res = await get({ account_id: ACCOUNT });
    expect(res._getStatusCode()).toBe(401);
    expect(res._getJSONData()).toEqual({ error: "invalid_client" });
    expect(mockGetSagebrushLimits).not.toHaveBeenCalled();
  });

  it("answers 500, not a zero quota, when the lookup fails", async () => {
    mockGetSagebrushLimits.mockRejectedValue(new Error("bay unreachable"));
    const res = await get({ account_id: ACCOUNT }, BASIC);
    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData()).toEqual({ error: "server_error" });
  });

  it("answers 400 without an account id and 405 for POST", async () => {
    expect((await get({}, BASIC))._getStatusCode()).toBe(400);
    expect(
      (await get({ account_id: ACCOUNT }, BASIC, "POST"))._getStatusCode(),
    ).toBe(405);
  });
});

describe("browser OAuth endpoints refuse API keys", () => {
  it.each([
    "./auth/oauth/authorize-info",
    "./auth/oauth/approval-token",
    "./auth/oauth/approve",
    "./accounts/oauth-client-approvals",
  ])("%s", async (modulePath) => {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        authorization: "Bearer cocalc_api_key_test",
        "content-type": "application/json",
      },
      body: {},
    });
    const { default: handler } = await import(modulePath);
    await handler(req, res);
    expect(res._getJSONData().error).toMatch(/API keys are not allowed/);
    expect(mockGetAccountId).not.toHaveBeenCalled();
  });
});
