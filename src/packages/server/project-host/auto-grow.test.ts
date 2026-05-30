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
let getConfiguredBayIdMock: jest.Mock;
let getDedicatedHostPolicySnapshotForAccountMock: jest.Mock;
let estimateDedicatedHostRateUsdPerHourMock: jest.Mock;
let reconcileDedicatedHostPurchaseSessionForAccountMock: jest.Mock;

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

jest.mock("@cocalc/server/bay-config", () => ({
  __esModule: true,
  getConfiguredBayId: (...args: any[]) => getConfiguredBayIdMock(...args),
}));

jest.mock("@cocalc/server/project-host/admission", () => {
  const hasPositiveLimit = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0;
  return {
    __esModule: true,
    applyDedicatedHostFundingModeOverride: (
      snapshot: any,
      funding_mode_override?: string,
    ) =>
      funding_mode_override == null ||
      funding_mode_override === snapshot.funding_mode
        ? snapshot
        : { ...snapshot, funding_mode: funding_mode_override },
    getDedicatedHostPolicySnapshotForAccount: (...args: any[]) =>
      getDedicatedHostPolicySnapshotForAccountMock(...args),
    isBillableDedicatedHostCloud: (cloud?: string | null) =>
      !!cloud && cloud !== "self-host" && cloud !== "local",
    selectDedicatedHostFundingLane: (snapshot: any) => {
      const limits = snapshot.effective_limits ?? {};
      if (
        snapshot.funding_mode === "account-prepaid" &&
        Number(snapshot.balance ?? 0) > 0 &&
        (hasPositiveLimit(limits.prepaid_host_usage_limit_5h_usd) ||
          hasPositiveLimit(limits.prepaid_host_usage_limit_7d_usd))
      ) {
        return "prepaid";
      }
      if (
        snapshot.funding_mode === "account-postpaid" &&
        (hasPositiveLimit(limits.credit_spend_limit_5h_usd) ||
          hasPositiveLimit(limits.credit_spend_limit_7d_usd))
      ) {
        return "credit";
      }
      return undefined;
    },
  };
});

jest.mock("@cocalc/server/project-host/spend", () => {
  return {
    __esModule: true,
    estimateDedicatedHostRateUsdPerHour: (...args: any[]) =>
      estimateDedicatedHostRateUsdPerHourMock(...args),
    reconcileDedicatedHostPurchaseSessionForAccount: (...args: any[]) =>
      reconcileDedicatedHostPurchaseSessionForAccountMock(...args),
  };
});

describe("guarded host auto-grow", () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.COCALC_HOST_AUTO_GROW_ENABLED;
    queryMock = jest.fn();
    createHostControlClientMock = jest.fn(() => ({
      growBtrfs: jest.fn(async () => ({ ok: true })),
      growSharedScratch: jest.fn(async () => ({ ok: true })),
    }));
    getExplicitHostRoutedClientMock = jest.fn(async () => ({
      client: "router",
    }));
    getProviderContextMock = jest.fn(async () => ({
      entry: {
        provider: {
          resizeDisk: jest.fn(async () => undefined),
          resizeSharedScratchDisk: jest.fn(async () => undefined),
        },
      },
      creds: {},
    }));
    getServerProviderMock = jest.fn(() => ({
      entry: {
        provider: {
          resizeSharedScratchDisk: jest.fn(async () => undefined),
        },
        capabilities: {
          supportsDiskResize: true,
          diskResizeRequiresStop: false,
          sharedScratchDisk: {
            supported: true,
            growable: true,
            autoGrowable: true,
          },
        },
      },
    }));
    logCloudVmEventMock = jest.fn(async () => undefined);
    getServerSettingsMock = jest.fn(async () => ({}));
    getConfiguredBayIdMock = jest.fn(() => "bay-1");
    getDedicatedHostPolicySnapshotForAccountMock = jest.fn(async () => ({
      can_create_hosts: true,
      has_active_second_factor: true,
      has_payment_method: true,
      has_usage_subscription: true,
      funding_mode: "account-prepaid",
      balance: "1000",
      effective_limits: {
        prepaid_host_usage_limit_5h_usd: 1000,
        prepaid_host_usage_limit_7d_usd: 5000,
      },
      dedicated_host_window_usage: {
        prepaid_5h_usd: "0",
        prepaid_7d_usd: "0",
        credit_5h_usd: "0",
        credit_7d_usd: "0",
      },
      dedicated_host_postpaid_unbilled_exposure: "0",
    }));
    estimateDedicatedHostRateUsdPerHourMock = jest.fn(async () => "10");
    reconcileDedicatedHostPurchaseSessionForAccountMock = jest.fn(
      async () => undefined,
    );
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
        point_count: 3,
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

  it("recommends background auto-grow for sustained low shared scratch headroom", async () => {
    const { _test } = await import("./auto-grow");
    const decision = _test.shouldAutoGrowForSharedScratchBackgroundPressure({
      window_minutes: 6,
      point_count: 4,
      points: [
        {
          collected_at: "2026-03-30T02:00:00.000Z",
          shared_scratch_total_bytes: 200 * 1024 ** 3,
          shared_scratch_available_bytes: 20 * 1024 ** 3,
          shared_scratch_used_percent: 90,
        },
        {
          collected_at: "2026-03-30T02:01:00.000Z",
          shared_scratch_total_bytes: 200 * 1024 ** 3,
          shared_scratch_available_bytes: 19 * 1024 ** 3,
          shared_scratch_used_percent: 90.5,
        },
        {
          collected_at: "2026-03-30T02:02:00.000Z",
          shared_scratch_total_bytes: 200 * 1024 ** 3,
          shared_scratch_available_bytes: 18 * 1024 ** 3,
          shared_scratch_used_percent: 91,
        },
      ],
      growth: {
        window_minutes: 6,
        shared_scratch_used_bytes_per_hour: 2 * 1024 ** 3,
      },
      derived: {
        window_minutes: 6,
        disk: { level: "healthy" },
        shared_scratch: {
          level: "warning",
          available_bytes: 18 * 1024 ** 3,
          hours_to_exhaustion: 9,
          reason: "Shared scratch could exhaust within 24h",
        },
        metadata: { level: "healthy" },
        alerts: [],
        admission_allowed: true,
        auto_grow_recommended: true,
      },
    });

    expect(decision).toEqual({
      recommended: true,
      reason: "Shared scratch could exhaust within 24h",
    });
  });

  it("grows shared scratch for background pressure when metrics justify it", async () => {
    const resizeSharedScratchDiskMock = jest.fn(async () => undefined);
    const growSharedScratchMock = jest.fn(async () => ({ ok: true }));
    getProviderContextMock = jest.fn(async () => ({
      entry: {
        provider: {
          resizeSharedScratchDisk: resizeSharedScratchDiskMock,
        },
      },
      creds: {},
    }));
    createHostControlClientMock = jest.fn(() => ({
      growSharedScratch: growSharedScratchMock,
    }));

    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: "host-3",
              name: "Host 3",
              region: "us-west1",
              status: "running",
              metadata: {
                owner: "account-1",
                runtime: { instance_id: "instance-3" },
                machine: {
                  cloud: "gcp",
                  shared_disk_gb: 200,
                  shared_disk_type: "balanced",
                  metadata: {
                    shared_scratch_auto_grow: {
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
        expect(params[0]).toBe("host-3");
        expect(params[1].machine.shared_disk_gb).toBe(250);
        expect(
          params[1].machine.metadata.shared_scratch_auto_grow
            .last_grow_to_disk_gb,
        ).toBe(250);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { maybeAutoGrowSharedScratchForBackgroundPressure } =
      await import("./auto-grow");
    const result = await maybeAutoGrowSharedScratchForBackgroundPressure({
      host_id: "host-3",
      history: {
        window_minutes: 6,
        point_count: 4,
        points: [
          {
            collected_at: "2026-03-30T02:00:00.000Z",
            shared_scratch_total_bytes: 200 * 1024 ** 3,
            shared_scratch_available_bytes: 20 * 1024 ** 3,
            shared_scratch_used_percent: 90,
          },
          {
            collected_at: "2026-03-30T02:01:00.000Z",
            shared_scratch_total_bytes: 200 * 1024 ** 3,
            shared_scratch_available_bytes: 19 * 1024 ** 3,
            shared_scratch_used_percent: 90.5,
          },
          {
            collected_at: "2026-03-30T02:02:00.000Z",
            shared_scratch_total_bytes: 200 * 1024 ** 3,
            shared_scratch_available_bytes: 18 * 1024 ** 3,
            shared_scratch_used_percent: 91,
          },
        ],
        growth: {
          window_minutes: 6,
          shared_scratch_used_bytes_per_hour: 2 * 1024 ** 3,
        },
        derived: {
          window_minutes: 6,
          disk: { level: "healthy" },
          shared_scratch: {
            level: "warning",
            available_bytes: 18 * 1024 ** 3,
            hours_to_exhaustion: 9,
            reason: "Shared scratch could exhaust within 24h",
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
    expect(resizeSharedScratchDiskMock).toHaveBeenCalledWith(
      expect.objectContaining({ instance_id: "instance-3" }),
      250,
      {},
    );
    expect(growSharedScratchMock).toHaveBeenCalledWith({ disk_gb: 250 });
    expect(estimateDedicatedHostRateUsdPerHourMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "gcp",
        shared_disk_gb: 250,
        shared_disk_type: "balanced",
      }),
    );
    expect(
      reconcileDedicatedHostPurchaseSessionForAccountMock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "account-1",
        host_id: "host-3",
        host_bay_id: "bay-1",
        provider: "gcp",
        funding_lane: "prepaid",
        hourly_cost_usd: "10",
      }),
    );
    expect(logCloudVmEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        vm_id: "host-3",
        action: "resize",
        status: "success",
        spec: expect.objectContaining({
          target: "shared_scratch",
          trigger: "background_low_headroom",
        }),
      }),
    );
  });

  it("clamps legacy shared scratch auto-grow metadata to backend caps", async () => {
    const resizeSharedScratchDiskMock = jest.fn(async () => undefined);
    const growSharedScratchMock = jest.fn(async () => ({ ok: true }));
    getProviderContextMock = jest.fn(async () => ({
      entry: {
        provider: {
          resizeSharedScratchDisk: resizeSharedScratchDiskMock,
        },
      },
      creds: {},
    }));
    createHostControlClientMock = jest.fn(() => ({
      growSharedScratch: growSharedScratchMock,
    }));

    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: "host-legacy-scratch",
              name: "Host legacy scratch",
              region: "us-west1",
              status: "running",
              metadata: {
                owner: "account-1",
                runtime: { instance_id: "instance-legacy-scratch" },
                machine: {
                  cloud: "gcp",
                  shared_disk_gb: 10000,
                  shared_disk_type: "balanced",
                  metadata: {
                    shared_scratch_auto_grow: {
                      enabled: true,
                      max_disk_gb: 20000,
                      growth_step_gb: 20000,
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
        expect(params[0]).toBe("host-legacy-scratch");
        expect(params[1].machine.shared_disk_gb).toBe(10044);
        expect(
          params[1].machine.metadata.shared_scratch_auto_grow
            .last_grow_to_disk_gb,
        ).toBe(10044);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { maybeAutoGrowSharedScratchForBackgroundPressure } =
      await import("./auto-grow");
    const result = await maybeAutoGrowSharedScratchForBackgroundPressure({
      host_id: "host-legacy-scratch",
      history: {
        window_minutes: 6,
        point_count: 3,
        points: [
          {
            collected_at: "2026-03-30T02:00:00.000Z",
            shared_scratch_total_bytes: 10000 * 1024 ** 3,
            shared_scratch_available_bytes: 20 * 1024 ** 3,
            shared_scratch_used_percent: 99,
          },
          {
            collected_at: "2026-03-30T02:01:00.000Z",
            shared_scratch_total_bytes: 10000 * 1024 ** 3,
            shared_scratch_available_bytes: 19 * 1024 ** 3,
            shared_scratch_used_percent: 99.1,
          },
        ],
        growth: {
          window_minutes: 6,
          shared_scratch_used_bytes_per_hour: 2 * 1024 ** 3,
        },
        derived: {
          window_minutes: 6,
          disk: { level: "healthy" },
          shared_scratch: {
            level: "warning",
            available_bytes: 19 * 1024 ** 3,
            hours_to_exhaustion: 9.5,
            reason: "Shared scratch could exhaust within 24h",
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
      next_disk_gb: 10044,
    });
    expect(resizeSharedScratchDiskMock).toHaveBeenCalledWith(
      expect.objectContaining({ instance_id: "instance-legacy-scratch" }),
      10044,
      {},
    );
    expect(growSharedScratchMock).toHaveBeenCalledWith({ disk_gb: 10044 });
  });

  it("blocks shared scratch auto-grow before cloud resize when billing runway is too low", async () => {
    const resizeSharedScratchDiskMock = jest.fn(async () => undefined);
    getProviderContextMock = jest.fn(async () => ({
      entry: {
        provider: {
          resizeSharedScratchDisk: resizeSharedScratchDiskMock,
        },
      },
      creds: {},
    }));
    estimateDedicatedHostRateUsdPerHourMock = jest.fn(async () => "500");
    getDedicatedHostPolicySnapshotForAccountMock = jest.fn(async () => ({
      can_create_hosts: true,
      has_active_second_factor: true,
      has_payment_method: true,
      has_usage_subscription: true,
      funding_mode: "account-prepaid",
      balance: "10",
      effective_limits: {
        prepaid_host_usage_limit_5h_usd: 1000,
        prepaid_host_usage_limit_7d_usd: 5000,
      },
      dedicated_host_window_usage: {
        prepaid_5h_usd: "0",
        prepaid_7d_usd: "0",
        credit_5h_usd: "0",
        credit_7d_usd: "0",
      },
      dedicated_host_postpaid_unbilled_exposure: "0",
    }));

    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: "host-low-runway",
              name: "Host low runway",
              region: "us-west1",
              status: "running",
              metadata: {
                owner: "account-low-runway",
                runtime: { instance_id: "instance-low-runway" },
                machine: {
                  cloud: "gcp",
                  shared_disk_gb: 200,
                  shared_disk_type: "balanced",
                  metadata: {
                    shared_scratch_auto_grow: {
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
      throw new Error(`unexpected query: ${sql}`);
    });

    const { maybeAutoGrowSharedScratchForBackgroundPressure } =
      await import("./auto-grow");
    const result = await maybeAutoGrowSharedScratchForBackgroundPressure({
      host_id: "host-low-runway",
      history: {
        window_minutes: 6,
        point_count: 3,
        points: [
          {
            collected_at: "2026-03-30T02:00:00.000Z",
            shared_scratch_total_bytes: 200 * 1024 ** 3,
            shared_scratch_available_bytes: 20 * 1024 ** 3,
            shared_scratch_used_percent: 90,
          },
          {
            collected_at: "2026-03-30T02:01:00.000Z",
            shared_scratch_total_bytes: 200 * 1024 ** 3,
            shared_scratch_available_bytes: 19 * 1024 ** 3,
            shared_scratch_used_percent: 90.5,
          },
          {
            collected_at: "2026-03-30T02:02:00.000Z",
            shared_scratch_total_bytes: 200 * 1024 ** 3,
            shared_scratch_available_bytes: 18 * 1024 ** 3,
            shared_scratch_used_percent: 91,
          },
        ],
        growth: {
          window_minutes: 6,
          shared_scratch_used_bytes_per_hour: 2 * 1024 ** 3,
        },
        derived: {
          window_minutes: 6,
          disk: { level: "healthy" },
          shared_scratch: {
            level: "warning",
            available_bytes: 19 * 1024 ** 3,
            hours_to_exhaustion: 9.5,
            reason: "Shared scratch could exhaust within 24h",
          },
          metadata: { level: "healthy" },
          alerts: [],
          admission_allowed: true,
          auto_grow_recommended: true,
        },
      },
    });

    expect(result.grown).toBe(false);
    expect(result.reason).toContain("funding runway is too low");
    expect(resizeSharedScratchDiskMock).not.toHaveBeenCalled();
    expect(
      reconcileDedicatedHostPurchaseSessionForAccountMock,
    ).not.toHaveBeenCalled();
  });

  it("does not auto-grow shared scratch when online scratch resize is unsupported", async () => {
    getServerProviderMock = jest.fn(() => ({
      entry: {
        provider: {
          resizeSharedScratchDisk: jest.fn(async () => undefined),
        },
        capabilities: {
          supportsDiskResize: true,
          diskResizeRequiresStop: false,
          sharedScratchDisk: {
            supported: true,
            growable: true,
            autoGrowable: false,
          },
        },
      },
    }));
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: "host-4",
              name: "Host 4",
              region: "eu-north1",
              status: "running",
              metadata: {
                runtime: { instance_id: "instance-4" },
                machine: {
                  cloud: "nebius",
                  shared_disk_gb: 186,
                  shared_disk_type: "ssd",
                  metadata: {
                    shared_scratch_auto_grow: {
                      enabled: true,
                      max_disk_gb: 500,
                      growth_step_gb: 93,
                      min_grow_interval_minutes: 60,
                    },
                  },
                },
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { maybeAutoGrowSharedScratchForBackgroundPressure } =
      await import("./auto-grow");
    const result = await maybeAutoGrowSharedScratchForBackgroundPressure({
      host_id: "host-4",
      history: {
        window_minutes: 6,
        point_count: 3,
        points: [
          {
            collected_at: "2026-03-30T02:00:00.000Z",
            shared_scratch_total_bytes: 186 * 1024 ** 3,
            shared_scratch_available_bytes: 10 * 1024 ** 3,
            shared_scratch_used_percent: 95,
          },
          {
            collected_at: "2026-03-30T02:01:00.000Z",
            shared_scratch_total_bytes: 186 * 1024 ** 3,
            shared_scratch_available_bytes: 9 * 1024 ** 3,
            shared_scratch_used_percent: 95.5,
          },
        ],
        growth: {
          window_minutes: 6,
          shared_scratch_used_bytes_per_hour: 2 * 1024 ** 3,
        },
        derived: {
          window_minutes: 6,
          disk: { level: "healthy" },
          shared_scratch: {
            level: "warning",
            available_bytes: 9 * 1024 ** 3,
            hours_to_exhaustion: 4.5,
            reason: "Shared scratch could exhaust within 24h",
          },
          metadata: { level: "healthy" },
          alerts: [],
          admission_allowed: true,
          auto_grow_recommended: true,
        },
      },
    });

    expect(result).toEqual({
      grown: false,
      reason: "provider does not support online shared scratch auto-grow",
    });
    expect(getProviderContextMock).not.toHaveBeenCalled();
  });
});
