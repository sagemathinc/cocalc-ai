/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let queryMock: jest.Mock;
let enqueueCloudVmWorkMock: jest.Mock;
let getDedicatedHostPolicySnapshotForAccountMock: jest.Mock;
let estimateDedicatedHostRateUsdPerHourMock: jest.Mock;
let reconcileDedicatedHostPurchaseSessionForAccountMock: jest.Mock;
let closeDedicatedHostPurchaseSessionForAccountMock: jest.Mock;

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

jest.mock("@cocalc/server/cloud", () => ({
  __esModule: true,
  enqueueCloudVmWork: (...args: any[]) => enqueueCloudVmWorkMock(...args),
}));

jest.mock("./admission", () => ({
  __esModule: true,
  getDedicatedHostPolicySnapshotForAccount: (...args: any[]) =>
    getDedicatedHostPolicySnapshotForAccountMock(...args),
  isBillableDedicatedHostCloud: jest.fn(
    (provider?: string | null) =>
      provider === "gcp" || provider === "nebius" || provider === "hyperstack",
  ),
  selectDedicatedHostFundingLane: jest.fn(() => "prepaid"),
}));

jest.mock("./spend", () => ({
  __esModule: true,
  estimateDedicatedHostRateUsdPerHour: (...args: any[]) =>
    estimateDedicatedHostRateUsdPerHourMock(...args),
  isDedicatedHostLaneCurrentlyAllowed: jest.fn(() => false),
  reconcileDedicatedHostPurchaseSessionForAccount: (...args: any[]) =>
    reconcileDedicatedHostPurchaseSessionForAccountMock(...args),
  closeDedicatedHostPurchaseSessionForAccount: (...args: any[]) =>
    closeDedicatedHostPurchaseSessionForAccountMock(...args),
}));

describe("dedicated host spend maintenance", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: "host-1",
              name: "GPU Host",
              region: "us-central1",
              status: "running",
              metadata: {
                owner: "acc-1",
                size: "n1-standard-4",
                pricing_model: "on_demand",
                desired_state: "running",
                machine: {
                  cloud: "gcp",
                  machine_type: "n1-standard-4",
                  disk_gb: 100,
                  disk_type: "ssd",
                  storage_mode: "persistent",
                  zone: "us-central1-a",
                },
                billing: {
                  funding_lane: "prepaid",
                  hourly_cost_usd: "12",
                  started_at: "2026-05-07T00:00:00.000Z",
                },
              },
            },
          ],
        };
      }
      if (sql.includes("UPDATE project_hosts")) {
        expect(params?.[0]).toBe("host-1");
        expect(params?.[1]).toBe("stopping");
        expect(params?.[3].desired_state).toBe("stopped");
        expect(params?.[3].billing.stop_reason).toMatch(/window exhausted/i);
        return { rows: [] };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    enqueueCloudVmWorkMock = jest.fn(async () => undefined);
    getDedicatedHostPolicySnapshotForAccountMock = jest.fn(async () => ({
      account_id: "acc-1",
      membership_class: "member",
      can_create_hosts: true,
      effective_limits: {
        prepaid_host_usage_limit_5h_usd: 300,
        prepaid_host_usage_limit_7d_usd: 1000,
      },
      has_active_second_factor: true,
      has_payment_method: true,
      balance: "0",
      min_balance: "0",
      dedicated_host_window_usage: {
        prepaid_5h_usd: "300",
        prepaid_7d_usd: "400",
        credit_5h_usd: "0",
        credit_7d_usd: "0",
      },
    }));
    estimateDedicatedHostRateUsdPerHourMock = jest.fn(async () => "12");
    reconcileDedicatedHostPurchaseSessionForAccountMock = jest.fn(
      async () => undefined,
    );
    closeDedicatedHostPurchaseSessionForAccountMock = jest.fn(
      async () => undefined,
    );
  });

  it("stops a running host when its active prepaid lane is exhausted", async () => {
    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    expect(
      reconcileDedicatedHostPurchaseSessionForAccountMock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "acc-1",
        host_id: "host-1",
        funding_lane: "prepaid",
        hourly_cost_usd: "12",
      }),
    );
    expect(enqueueCloudVmWorkMock).toHaveBeenCalledWith({
      vm_id: "host-1",
      action: "stop",
      payload: { provider: "gcp" },
    });
  });
});
