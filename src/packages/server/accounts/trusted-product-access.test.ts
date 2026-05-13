/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;
let getServerSettingsMock: jest.Mock;
let isAdminMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

describe("trusted product access", () => {
  const account_id = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    getServerSettingsMock = jest.fn(async () => ({
      verify_emails: true,
      email_enabled: true,
      email_backend: "smtp",
    }));
    isAdminMock = jest.fn(async () => false);
    queryMock = jest.fn(async () => ({
      rows: [
        {
          email_address: "user@example.com",
          email_address_verified: null,
          trusted_product_access: false,
          trusted_product_access_reason: null,
        },
      ],
    }));
  });

  it("allows product access when email verification is not configured", async () => {
    getServerSettingsMock.mockResolvedValue({
      verify_emails: true,
      email_enabled: false,
      email_backend: "none",
    });
    const { getAccountProductAccessTrust } =
      await import("./trusted-product-access");
    await expect(getAccountProductAccessTrust(account_id)).resolves.toEqual({
      trusted: true,
      reason: "email_not_required",
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("allows verified email accounts", async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          email_address: "user@example.com",
          email_address_verified: {
            "user@example.com": "2026-05-12T00:00:00.000Z",
          },
          trusted_product_access: false,
          trusted_product_access_reason: null,
        },
      ],
    });
    const { getAccountProductAccessTrust } =
      await import("./trusted-product-access");
    await expect(getAccountProductAccessTrust(account_id)).resolves.toEqual({
      trusted: true,
      reason: "email_verified",
    });
  });

  it("allows registration-token-created accounts before email verification", async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          email_address: "user@example.com",
          email_address_verified: null,
          trusted_product_access: true,
          trusted_product_access_reason: "registration_token",
        },
      ],
    });
    const { getAccountProductAccessTrust } =
      await import("./trusted-product-access");
    await expect(getAccountProductAccessTrust(account_id)).resolves.toEqual({
      trusted: true,
      reason: "registration_token",
    });
  });

  it("blocks unverified password accounts when email verification is configured", async () => {
    const { assertAccountTrustedForProductAccess } =
      await import("./trusted-product-access");
    await expect(
      assertAccountTrustedForProductAccess(account_id, "create projects"),
    ).rejects.toThrow("Verify your email address before you create projects.");
  });
});
