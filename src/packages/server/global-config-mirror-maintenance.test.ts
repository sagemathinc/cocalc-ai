/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let getConfiguredBayIdMock: jest.Mock;
let getConfiguredClusterSeedBayIdMock: jest.Mock;
let getGlobalConfigPropagationStatusOnSeedMock: jest.Mock;
let syncSiteSettingsToBaysOnSeedMock: jest.Mock;

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    info: jest.fn(),
    warn: jest.fn(),
  }),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: (...args: any[]) => getConfiguredBayIdMock(...args),
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: (...args: any[]) =>
    getConfiguredClusterSeedBayIdMock(...args),
}));

jest.mock("@cocalc/server/conat/api/system", () => ({
  SERVER_SETTINGS_CONFIG_SCOPE: "server_settings",
  getGlobalConfigPropagationStatusOnSeed: (...args: any[]) =>
    getGlobalConfigPropagationStatusOnSeedMock(...args),
  syncSiteSettingsToBaysOnSeed: (...args: any[]) =>
    syncSiteSettingsToBaysOnSeedMock(...args),
}));

describe("global config mirror maintenance", () => {
  beforeEach(() => {
    jest.resetModules();
    getConfiguredBayIdMock = jest.fn(() => "seed");
    getConfiguredClusterSeedBayIdMock = jest.fn(() => "seed");
    getGlobalConfigPropagationStatusOnSeedMock = jest.fn(async () => ({
      current_bay_id: "seed",
      seed_bay_id: "seed",
      checked_at: "2026-06-05T12:00:00.000Z",
      scopes: [],
    }));
    syncSiteSettingsToBaysOnSeedMock = jest.fn(async () => ({
      local_bay_id: "seed",
      count: 0,
      scope: "server_settings",
      version: 1,
      bays: [],
    }));
  });

  it("skips repair on attached bays", async () => {
    getConfiguredBayIdMock = jest.fn(() => "attached-a");
    const { runGlobalConfigMirrorRepairPass } =
      await import("./global-config-mirror-maintenance");

    const result = await runGlobalConfigMirrorRepairPass();

    expect(result).toEqual({
      scope: "server_settings",
      skipped: "not-seed",
      repaired: false,
      stale_bays: [],
    });
    expect(getGlobalConfigPropagationStatusOnSeedMock).not.toHaveBeenCalled();
    expect(syncSiteSettingsToBaysOnSeedMock).not.toHaveBeenCalled();
  });

  it("skips repair when server settings mirrors are current", async () => {
    getGlobalConfigPropagationStatusOnSeedMock = jest.fn(async () => ({
      current_bay_id: "seed",
      seed_bay_id: "seed",
      checked_at: "2026-06-05T12:00:00.000Z",
      scopes: [
        {
          scope: "server_settings",
          seed_version: 3,
          bays: [
            { bay_id: "seed", status: "current", applied_version: 3 },
            { bay_id: "attached-a", status: "current", applied_version: 3 },
          ],
        },
      ],
    }));
    const { runGlobalConfigMirrorRepairPass } =
      await import("./global-config-mirror-maintenance");

    const result = await runGlobalConfigMirrorRepairPass();

    expect(result).toEqual({
      scope: "server_settings",
      skipped: "already-current",
      repaired: false,
      stale_bays: [],
    });
    expect(getGlobalConfigPropagationStatusOnSeedMock).toHaveBeenCalledWith({
      scope: "server_settings",
    });
    expect(syncSiteSettingsToBaysOnSeedMock).not.toHaveBeenCalled();
  });

  it("repairs stale server settings mirrors from seed", async () => {
    getGlobalConfigPropagationStatusOnSeedMock = jest.fn(async () => ({
      current_bay_id: "seed",
      seed_bay_id: "seed",
      checked_at: "2026-06-05T12:00:00.000Z",
      scopes: [
        {
          scope: "server_settings",
          seed_version: 3,
          bays: [
            { bay_id: "seed", status: "current", applied_version: 3 },
            { bay_id: "attached-a", status: "stale", applied_version: 2 },
            {
              bay_id: "attached-b",
              status: "error",
              applied_version: 2,
              last_error: "connection failed",
            },
          ],
        },
      ],
    }));
    const sync = {
      local_bay_id: "seed",
      count: 2,
      scope: "server_settings",
      version: 3,
      bays: [
        { bay_id: "seed", status: "local", count: 2, version: 3 },
        { bay_id: "attached-a", status: "applied", count: 2, version: 3 },
        { bay_id: "attached-b", status: "applied", count: 2, version: 3 },
      ],
    };
    syncSiteSettingsToBaysOnSeedMock = jest.fn(async () => sync);
    const { runGlobalConfigMirrorRepairPass } =
      await import("./global-config-mirror-maintenance");

    const result = await runGlobalConfigMirrorRepairPass();

    expect(result).toEqual({
      scope: "server_settings",
      skipped: false,
      repaired: true,
      stale_bays: ["attached-a", "attached-b"],
      sync,
    });
    expect(syncSiteSettingsToBaysOnSeedMock).toHaveBeenCalledTimes(1);
  });
});
