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
let isDedicatedHostLaneCurrentlyAllowedMock: jest.Mock;

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
  isDedicatedHostLaneCurrentlyAllowed: (...args: any[]) =>
    isDedicatedHostLaneCurrentlyAllowedMock(...args),
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
      if (
        sql.includes("UPDATE project_hosts") &&
        sql.includes("SET status=$2")
      ) {
        expect(params?.[0]).toBe("host-1");
        expect(params?.[1]).toBe("stopping");
        expect(params?.[3].desired_state).toBe("stopped");
        expect(params?.[3].billing.stop_reason).toMatch(/window exhausted/i);
        return { rows: [] };
      }
      if (
        sql.includes("UPDATE project_hosts") &&
        sql.includes("SET metadata=$2")
      ) {
        expect(params?.[0]).toBe("host-1");
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
      funding_mode: "account-prepaid",
      effective_limits: {
        prepaid_host_usage_limit_5h_usd: 300,
        prepaid_host_usage_limit_7d_usd: 1000,
      },
      has_active_second_factor: true,
      has_payment_method: true,
      has_usage_subscription: false,
      balance: "0",
      postpaid_unbilled_exposure_usd: "0",
      postpaid_unbilled_limit_usd: "1000",
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
    isDedicatedHostLaneCurrentlyAllowedMock = jest.fn(() => false);
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

  it("keeps running site-funded hosts and closes any metered purchase session", async () => {
    getDedicatedHostPolicySnapshotForAccountMock = jest.fn(async () => ({
      account_id: "acc-1",
      membership_class: "member",
      can_create_hosts: true,
      funding_mode: "site-funded",
      effective_limits: {},
      has_active_second_factor: true,
      has_payment_method: false,
      has_usage_subscription: false,
      balance: "0",
      postpaid_unbilled_exposure_usd: "0",
      postpaid_unbilled_limit_usd: "0",
      dedicated_host_window_usage: {
        prepaid_5h_usd: "0",
        prepaid_7d_usd: "0",
        credit_5h_usd: "0",
        credit_7d_usd: "0",
      },
    }));
    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    expect(
      closeDedicatedHostPurchaseSessionForAccountMock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "acc-1",
        host_id: "host-1",
      }),
    );
    expect(
      reconcileDedicatedHostPurchaseSessionForAccountMock,
    ).not.toHaveBeenCalled();
    expect(enqueueCloudVmWorkMock).not.toHaveBeenCalled();
  });

  it("keeps running postpaid-funded hosts when the credit lane remains available", async () => {
    getDedicatedHostPolicySnapshotForAccountMock = jest.fn(async () => ({
      account_id: "acc-1",
      membership_class: "member",
      can_create_hosts: true,
      funding_mode: "account-postpaid",
      effective_limits: {
        credit_spend_limit_5h_usd: 300,
        credit_spend_limit_7d_usd: 1000,
      },
      has_active_second_factor: true,
      has_payment_method: true,
      has_usage_subscription: true,
      balance: "0",
      postpaid_unbilled_exposure_usd: "25",
      postpaid_unbilled_limit_usd: "1000",
      dedicated_host_window_usage: {
        prepaid_5h_usd: "0",
        prepaid_7d_usd: "0",
        credit_5h_usd: "100",
        credit_7d_usd: "150",
      },
    }));
    isDedicatedHostLaneCurrentlyAllowedMock = jest.fn(() => true);
    const admission = await import("./admission");
    (admission.selectDedicatedHostFundingLane as jest.Mock).mockReturnValue(
      "credit",
    );
    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    expect(
      reconcileDedicatedHostPurchaseSessionForAccountMock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "acc-1",
        host_id: "host-1",
        funding_lane: "credit",
        hourly_cost_usd: "12",
      }),
    );
    expect(enqueueCloudVmWorkMock).not.toHaveBeenCalled();
  });
});
