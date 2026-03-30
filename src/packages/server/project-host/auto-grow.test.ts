/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let queryMock: jest.Mock;
let createHostControlClientMock: jest.Mock;
let conatWithProjectRoutingMock: jest.Mock;
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
  conatWithProjectRouting: (...args: any[]) =>
    conatWithProjectRoutingMock(...args),
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
    conatWithProjectRoutingMock = jest.fn(() => ({ client: "router" }));
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
});
