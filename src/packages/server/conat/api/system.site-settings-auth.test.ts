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
let getConfiguredClusterSeedBayIdMock: jest.Mock;
let bayOpsMock: jest.Mock;

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

jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: (...args: any[]) =>
    getConfiguredClusterSeedBayIdMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: () => ({
    bayOps: (...args: any[]) => bayOpsMock(...args),
  }),
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
    let configVersion = 0;
    getPoolQueryMock = jest.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO global_config_versions")) {
        configVersion += 1;
        return { rows: [{ version: configVersion }] };
      }
      if (sql.includes("SELECT version FROM global_config_versions")) {
        return { rows: configVersion ? [{ version: configVersion }] : [] };
      }
      return { rows: [] };
    });
    centralLogMock = jest.fn(async () => undefined);
    listClusterBayRegistryMock = jest.fn(async () => []);
    getConfiguredBayIdMock = jest.fn(() => "seed");
    getConfiguredClusterSeedBayIdMock = jest.fn(() => "seed");
    bayOpsMock = jest.fn(() => ({
      setServerSetting: jest.fn(),
      setSiteSettings: jest.fn(),
      syncSiteSettings: jest.fn(),
      getGlobalConfigPropagationStatus: jest.fn(),
    }));
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

    const result = await setSiteSettings({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      settings: [
        { name: "signup_email_domain_policy_mode", value: "allow_only" },
        { name: "signup_email_domain_allow_list", value: "*.school.edu" },
      ],
    });

    expect(result).toMatchObject({
      local_bay_id: "seed",
      count: 2,
      scope: "server_settings",
      version: 1,
      bays: [{ bay_id: "seed", status: "local", count: 2, version: 1 }],
    });
    const poolSqlCalls = getPoolQueryMock.mock.calls.map(([sql]) => `${sql}`);
    expect(
      poolSqlCalls.some((sql) =>
        sql.includes("INSERT INTO global_config_versions"),
      ),
    ).toBe(true);
    expect(
      poolSqlCalls.some((sql) =>
        sql.includes("INSERT INTO global_config_events"),
      ),
    ).toBe(true);
    expect(
      poolSqlCalls.some((sql) =>
        sql.includes("INSERT INTO global_config_bay_state"),
      ),
    ).toBe(true);
    expect(centralLogMock).toHaveBeenCalledWith({
      event: "signup_email_domain_policy_changed",
      value: {
        account_id: ACCOUNT_ID,
        bay_id: "seed",
        source_bay_id: "seed",
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

  it("records seed version and attached-bay mirror state for propagated settings", async () => {
    requireDangerousSessionAuthMock = jest.fn(async () => undefined);
    listClusterBayRegistryMock = jest.fn(async () => [
      { bay_id: "seed" },
      { bay_id: "attached-a" },
    ]);
    const setServerSetting = jest.fn(async () => undefined);
    bayOpsMock = jest.fn(() => ({
      setServerSetting,
    }));
    const { setSiteSettings } = await import("./system");

    const result = await setSiteSettings({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      settings: [{ name: "site_name", value: "Seed Name" }],
    });

    expect(result).toMatchObject({
      local_bay_id: "seed",
      count: 1,
      scope: "server_settings",
      version: 1,
      bays: [
        { bay_id: "seed", status: "local", count: 1, version: 1 },
        { bay_id: "attached-a", status: "applied", count: 1, version: 1 },
      ],
    });
    expect(bayOpsMock).toHaveBeenCalledWith("attached-a", {
      timeout_ms: 15_000,
    });
    expect(setServerSetting).toHaveBeenCalledWith({
      name: "site_name",
      value: "Seed Name",
    });
    const bayStateWrites = getPoolQueryMock.mock.calls.filter(([sql]) =>
      `${sql}`.includes("INSERT INTO global_config_bay_state"),
    );
    expect(bayStateWrites).toHaveLength(2);
  });

  it("forwards attached-bay site settings writes to seed after fresh auth", async () => {
    requireDangerousSessionAuthMock = jest.fn(async () => undefined);
    getConfiguredBayIdMock = jest.fn(() => "attached-a");
    const setSiteSettingsOnSeed = jest.fn(async () => ({
      local_bay_id: "seed",
      count: 1,
      bays: [{ bay_id: "seed", status: "local", count: 1 }],
    }));
    bayOpsMock = jest.fn(() => ({
      setSiteSettings: setSiteSettingsOnSeed,
    }));
    const { setSiteSettings } = await import("./system");

    const result = await setSiteSettings({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      settings: [{ name: "site_name", value: "Seed Name" }],
    });

    expect(result.local_bay_id).toBe("seed");
    expect(dbMock.set_server_setting).not.toHaveBeenCalled();
    expect(bayOpsMock).toHaveBeenCalledWith("seed", { timeout_ms: 15_000 });
    expect(setSiteSettingsOnSeed).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      settings: [{ name: "site_name", value: "Seed Name" }],
      source_bay_id: "attached-a",
    });
  });

  it("forwards attached-bay site settings sync to seed", async () => {
    getConfiguredBayIdMock = jest.fn(() => "attached-a");
    const syncSiteSettingsOnSeed = jest.fn(async () => ({
      local_bay_id: "seed",
      count: 2,
      bays: [{ bay_id: "seed", status: "local", count: 2 }],
    }));
    bayOpsMock = jest.fn(() => ({
      syncSiteSettings: syncSiteSettingsOnSeed,
    }));
    const { syncSiteSettingsToBays } = await import("./system");

    const result = await syncSiteSettingsToBays({ account_id: ACCOUNT_ID });

    expect(result.local_bay_id).toBe("seed");
    expect(bayOpsMock).toHaveBeenCalledWith("seed", { timeout_ms: 15_000 });
    expect(syncSiteSettingsOnSeed).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      source_bay_id: "attached-a",
    });
  });

  it("reports seed global config propagation status", async () => {
    const updatedAt = new Date("2026-06-05T12:00:00.000Z");
    const appliedAt = new Date("2026-06-05T12:01:00.000Z");
    listClusterBayRegistryMock = jest.fn(async () => [
      { bay_id: "seed" },
      { bay_id: "attached-a" },
      { bay_id: "attached-b" },
    ]);
    getPoolQueryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM global_config_versions")) {
        return {
          rows: [
            {
              scope: "server_settings",
              version: "3",
              updated_at: updatedAt,
              updated_by: ACCOUNT_ID,
              metadata: { source_bay_id: "seed" },
            },
          ],
        };
      }
      if (sql.includes("FROM global_config_bay_state")) {
        return {
          rows: [
            {
              bay_id: "seed",
              scope: "server_settings",
              applied_version: "3",
              applied_at: appliedAt,
              last_error: null,
            },
            {
              bay_id: "attached-a",
              scope: "server_settings",
              applied_version: "2",
              applied_at: appliedAt,
              last_error: null,
            },
            {
              bay_id: "attached-b",
              scope: "server_settings",
              applied_version: "2",
              applied_at: appliedAt,
              last_error: "connection failed",
            },
          ],
        };
      }
      return { rows: [] };
    });
    const { getGlobalConfigPropagationStatus } = await import("./system");

    const result = await getGlobalConfigPropagationStatus({
      account_id: ACCOUNT_ID,
      scope: "server_settings",
    });

    expect(result).toMatchObject({
      current_bay_id: "seed",
      seed_bay_id: "seed",
      scopes: [
        {
          scope: "server_settings",
          seed_version: 3,
          updated_at: "2026-06-05T12:00:00.000Z",
          updated_by: ACCOUNT_ID,
          metadata: { source_bay_id: "seed" },
          bays: [
            {
              bay_id: "attached-a",
              status: "stale",
              applied_version: 2,
              applied_at: "2026-06-05T12:01:00.000Z",
              last_error: null,
            },
            {
              bay_id: "attached-b",
              status: "error",
              applied_version: 2,
              applied_at: "2026-06-05T12:01:00.000Z",
              last_error: "connection failed",
            },
            {
              bay_id: "seed",
              status: "current",
              applied_version: 3,
              applied_at: "2026-06-05T12:01:00.000Z",
              last_error: null,
            },
          ],
        },
      ],
    });
  });

  it("forwards attached-bay global config propagation status to seed", async () => {
    getConfiguredBayIdMock = jest.fn(() => "attached-a");
    const getStatusOnSeed = jest.fn(async () => ({
      current_bay_id: "seed",
      seed_bay_id: "seed",
      checked_at: "2026-06-05T12:00:00.000Z",
      scopes: [],
    }));
    bayOpsMock = jest.fn(() => ({
      getGlobalConfigPropagationStatus: getStatusOnSeed,
    }));
    const { getGlobalConfigPropagationStatus } = await import("./system");

    const result = await getGlobalConfigPropagationStatus({
      account_id: ACCOUNT_ID,
      scope: "server_settings",
    });

    expect(result.current_bay_id).toBe("seed");
    expect(bayOpsMock).toHaveBeenCalledWith("seed", { timeout_ms: 15_000 });
    expect(getStatusOnSeed).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      scope: "server_settings",
      source_bay_id: "attached-a",
    });
  });
});
