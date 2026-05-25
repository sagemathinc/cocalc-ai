/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let isAdminMock: jest.Mock;
let requireDangerousSessionAuthMock: jest.Mock;
let dbMock: {
  get_server_setting: jest.Mock;
  set_server_setting: jest.Mock;
};
let getPoolQueryMock: jest.Mock;
let centralLogMock: jest.Mock;
let listClusterBayRegistryMock: jest.Mock;
let getConfiguredBayIdMock: jest.Mock;

jest.mock("@cocalc/database", () => ({
  db: () => dbMock,
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: getPoolQueryMock }),
}));

jest.mock("@cocalc/database/postgres/central-log", () => ({
  __esModule: true,
  default: (...args: any[]) => centralLogMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: (...args: any[]) => getConfiguredBayIdMock(...args),
}));

jest.mock("@cocalc/server/bay-registry", () => ({
  listClusterBayRegistry: (...args: any[]) =>
    listClusterBayRegistryMock(...args),
  setBayProjectOwnershipAdmissionLocal: jest.fn(),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("./dangerous-session-auth", () => ({
  __esModule: true,
  requireDangerousSessionAuth: (...args: any[]) =>
    requireDangerousSessionAuthMock(...args),
}));

describe("site settings dangerous-session auth", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    const settings = new Map<string, string | undefined>([
      ["signup_email_domain_policy_mode", "deny_list"],
      ["signup_email_domain_allow_list", ""],
      ["signup_email_domain_deny_list", "bad.example"],
      ["signup_email_domain_public_message", ""],
      ["signup_email_domain_show_allowed_domains", "no"],
    ]);
    dbMock = {
      get_server_setting: jest.fn(({ name, cb }) => {
        cb(undefined, settings.get(name));
      }),
      set_server_setting: jest.fn(({ name, value, cb }) => {
        settings.set(name, value);
        cb(undefined);
      }),
    };
    getPoolQueryMock = jest.fn(async () => ({ rows: [] }));
    centralLogMock = jest.fn(async () => undefined);
    listClusterBayRegistryMock = jest.fn(async () => []);
    getConfiguredBayIdMock = jest.fn(() => "seed");
    isAdminMock = jest.fn(async () => true);
    requireDangerousSessionAuthMock = jest.fn(async () => {
      throw Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      });
    });
  });

  it("requires recent 2FA fresh auth before global site settings changes", async () => {
    const { setSiteSettings } = await import("./system");

    await expect(
      setSiteSettings({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        settings: [],
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: true,
    });
  });

  it("logs signup email domain policy changes after fresh auth", async () => {
    requireDangerousSessionAuthMock = jest.fn(async () => undefined);
    const { setSiteSettings } = await import("./system");

    await setSiteSettings({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      settings: [
        { name: "signup_email_domain_policy_mode", value: "allow_only" },
        { name: "signup_email_domain_allow_list", value: "*.school.edu" },
      ],
    });

    expect(centralLogMock).toHaveBeenCalledWith({
      event: "signup_email_domain_policy_changed",
      value: {
        account_id: ACCOUNT_ID,
        bay_id: "seed",
        changed_setting_names: [
          "signup_email_domain_allow_list",
          "signup_email_domain_policy_mode",
        ],
        old_policy: {
          mode: "deny_list",
          allow_domains: [],
          deny_domains: ["bad.example"],
          public_message: "",
          show_allowed_domains: false,
        },
        new_policy: {
          mode: "allow_only",
          allow_domains: ["*.school.edu"],
          deny_domains: ["bad.example"],
          public_message: "",
          show_allowed_domains: false,
        },
      },
    });
  });
});
