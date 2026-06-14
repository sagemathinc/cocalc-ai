/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetAccountFromApiKey = jest.fn();
const mockGetParams = jest.fn();
const mockGetProfile = jest.fn();
const mockGetPrivateProfile = jest.fn();
const mockGetNames = jest.fn();
const mockValidateGetNamesAccountIds = jest.fn();
const mockHasPassword = jest.fn();
const mockGetCliAuthApprovalInfo = jest.fn();
const mockGetClusterAccountById = jest.fn();
const mockGetBayPublicOriginForRequest = jest.fn();
const mockGetConfiguredBayId = jest.fn();
const mockGetImpersonationBootstrapInfo = jest.fn();
const mockGetServerSettings = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/auth/get-account", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/auth/api", () => ({
  getAccountFromApiKey: (...args: any[]) => mockGetAccountFromApiKey(...args),
}));

jest.mock("@cocalc/http-api/lib/api/get-params", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetParams(...args),
}));

jest.mock("@cocalc/server/accounts/profile/get", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetProfile(...args),
}));

jest.mock("@cocalc/server/accounts/profile/private", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetPrivateProfile(...args),
}));

jest.mock("@cocalc/server/accounts/get-name", () => ({
  getNames: (...args: any[]) => mockGetNames(...args),
  validateGetNamesAccountIds: (...args: any[]) =>
    mockValidateGetNamesAccountIds(...args),
}));

jest.mock("@cocalc/server/auth/has-password", () => ({
  __esModule: true,
  default: (...args: any[]) => mockHasPassword(...args),
}));

jest.mock("@cocalc/server/auth/cli-auth", () => ({
  getCliAuthApprovalInfo: (...args: any[]) =>
    mockGetCliAuthApprovalInfo(...args),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: (...args: any[]) => mockGetClusterAccountById(...args),
}));

jest.mock("@cocalc/server/bay-public-origin", () => ({
  getBayPublicOriginForRequest: (...args: any[]) =>
    mockGetBayPublicOriginForRequest(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: (...args: any[]) => mockGetConfiguredBayId(...args),
}));

jest.mock("@cocalc/server/auth/impersonation", () => ({
  getImpersonationBootstrapInfo: (...args: any[]) =>
    mockGetImpersonationBootstrapInfo(...args),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => mockGetServerSettings(...args),
}));

function apiKeyPrincipal(capabilities: string[]) {
  return {
    account_id: "acct-1",
    api_key_id: 1,
    key_id: "key-1",
    auth_method: "api_key",
    capabilities,
    allowed_project_ids: [],
  };
}

function apiKeyMocks(body: object = {}) {
  return createMocks({
    method: "POST",
    headers: {
      Authorization: "Bearer cocalc_api_key_test",
      "content-type": "application/json",
    },
    body,
  });
}

describe("previously unclassified API-key route scope", () => {
  const originalDisableApiValidation =
    process.env.COCALC_DISABLE_API_VALIDATION;

  beforeAll(() => {
    process.env.COCALC_DISABLE_API_VALIDATION = "yes";
  });

  afterAll(() => {
    if (originalDisableApiValidation == null) {
      delete process.env.COCALC_DISABLE_API_VALIDATION;
    } else {
      process.env.COCALC_DISABLE_API_VALIDATION = originalDisableApiValidation;
    }
  });

  beforeEach(() => {
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetAccountFromApiKey
      .mockReset()
      .mockResolvedValue(apiKeyPrincipal(["account:read"]));
    mockGetParams.mockReset().mockReturnValue({
      account_ids: ["acct-2"],
      challenge_id: "challenge-1",
    });
    mockGetProfile.mockReset().mockResolvedValue({
      account_id: "acct-2",
      display_name: "Public User",
    });
    mockGetPrivateProfile.mockReset().mockResolvedValue({
      account_id: "acct-1",
      display_name: "Private User",
      email_address: "user@example.com",
    });
    mockValidateGetNamesAccountIds.mockReset().mockReturnValue(["acct-2"]);
    mockGetNames.mockReset().mockResolvedValue({
      "acct-2": { display_name: "Public User" },
    });
    mockHasPassword.mockReset().mockResolvedValue(true);
    mockGetCliAuthApprovalInfo.mockReset().mockResolvedValue({
      kind: "login",
      account_id: "acct-1",
    });
    mockGetClusterAccountById.mockReset().mockResolvedValue({
      account_id: "acct-1",
      email_address: "user@example.com",
      first_name: "Ada",
      last_name: "Lovelace",
      home_bay_id: "bay-1",
    });
    mockGetBayPublicOriginForRequest
      .mockReset()
      .mockResolvedValue("https://bay.example.com");
    mockGetConfiguredBayId.mockReset().mockReturnValue("bay-1");
    mockGetImpersonationBootstrapInfo.mockReset().mockResolvedValue(null);
    mockGetServerSettings.mockReset().mockResolvedValue({
      stripe_publishable_key: "pk_test",
    });
  });

  it("requires account:read for API-key private profile lookup", async () => {
    mockGetAccountFromApiKey.mockResolvedValue(
      apiKeyPrincipal(["project:list"]),
    );
    const { req, res } = apiKeyMocks({});

    const { default: handler } = await import("./accounts/profile");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API key lacks required capability 'account:read'",
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockGetPrivateProfile).not.toHaveBeenCalled();
  });

  it("allows account:read API keys to read their private profile", async () => {
    const { req, res } = apiKeyMocks({});

    const { default: handler } = await import("./accounts/profile");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      profile: {
        account_id: "acct-1",
        display_name: "Private User",
        email_address: "user@example.com",
      },
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockGetPrivateProfile).toHaveBeenCalledWith("acct-1", undefined);
  });

  it("requires account:read for API-key account name lookup", async () => {
    mockGetAccountFromApiKey.mockResolvedValue(
      apiKeyPrincipal(["project:list"]),
    );
    const { req, res } = apiKeyMocks({ account_ids: ["acct-2"] });

    const { default: handler } = await import("./accounts/get-names");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API key lacks required capability 'account:read'",
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockGetNames).not.toHaveBeenCalled();
  });

  it("allows account:read API keys to lookup account names", async () => {
    const { req, res } = apiKeyMocks({ account_ids: ["acct-2"] });

    const { default: handler } = await import("./accounts/get-names");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      names: { "acct-2": { display_name: "Public User" } },
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockValidateGetNamesAccountIds).toHaveBeenCalledWith(["acct-2"]);
    expect(mockGetNames).toHaveBeenCalledWith(["acct-2"]);
  });

  it.each([
    [
      "./auth/bootstrap",
      "API keys are not allowed to use browser bootstrap",
      mockGetClusterAccountById,
    ],
    [
      "./auth/has-password",
      "API keys are not allowed to inspect password status",
      mockHasPassword,
    ],
    [
      "./auth/cli/challenge-info",
      "API keys are not allowed to use CLI auth challenge context",
      mockGetCliAuthApprovalInfo,
    ],
    [
      "./purchases/get-stripe-publishable-key",
      "API keys are not allowed to access Stripe billing setup",
      mockGetServerSettings,
    ],
  ])("rejects API-key access to %s", async (modulePath, error, backendCall) => {
    const { req, res } = apiKeyMocks({ challenge_id: "challenge-1" });

    const { default: handler } = await import(modulePath);
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ error });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(backendCall).not.toHaveBeenCalled();
  });
});
