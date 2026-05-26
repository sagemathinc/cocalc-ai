/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const createClusterAccountMock = jest.fn();
const createPassportMock = jest.fn();

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  assertNoClusterBannedEquivalentEmailAccount: jest.fn(),
  createClusterAccount: (...args: any[]) => createClusterAccountMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-sso"),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    extend: jest.fn(() => ({ debug: jest.fn() })),
  })),
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    extend: jest.fn(() => ({ debug: jest.fn() })),
  })),
}));

describe("PassportLogin SSO account creation", () => {
  beforeEach(() => {
    jest.resetModules();
    createClusterAccountMock.mockReset().mockResolvedValue({
      account_id: "11111111-1111-4111-8111-111111111111",
    });
    createPassportMock.mockReset().mockResolvedValue(undefined);
  });

  it("creates new SSO accounts through the cluster account directory path", async () => {
    const { PassportLogin } = await import("./passport-login");
    const opts = {
      passports: {
        google: {
          strategy: "google",
          conf: { type: "oidc" },
          info: {},
        },
      },
      database: {
        create_passport: createPassportMock,
      },
      strategyName: "google",
      profile: { id: "google-id" },
      id: "google-id",
      first_name: "Ada",
      last_name: "Lovelace",
      emails: ["Ada+SSO@Example.COM"],
      req: {},
      res: {},
      update_on_login: false,
      host: "",
      site_url: "https://cocalc.test",
    };
    const login = new PassportLogin(opts as any);

    await expect(
      (login as any).create_account(opts, opts.emails[0]),
    ).resolves.toBe("11111111-1111-4111-8111-111111111111");

    expect(createClusterAccountMock).toHaveBeenCalledWith({
      email_address: "ada+sso@example.com",
      password: "",
      first_name: "Ada",
      last_name: "Lovelace",
      home_bay_id: "bay-sso",
      signup_reason: "SSO account creation via google",
    });
    expect(createPassportMock).toHaveBeenCalledWith({
      account_id: "11111111-1111-4111-8111-111111111111",
      strategy: "google",
      id: "google-id",
      profile: { id: "google-id" },
      email_address: "ada+sso@example.com",
      first_name: "Ada",
      last_name: "Lovelace",
    });
  });
});
