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
let getServerSettingsMock: jest.Mock;
let centralLogMock: jest.Mock;
let listClusterBayRegistryMock: jest.Mock;
let getConfiguredBayIdMock: jest.Mock;
let getConfiguredClusterSeedBayIdMock: jest.Mock;
let bayOpsMock: jest.Mock;
const bootstrapMock = jest.fn();
const reconcileMock = jest.fn();
const blobConfigMock = jest.fn();
const lockQueryMock = jest.fn();
const releaseMock = jest.fn();
const connectMock = jest.fn();

jest.mock("@cocalc/server/cloud/cloudflare-bootstrap", () => ({
  bootstrapCloudflareConfiguration: (...args: any[]) => bootstrapMock(...args),
}));
jest.mock("@cocalc/server/cloud/cloudflare-blob-reconcile", () => ({
  reconcileCloudflareBlobs: (...args: any[]) => reconcileMock(...args),
}));
jest.mock("@cocalc/server/blobs/config", () => ({
  resolveBlobStorageConfig: (...args: any[]) => blobConfigMock(...args),
}));

jest.mock("@cocalc/database", () => ({
  db: () => dbMock,
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: getPoolQueryMock, connect: connectMock }),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
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
    bootstrapMock
      .mockReset()
      .mockResolvedValue({ tunnel_token: { ok: true }, notes: [] });
    reconcileMock.mockReset().mockResolvedValue({ ok: true });
    blobConfigMock.mockReset().mockResolvedValue({ activeBackend: "postgres" });
    lockQueryMock.mockReset().mockResolvedValue({ rows: [{ locked: true }] });
    releaseMock.mockReset();
    connectMock
      .mockReset()
      .mockResolvedValue({ query: lockQueryMock, release: releaseMock });
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
    getServerSettingsMock = jest.fn(async () => ({}));
    centralLogMock = jest.fn(async () => undefined);
    listClusterBayRegistryMock = jest.fn(async () => []);
    getConfiguredBayIdMock = jest.fn(() => "seed");
    getConfiguredClusterSeedBayIdMock = jest.fn(() => "seed");
    bayOpsMock = jest.fn(() => ({
      setServerSetting: jest.fn(),
      setSiteSettings: jest.fn(),
      getSiteSettings: jest.fn(),
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

  describe.each([
    "bootstrapCloudflareConfiguration",
    "reconcileCloudflareBlobs",
  ] as const)("%s seed routing", (method) => {
    const opts = {
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: "session-1",
      domain: "example.com",
      token: "secret-bootstrap-token",
    };

    it.each(["seed", "attached-a"])(
      "requires fresh auth before any work on %s",
      async (bay) => {
        getConfiguredBayIdMock.mockReturnValue(bay);
        const system = await import("./system");
        await expect(system[method](opts)).rejects.toMatchObject({
          code: "fresh_auth_required",
        });
        expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
          account_id: ACCOUNT_ID,
          browser_id: "browser-1",
          session_hash: "session-1",
          require_second_factor: true,
        });
        expect(bayOpsMock).not.toHaveBeenCalled();
        expect(connectMock).not.toHaveBeenCalled();
        expect(bootstrapMock).not.toHaveBeenCalled();
        expect(reconcileMock).not.toHaveBeenCalled();
      },
    );

    it("rejects non-admins before dispatch", async () => {
      isAdminMock.mockResolvedValue(false);
      const system = await import("./system");
      await expect(system[method](opts)).rejects.toThrow();
      expect(requireDangerousSessionAuthMock).not.toHaveBeenCalled();
      expect(bayOpsMock).not.toHaveBeenCalled();
    });

    it("forwards authorized work without entry-bay session credentials", async () => {
      requireDangerousSessionAuthMock.mockResolvedValue(undefined);
      getConfiguredBayIdMock.mockReturnValue("attached-a");
      const remote = jest.fn(async () => ({ ok: true }));
      bayOpsMock.mockReturnValue({ [method]: remote });
      const system = await import("./system");
      await system[method](opts);
      expect(bayOpsMock).toHaveBeenCalledWith("seed", { timeout_ms: 600_000 });
      expect(remote).toHaveBeenCalledWith({
        account_id: ACCOUNT_ID,
        source_bay_id: "attached-a",
        ...(method === "bootstrapCloudflareConfiguration"
          ? {
              domain: opts.domain,
              token: opts.token,
              tunnelPrefix: undefined,
              hostSuffix: undefined,
              r2BucketPrefix: undefined,
            }
          : {}),
      });
      expect(
        requireDangerousSessionAuthMock.mock.invocationCallOrder[0],
      ).toBeLessThan(remote.mock.invocationCallOrder[0]);
      expect(connectMock).not.toHaveBeenCalled();
      expect(getServerSettingsMock).not.toHaveBeenCalled();
    });

    it("rejects private dispatch on a non-seed bay", async () => {
      getConfiguredBayIdMock.mockReturnValue("attached-a");
      const system = await import("./system");
      await expect(system[`${method}OnSeed`](opts)).rejects.toThrow("seed bay");
      expect(connectMock).not.toHaveBeenCalled();
    });

    it("rejects contention on the shared provisioning lock before reading settings", async () => {
      lockQueryMock.mockResolvedValue({ rows: [{ locked: false }] });
      const system = await import("./system");
      await expect(system[`${method}OnSeed`](opts)).rejects.toThrow(
        "already running",
      );
      expect(lockQueryMock).toHaveBeenCalledWith(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        ["cocalc:cloudflare-provisioning"],
      );
      expect(getServerSettingsMock).not.toHaveBeenCalled();
      expect(blobConfigMock).not.toHaveBeenCalled();
      expect(bootstrapMock).not.toHaveBeenCalled();
      expect(reconcileMock).not.toHaveBeenCalled();
      expect(releaseMock).toHaveBeenCalledWith(true);
    });

    it("releases the lock after a provisioning failure", async () => {
      bootstrapMock.mockRejectedValue(Error("provision failed"));
      reconcileMock.mockRejectedValue(Error("provision failed"));
      const system = await import("./system");
      await expect(system[`${method}OnSeed`](opts)).rejects.toThrow(
        "provision failed",
      );
      expect(lockQueryMock).toHaveBeenLastCalledWith(
        "SELECT pg_advisory_unlock(hashtext($1))",
        ["cocalc:cloudflare-provisioning"],
      );
      expect(releaseMock).toHaveBeenCalledWith(true);
      expect(requireDangerousSessionAuthMock).not.toHaveBeenCalled();
    });

    it("saves and propagates on seed without rechecking the entry session", async () => {
      listClusterBayRegistryMock.mockResolvedValue([
        { bay_id: "attached-a", status: "active" },
      ]);
      const remoteSave = jest.fn();
      bayOpsMock.mockReturnValue({ setServerSetting: remoteSave });
      const values = {
        project_hosts_cloudflare_tunnel_api_token: "scoped-secret",
      };
      bootstrapMock.mockImplementation(async ({ save }) => {
        await save(values);
        return { tunnel_token: { ok: true }, notes: [] };
      });
      reconcileMock.mockImplementation(async (settings, save) => {
        expect(settings).toEqual({ seed: true });
        await save(values);
        return { ok: true };
      });
      getServerSettingsMock.mockResolvedValue({ seed: true });
      const system = await import("./system");
      await system[`${method}OnSeed`]({ ...opts, source_bay_id: "attached-a" });
      expect(dbMock.set_server_setting).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "project_hosts_cloudflare_tunnel_api_token",
          value: "scoped-secret",
        }),
      );
      expect(remoteSave).toHaveBeenCalledWith({
        name: "project_hosts_cloudflare_tunnel_api_token",
        value: "scoped-secret",
      });
      if (method === "bootstrapCloudflareConfiguration") {
        expect(dbMock.set_server_setting).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "blob_storage_backend",
            value: "postgres",
          }),
        );
      }
      expect(requireDangerousSessionAuthMock).not.toHaveBeenCalled();
      expect(JSON.stringify(centralLogMock.mock.calls)).not.toContain(
        "scoped-secret",
      );
      expect(releaseMock).toHaveBeenCalledWith(true);
    });
  });

  it.each([
    ["same target", {}, false],
    ["different account", { r2_account_id: "new-account" }, true],
    ["different domain", { dns: "new.example.com" }, true],
    ["different bucket", { blob_r2_bucket: "new-blobs" }, true],
  ])("handles active R2 bootstrap with %s", async (_label, changes, pin) => {
    getServerSettingsMock.mockResolvedValue({
      r2_account_id: "old-account",
      dns: "example.com",
      blob_r2_bucket: "old-blobs",
      cloudflare_automation_token_id: "old-token-id",
    });
    blobConfigMock.mockResolvedValue({
      activeBackend: "r2",
      r2: {
        auth: {
          endpoint: "https://old-account.r2.cloudflarestorage.com",
          bucket: "old-blobs",
        },
      },
    });
    bootstrapMock.mockImplementation(async ({ save }) => {
      await save({
        ...changes,
        cloudflare_automation_token_id: "new-token-id",
      });
      return {
        tunnel_token: { ok: true },
        durable_token_id: "new-token-id",
        notes: [],
      };
    });
    const { bootstrapCloudflareConfigurationOnSeed } = await import("./system");
    const result = await bootstrapCloudflareConfigurationOnSeed({
      domain: "example.com",
      token: "bootstrap-token",
    });
    const backendWrites = dbMock.set_server_setting.mock.calls.filter(
      ([opts]) => opts.name === "blob_storage_backend",
    );
    expect(backendWrites).toHaveLength(pin ? 1 : 0);
    if (pin) expect(backendWrites[0][0].value).toBe("postgres");
    expect(result.notes).toContainEqual(
      expect.stringContaining(
        "Previous automation token old-token-id remains active",
      ),
    );
    expect(
      result.notes.some((note) => note.includes("pinned to Postgres")),
    ).toBe(pin);
  });

  it("does not suggest old-token cleanup when bootstrap fails", async () => {
    getServerSettingsMock.mockResolvedValue({
      cloudflare_automation_token_id: "old-token-id",
    });
    bootstrapMock.mockResolvedValue({
      tunnel_token: { ok: false },
      durable_token_id: "new-token-id",
      notes: [],
    });
    const { bootstrapCloudflareConfigurationOnSeed } = await import("./system");
    const result = await bootstrapCloudflareConfigurationOnSeed({
      domain: "example.com",
      token: "bootstrap-token",
    });
    expect(result.notes).toEqual([]);
  });

  it("keeps reconciliation excluded until bootstrap finishes", async () => {
    let locked = false;
    lockQueryMock.mockImplementation(async (sql) => {
      if (sql.includes("pg_try_advisory_lock")) {
        if (locked) return { rows: [{ locked: false }] };
        locked = true;
      } else {
        locked = false;
      }
      return { rows: [{ locked: true }] };
    });
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    bootstrapMock.mockImplementation(async () => {
      entered();
      await pending;
      return { tunnel_token: { ok: true }, notes: [] };
    });
    const system = await import("./system");
    const running = system.bootstrapCloudflareConfigurationOnSeed({
      domain: "example.com",
      token: "bootstrap-token",
    });
    await started;
    await expect(system.reconcileCloudflareBlobsOnSeed({})).rejects.toThrow(
      "already running",
    );
    expect(reconcileMock).not.toHaveBeenCalled();
    finish();
    await running;
    await expect(system.reconcileCloudflareBlobsOnSeed({})).resolves.toEqual({
      ok: true,
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

  it("allows admin site settings reads without fresh auth and redacts passwords", async () => {
    getServerSettingsMock = jest.fn(async () => ({
      cryptomining_abuse_enforcement_enabled: true,
      stripe_secret_key: "sk_live_should_not_print",
    }));
    getPoolQueryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT name, readonly FROM server_settings")) {
        return {
          rows: [
            {
              name: "cryptomining_abuse_enforcement_enabled",
              readonly: false,
            },
            { name: "stripe_secret_key", readonly: true },
          ],
        };
      }
      return { rows: [] };
    });
    const { getSiteSettings } = await import("./system");

    const result = await getSiteSettings({
      account_id: ACCOUNT_ID,
      names: ["cryptomining_abuse_enforcement_enabled", "stripe_secret_key"],
    });

    expect(requireDangerousSessionAuthMock).not.toHaveBeenCalled();
    expect(result.settings).toEqual([
      expect.objectContaining({
        name: "cryptomining_abuse_enforcement_enabled",
        value: true,
        configured: true,
        redacted: false,
      }),
      expect.objectContaining({
        name: "stripe_secret_key",
        value: null,
        configured: true,
        readonly: true,
        password: true,
        redacted: true,
      }),
    ]);
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

  it("forwards attached-bay site settings reads to seed", async () => {
    getConfiguredBayIdMock = jest.fn(() => "attached-a");
    const getSiteSettingsOnSeed = jest.fn(async () => ({
      local_bay_id: "seed",
      seed_bay_id: "seed",
      settings: [
        {
          name: "cryptomining_abuse_auto_ban_enabled",
          value: true,
          default_value: false,
          configured: true,
          readonly: false,
          password: false,
          redacted: false,
          hidden: false,
          description: "",
        },
      ],
    }));
    bayOpsMock = jest.fn(() => ({
      getSiteSettings: getSiteSettingsOnSeed,
    }));
    const { getSiteSettings } = await import("./system");

    const result = await getSiteSettings({
      account_id: ACCOUNT_ID,
      names: ["cryptomining_abuse_auto_ban_enabled"],
    });

    expect(result.local_bay_id).toBe("seed");
    expect(bayOpsMock).toHaveBeenCalledWith("seed", { timeout_ms: 15_000 });
    expect(getSiteSettingsOnSeed).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      names: ["cryptomining_abuse_auto_ban_enabled"],
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
    expect(bayOpsMock).toHaveBeenCalledWith("seed", { timeout_ms: 30_000 });
    expect(getStatusOnSeed).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      scope: "server_settings",
      source_bay_id: "attached-a",
    });
  });
});
