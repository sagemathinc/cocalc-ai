/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let queryMock: jest.Mock;
let createHostControlClientMock: jest.Mock;
let getExplicitHostRoutedClientMock: jest.Mock;
let getProviderContextMock: jest.Mock;
let getServerProviderMock: jest.Mock;
let logCloudVmEventMock: jest.Mock;
let getServerSettingsMock: jest.Mock;

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => queryMock(...args),
  })),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

jest.mock("@cocalc/conat/project-host/api", () => ({
  __esModule: true,
  createHostControlClient: (...args: any[]) =>
    createHostControlClientMock(...args),
}));

jest.mock("@cocalc/server/conat/route-client", () => ({
  __esModule: true,
  getExplicitHostRoutedClient: (...args: any[]) =>
    getExplicitHostRoutedClientMock(...args),
  getExplicitHostControlClient: (...args: any[]) =>
    getExplicitHostRoutedClientMock(...args),
}));

jest.mock("@cocalc/server/cloud/provider-context", () => ({
  __esModule: true,
  getProviderContext: (...args: any[]) => getProviderContextMock(...args),
  getProviderPrefix: jest.fn(async () => "cocalc-host"),
}));

jest.mock("@cocalc/server/cloud/providers", () => ({
  __esModule: true,
  getServerProvider: (...args: any[]) => getServerProviderMock(...args),
  gcpSafeName: jest.fn((_prefix: string, name: string) => name),
}));

jest.mock("@cocalc/server/cloud", () => ({
  __esModule: true,
  logCloudVmEvent: (...args: any[]) => logCloudVmEventMock(...args),
}));

describe("guarded host auto-grow", () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.COCALC_HOST_AUTO_GROW_ENABLED;
    queryMock = jest.fn();
    createHostControlClientMock = jest.fn(() => ({
      growBtrfs: jest.fn(async () => ({ ok: true })),
    }));
    getExplicitHostRoutedClientMock = jest.fn(async () => ({
      client: "router",
    }));
    getProviderContextMock = jest.fn(async () => ({
      entry: {
        provider: {
          resizeDisk: jest.fn(async () => undefined),
        },
      },
      creds: {},
    }));
    getServerProviderMock = jest.fn(() => ({
      entry: {
        capabilities: {
          supportsDiskResize: true,
          diskResizeRequiresStop: false,
        },
      },
    }));
    logCloudVmEventMock = jest.fn(async () => undefined);
    getServerSettingsMock = jest.fn(async () => ({}));
  });

  it("grows an eligible gcp host once and records the event", async () => {
    const resizeDiskMock = jest.fn(async () => undefined);
    const growBtrfsMock = jest.fn(async () => ({ ok: true }));
    getProviderContextMock = jest.fn(async () => ({
      entry: {
        provider: {
          resizeDisk: resizeDiskMock,
        },
      },
      creds: {},
    }));
    createHostControlClientMock = jest.fn(() => ({
      growBtrfs: growBtrfsMock,
    }));

    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: "host-1",
              name: "Host 1",
              region: "us-west1",
              status: "running",
              metadata: {
                runtime: { instance_id: "instance-1" },
                machine: {
                  cloud: "gcp",
                  disk_gb: 200,
                  storage_mode: "persistent",
                  metadata: {
                    auto_grow: {
                      enabled: true,
                      max_disk_gb: 500,
                      growth_step_gb: 50,
                      min_grow_interval_minutes: 60,
                    },
                  },
                },
              },
            },
          ],
        };
      }
      if (sql.includes("UPDATE project_hosts")) {
        expect(params[0]).toBe("host-1");
        expect(params[1].machine.disk_gb).toBe(250);
        expect(params[1].machine.metadata.auto_grow.last_grow_to_disk_gb).toBe(
          250,
        );
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { maybeAutoGrowHostDiskForReservationFailure } =
      await import("./auto-grow");
    const result = await maybeAutoGrowHostDiskForReservationFailure({
      host_id: "host-1",
      err: new Error("host storage reservation denied for RootFS pull"),
    });

    expect(result).toEqual({
      grown: true,
      next_disk_gb: 250,
    });
    expect(resizeDiskMock).toHaveBeenCalledWith(
      expect.objectContaining({ instance_id: "instance-1" }),
      250,
      {},
    );
    expect(growBtrfsMock).toHaveBeenCalledWith({ disk_gb: 250 });
    expect(logCloudVmEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        vm_id: "host-1",
        action: "resize",
        status: "success",
      }),
    );
  });

  it("does nothing when guarded auto-grow is not enabled", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: "host-1",
              metadata: {
                machine: {
                  cloud: "gcp",
                  disk_gb: 200,
                  storage_mode: "persistent",
                  metadata: {},
                },
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { maybeAutoGrowHostDiskForReservationFailure } =
      await import("./auto-grow");
    const result = await maybeAutoGrowHostDiskForReservationFailure({
      host_id: "host-1",
      err: new Error("host storage reservation denied for OCI image pull"),
    });

    expect(result.grown).toBe(false);
    expect(result.reason).toMatch(/not enabled/i);
    expect(getProviderContextMock).not.toHaveBeenCalled();
  });

  it("recommends background auto-grow for sustained low disk headroom", async () => {
    const { _test } = await import("./auto-grow");
    const decision = _test.shouldAutoGrowForBackgroundPressure({
      window_minutes: 6,
      point_count: 4,
      points: [
        {
          collected_at: "2026-03-30T02:00:00.000Z",
          disk_available_conservative_bytes: 20 * 1024 ** 3,
          disk_used_percent: 90,
        },
        {
          collected_at: "2026-03-30T02:01:00.000Z",
          disk_available_conservative_bytes: 19 * 1024 ** 3,
          disk_used_percent: 90.5,
        },
        {
          collected_at: "2026-03-30T02:02:00.000Z",
          disk_available_conservative_bytes: 18 * 1024 ** 3,
          disk_used_percent: 91,
        },
      ],
      growth: {
        window_minutes: 6,
        disk_used_bytes_per_hour: 2 * 1024 ** 3,
      },
      derived: {
        window_minutes: 6,
        disk: {
          level: "warning",
          available_bytes: 18 * 1024 ** 3,
          hours_to_exhaustion: 9,
          reason: "Disk could exhaust within 24h",
        },
        metadata: { level: "healthy" },
        alerts: [],
        admission_allowed: true,
        auto_grow_recommended: true,
      },
    });

    expect(decision).toEqual({
      recommended: true,
      reason: "Disk could exhaust within 24h",
    });
  });

  it("grows a host for background disk pressure when metrics justify it", async () => {
    const resizeDiskMock = jest.fn(async () => undefined);
    const growBtrfsMock = jest.fn(async () => ({ ok: true }));
    getProviderContextMock = jest.fn(async () => ({
      entry: {
        provider: {
          resizeDisk: resizeDiskMock,
        },
      },
      creds: {},
    }));
    createHostControlClientMock = jest.fn(() => ({
      growBtrfs: growBtrfsMock,
    }));

    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: "host-2",
              name: "Host 2",
              region: "us-west1",
              status: "running",
              metadata: {
                runtime: { instance_id: "instance-2" },
                machine: {
                  cloud: "gcp",
                  disk_gb: 200,
                  storage_mode: "persistent",
                  metadata: {
                    auto_grow: {
                      enabled: true,
                      max_disk_gb: 500,
                      growth_step_gb: 50,
                      min_grow_interval_minutes: 60,
                    },
                  },
                },
              },
            },
          ],
        };
      }
      if (sql.includes("UPDATE project_hosts")) {
        expect(params[0]).toBe("host-2");
        expect(params[1].machine.disk_gb).toBe(250);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { maybeAutoGrowHostDiskForBackgroundPressure } =
      await import("./auto-grow");
    const result = await maybeAutoGrowHostDiskForBackgroundPressure({
      host_id: "host-2",
      history: {
        window_minutes: 6,
        point_count: 4,
        points: [
          {
            collected_at: "2026-03-30T02:00:00.000Z",
            disk_available_conservative_bytes: 20 * 1024 ** 3,
            disk_used_percent: 90,
          },
          {
            collected_at: "2026-03-30T02:01:00.000Z",
            disk_available_conservative_bytes: 19 * 1024 ** 3,
            disk_used_percent: 90.5,
          },
          {
            collected_at: "2026-03-30T02:02:00.000Z",
            disk_available_conservative_bytes: 18 * 1024 ** 3,
            disk_used_percent: 91,
          },
        ],
        growth: {
          window_minutes: 6,
          disk_used_bytes_per_hour: 2 * 1024 ** 3,
        },
        derived: {
          window_minutes: 6,
          disk: {
            level: "warning",
            available_bytes: 18 * 1024 ** 3,
            hours_to_exhaustion: 9,
            reason: "Disk could exhaust within 24h",
          },
          metadata: { level: "healthy" },
          alerts: [],
          admission_allowed: true,
          auto_grow_recommended: true,
        },
      },
    });

    expect(result).toEqual({
      grown: true,
      next_disk_gb: 250,
    });
    expect(resizeDiskMock).toHaveBeenCalledWith(
      expect.objectContaining({ instance_id: "instance-2" }),
      250,
      {},
    );
    expect(growBtrfsMock).toHaveBeenCalledWith({ disk_gb: 250 });
    expect(logCloudVmEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        vm_id: "host-2",
        action: "resize",
        status: "success",
        spec: expect.objectContaining({
          trigger: "background_low_headroom",
        }),
      }),
    );
  });
});
