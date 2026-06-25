/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetClusterAccountById = jest.fn();
const mockGetBayPublicOriginForRequest = jest.fn();
const mockGetImpersonationBootstrapInfo = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: (...args) => mockGetClusterAccountById(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));

jest.mock("@cocalc/server/bay-public-origin", () => ({
  getBayPublicOriginForRequest: (...args) =>
    mockGetBayPublicOriginForRequest(...args),
}));

jest.mock("@cocalc/server/auth/impersonation", () => ({
  getImpersonationBootstrapInfo: (...args) =>
    mockGetImpersonationBootstrapInfo(...args),
}));

describe("/api/v2/auth/bootstrap", () => {
  beforeEach(() => {
    mockGetAccountId.mockReset();
    mockGetClusterAccountById.mockReset();
    mockGetBayPublicOriginForRequest
      .mockReset()
      .mockResolvedValue("https://bay-0.example.test");
    mockGetImpersonationBootstrapInfo.mockReset().mockResolvedValue(null);
  });

  it("uses display_name instead of stale legacy split names", async () => {
    mockGetAccountId.mockResolvedValue("account-1");
    mockGetClusterAccountById.mockResolvedValue({
      account_id: "account-1",
      display_name: "AdmiN",
      email_address: "admin@example.com",
      first_name: "Admin",
      home_bay_id: "bay-0",
      last_name: "User",
    });
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/bootstrap",
    });

    const { default: bootstrap } = await import("./bootstrap");
    await bootstrap(req, res);

    expect(res._getJSONData()).toEqual(
      expect.objectContaining({
        account_id: "account-1",
        display_name: "AdmiN",
        email_address: "admin@example.com",
        signed_in: true,
      }),
    );
  });
});
