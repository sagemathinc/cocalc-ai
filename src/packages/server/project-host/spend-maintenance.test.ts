/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let queryMock: jest.Mock;
let connectMock: jest.Mock;
let releaseMock: jest.Mock;
let withSessionAdvisoryLockMock: jest.Mock;
let enqueueCloudVmWorkMock: jest.Mock;
let getDedicatedHostPolicySnapshotForAccountMock: jest.Mock;
let estimateDedicatedHostRateMock: jest.Mock;
let dedicatedHostRateFromPricingSnapshotMock: jest.Mock;
let getDedicatedHostWindowUsageForHostLocalMock: jest.Mock;
let reconcileDedicatedHostPurchaseSessionForAccountMock: jest.Mock;
let closeDedicatedHostPurchaseSessionForAccountMock: jest.Mock;
let isDedicatedHostLaneCurrentlyAllowedMock: jest.Mock;
let createLroMock: jest.Mock;
let notifyDedicatedHostBillingEnforcementBestEffortMock: jest.Mock;
let notifyDedicatedHostDeprovisionReminderBestEffortMock: jest.Mock;
let adminAlertMock: jest.Mock;

function rateEstimate(
  hourly_cost_usd: string,
  billing_state: "running" | "stopped" = "running",
) {
  const key = billing_state === "running" ? "vm" : "disk";
  return {
    hourly_cost_usd,
    pricing_snapshot: {
      version: 1,
      billing_state,
      hourly_cost_usd,
      components: [
        {
          key,
          label: billing_state === "running" ? "VM" : "Persistent disk",
          hourly_cost_usd,
          billing_states:
            billing_state === "running"
              ? (["running"] as const)
              : (["running", "stopped"] as const),
        },
      ],
      configuration: {},
    },
  };
}

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
    connect: (...args: any[]) => connectMock(...args),
  })),
  withSessionAdvisoryLock: (...args: any[]) =>
    withSessionAdvisoryLockMock(...args),
}));

jest.mock("@cocalc/server/cloud", () => ({
  __esModule: true,
  enqueueCloudVmWork: (...args: any[]) => enqueueCloudVmWorkMock(...args),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  createLro: (...args: any[]) => createLroMock(...args),
}));

jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: (...args: any[]) => adminAlertMock(...args),
}));

jest.mock("./billing-notifications", () => ({
  __esModule: true,
  notifyDedicatedHostBillingEnforcementBestEffort: (...args: any[]) =>
    notifyDedicatedHostBillingEnforcementBestEffortMock(...args),
  notifyDedicatedHostDeprovisionReminderBestEffort: (...args: any[]) =>
    notifyDedicatedHostDeprovisionReminderBestEffortMock(...args),
}));

jest.mock("./admission", () => ({
  __esModule: true,
  applyDedicatedHostFundingModeOverride: jest.fn(
    (snapshot: any, funding_mode_override?: string) =>
      funding_mode_override == null
        ? snapshot
        : { ...snapshot, funding_mode: funding_mode_override },
  ),
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
  dedicatedHostRateFromPricingSnapshot: (...args: any[]) =>
    dedicatedHostRateFromPricingSnapshotMock(...args),
  estimateDedicatedHostRate: (...args: any[]) =>
    estimateDedicatedHostRateMock(...args),
  getDedicatedHostWindowUsageForHostLocal: (...args: any[]) =>
    getDedicatedHostWindowUsageForHostLocalMock(...args),
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
    releaseMock = jest.fn();
    connectMock = jest.fn(async () => ({
      query: (...args: any[]) => queryMock(...args),
      release: releaseMock,
    }));
    withSessionAdvisoryLockMock = jest.fn(
      async ({ fn }: { fn: () => Promise<unknown> }) => await fn(),
    );
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
                  shared_disk_gb: 500,
                  shared_disk_type: "balanced",
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
        if (params?.[1] === "draining") {
          expect(params?.[2].billing.enforcement.state).toBe("draining");
        } else {
          expect(params?.[1]).toBe("stopping");
          expect(params?.[3].billing.owner_spend_limit_status.state).toBe(
            "stopped_limit_exceeded",
          );
        }
        return { rows: [], rowCount: 1 };
      }
      if (
        sql.includes("UPDATE project_hosts") &&
        sql.includes("SET metadata=(")
      ) {
        expect(params?.[0]).toBe("host-1");
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    enqueueCloudVmWorkMock = jest.fn(async () => undefined);
    createLroMock = jest.fn(async () => ({ op_id: "op-1" }));
    notifyDedicatedHostBillingEnforcementBestEffortMock = jest.fn(
      async () => true,
    );
    notifyDedicatedHostDeprovisionReminderBestEffortMock = jest.fn(
      async () => true,
    );
    adminAlertMock = jest.fn(async () => undefined);
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
      dedicated_host_window_usage: {
        prepaid_5h_usd: "300",
        prepaid_7d_usd: "400",
        credit_5h_usd: "0",
        credit_7d_usd: "0",
      },
    }));
    estimateDedicatedHostRateMock = jest.fn(
      async ({ billing_state = "running" } = {}) =>
        rateEstimate("12", billing_state),
    );
    dedicatedHostRateFromPricingSnapshotMock = jest.fn(() => undefined);
    getDedicatedHostWindowUsageForHostLocalMock = jest.fn(async () => ({
      spend_5h_usd: "0",
      spend_7d_usd: "0",
    }));
    reconcileDedicatedHostPurchaseSessionForAccountMock = jest.fn(
      async () => undefined,
    );
    closeDedicatedHostPurchaseSessionForAccountMock = jest.fn(
      async () => undefined,
    );
    isDedicatedHostLaneCurrentlyAllowedMock = jest.fn(() => false);
  });

  it("uses stopped pricing when the provider reports the instance missing", async () => {
    const { billingStateForHost } = await import("./spend-maintenance");

    expect(
      billingStateForHost({
        id: "host-1",
        name: "Missing GPU Host",
        region: "eu-north1",
        status: "error",
        metadata: {
          runtime: {
            instance_id: "computeinstance-missing",
            provider_status: "missing",
          },
        },
      }),
    ).toBe("stopped");
  });

  it("keeps transient host errors billable while the provider VM exists", async () => {
    const { billingStateForHost } = await import("./spend-maintenance");

    expect(
      billingStateForHost({
        id: "host-1",
        name: "Temporarily Unreachable GPU Host",
        region: "eu-north1",
        status: "error",
        metadata: {
          runtime: {
            instance_id: "computeinstance-running",
            provider_status: "RUNNING",
          },
        },
      }),
    ).toBe("running");
  });

  it("uses the shared session-affine advisory lock", async () => {
    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    expect(withSessionAdvisoryLockMock).toHaveBeenCalledWith({
      lockKey: "dedicated_host_spend_maintenance",
      fn: expect.any(Function),
    });
  });

  it("requests a drain when a running host active prepaid lane is exhausted", async () => {
    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    expect(estimateDedicatedHostRateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        shared_disk_gb: 500,
        shared_disk_type: "balanced",
      }),
    );
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
    expect(createLroMock).toHaveBeenCalledWith({
      kind: "host-drain",
      scope_type: "host",
      scope_id: "host-1",
      created_by: "acc-1",
      routing: "hub",
      input: {
        id: "host-1",
        account_id: "acc-1",
        allow_offline: false,
        force: false,
        managed_egress_override: "admin-host-drain",
        billing_enforcement: true,
      },
      dedupe_key: "host-drain:billing:host-1",
      status: "queued",
    });
    expect(
      notifyDedicatedHostBillingEnforcementBestEffortMock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_account_id: "acc-1",
        host_id: "host-1",
        host_name: "GPU Host",
        state: "draining",
        reason: "prepaid balance is exhausted",
      }),
    );
    expect(enqueueCloudVmWorkMock).not.toHaveBeenCalled();
  });

  it("does not queue a drain when a relocation took the host after it was read", async () => {
    const readRow = queryMock;
    queryMock = jest.fn(async (sql: string, params?: any[]) =>
      sql.includes("UPDATE project_hosts")
        ? { rows: [], rowCount: 0 }
        : await readRow(sql, params),
    );
    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    // A relocation took the host after this pass read it: nothing queued.
    expect(createLroMock).not.toHaveBeenCalled();
    expect(enqueueCloudVmWorkMock).not.toHaveBeenCalled();
    expect(
      notifyDedicatedHostBillingEnforcementBestEffortMock,
    ).not.toHaveBeenCalled();
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

  it("keeps a prepaid-funded host running when the site-default snapshot is site-funded", async () => {
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
                  shared_disk_gb: 500,
                  shared_disk_type: "balanced",
                  storage_mode: "persistent",
                  zone: "us-central1-a",
                },
                billing: {
                  funding_mode: "account-prepaid",
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
        sql.includes("SET metadata=(")
      ) {
        expect(params?.[0]).toBe("host-1");
        expect(params?.[1].billing.funding_mode).toBe("account-prepaid");
        expect(params?.[1].billing.enforcement.state).toBe("ok");
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    getDedicatedHostPolicySnapshotForAccountMock = jest.fn(
      async ({ funding_mode_override }) => ({
        account_id: "acc-1",
        membership_class: "member",
        can_create_hosts: true,
        funding_mode: funding_mode_override ?? "site-funded",
        effective_limits:
          funding_mode_override === "account-prepaid"
            ? {
                prepaid_host_usage_limit_5h_usd: 300,
                prepaid_host_usage_limit_7d_usd: 1000,
              }
            : {},
        has_active_second_factor: true,
        has_payment_method: false,
        has_usage_subscription: false,
        balance: funding_mode_override === "account-prepaid" ? "25" : "0",
        postpaid_unbilled_exposure_usd: "0",
        dedicated_host_window_usage: {
          prepaid_5h_usd: "0",
          prepaid_7d_usd: "0",
          credit_5h_usd: "0",
          credit_7d_usd: "0",
        },
      }),
    );
    isDedicatedHostLaneCurrentlyAllowedMock = jest.fn(({ snapshot }) => {
      expect(snapshot.funding_mode).toBe("account-prepaid");
      return true;
    });

    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    expect(getDedicatedHostPolicySnapshotForAccountMock).toHaveBeenCalledWith({
      account_id: "acc-1",
      funding_mode_override: "account-prepaid",
    });
    expect(
      reconcileDedicatedHostPurchaseSessionForAccountMock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "acc-1",
        host_id: "host-1",
        funding_lane: "prepaid",
      }),
    );
    expect(createLroMock).not.toHaveBeenCalled();
    expect(enqueueCloudVmWorkMock).not.toHaveBeenCalled();
  });

  it("respects a host-level site-funded override even when the account snapshot is prepaid", async () => {
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
                  funding_mode: "site-funded",
                  started_at: "2026-05-07T00:00:00.000Z",
                },
              },
            },
          ],
        };
      }
      if (
        sql.includes("UPDATE project_hosts") &&
        sql.includes("SET metadata=(")
      ) {
        expect(params?.[1]?.billing).toEqual({
          funding_mode: "site-funded",
          started_at: "2026-05-07T00:00:00.000Z",
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
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
      dedicated_host_window_usage: {
        prepaid_5h_usd: "300",
        prepaid_7d_usd: "400",
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

  it("stops a running host when the owner-configured host spend cap is exceeded", async () => {
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
                  owner_spend_limit_5h_usd: 25,
                  owner_spend_limit_7d_usd: 1000,
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
        expect(params?.[3].billing.owner_spend_limit_status).toEqual(
          expect.objectContaining({
            state: "stopped_limit_exceeded",
            exceeded_window: "5h",
            limit_5h_usd: 25,
            used_5h_usd: "30.0000000000",
          }),
        );
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    isDedicatedHostLaneCurrentlyAllowedMock = jest.fn(() => true);
    getDedicatedHostWindowUsageForHostLocalMock = jest.fn(async () => ({
      spend_5h_usd: "30",
      spend_7d_usd: "30",
    }));

    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    expect(
      reconcileDedicatedHostPurchaseSessionForAccountMock,
    ).toHaveBeenCalled();
    expect(enqueueCloudVmWorkMock).toHaveBeenCalledWith({
      vm_id: "host-1",
      action: "stop",
      payload: { provider: "gcp", intent_generation: 0 },
    });
    expect(createLroMock).not.toHaveBeenCalled();
  });

  it("leaves a host being relocated alone", async () => {
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
              maintenance: { kind: "relocation", state: "in_progress" },
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
                  owner_spend_limit_5h_usd: 25,
                  owner_spend_limit_7d_usd: 1000,
                },
              },
            },
          ],
        };
      }
      if (sql.includes("UPDATE project_hosts")) {
        throw new Error("must not write a host being relocated");
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    isDedicatedHostLaneCurrentlyAllowedMock = jest.fn(() => true);
    getDedicatedHostWindowUsageForHostLocalMock = jest.fn(async () => ({
      spend_5h_usd: "30",
      spend_7d_usd: "30",
    }));

    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    expect(enqueueCloudVmWorkMock).not.toHaveBeenCalled();
  });

  it("does not queue a stop when a relocation took the host after it was read", async () => {
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
                  owner_spend_limit_5h_usd: 25,
                  owner_spend_limit_7d_usd: 1000,
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
        expect(params?.[3].billing.owner_spend_limit_status).toEqual(
          expect.objectContaining({
            state: "stopped_limit_exceeded",
            exceeded_window: "5h",
            limit_5h_usd: 25,
            used_5h_usd: "30.0000000000",
          }),
        );
        // Guarded on the fence and on the placement it read.
        expect(sql).toContain("maintenance->>'state'");
        // Only the keys this pass changed are written.
        expect(Object.keys(params?.[3]).sort()).toEqual([
          "billing",
          "desired_state",
          "last_action",
          "last_action_at",
          "last_action_error",
          "last_action_status",
        ]);
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    isDedicatedHostLaneCurrentlyAllowedMock = jest.fn(() => true);
    getDedicatedHostWindowUsageForHostLocalMock = jest.fn(async () => ({
      spend_5h_usd: "30",
      spend_7d_usd: "30",
    }));

    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    expect(enqueueCloudVmWorkMock).not.toHaveBeenCalled();
  });
  it("preserves an explicit site-funded policy on inactive hosts", async () => {
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
              status: "off",
              metadata: {
                owner: "acc-1",
                size: "n1-standard-4",
                pricing_model: "on_demand",
                desired_state: "stopped",
                machine: {
                  cloud: "gcp",
                  machine_type: "n1-standard-4",
                },
                billing: {
                  funding_mode: "site-funded",
                  started_at: "2026-05-07T00:00:00.000Z",
                },
              },
            },
          ],
        };
      }
      if (
        sql.includes("UPDATE project_hosts") &&
        sql.includes("SET metadata=(")
      ) {
        // Only changed keys are written: the unchanged site-funded billing
        // policy is neither rewritten nor removed.
        expect(params?.[1]?.billing).toBeUndefined();
        expect(params?.[2]).not.toContain("billing");
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

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

  it("stops after billing drain has removed all assigned projects", async () => {
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
              status: "draining",
              metadata: {
                owner: "acc-1",
                desired_state: "running",
                machine: {
                  cloud: "gcp",
                  machine_type: "n1-standard-4",
                },
                billing: {
                  funding_mode: "account-prepaid",
                  funding_lane: "prepaid",
                  enforcement: {
                    state: "draining",
                    reason: "prepaid balance is exhausted",
                    final_backup_status: "running",
                  },
                },
              },
            },
          ],
        };
      }
      if (sql.includes("COUNT(*)::text AS count")) {
        expect(params?.[0]).toBe("host-1");
        return { rows: [{ count: "0" }] };
      }
      if (
        sql.includes("UPDATE project_hosts") &&
        sql.includes("SET status=$2")
      ) {
        expect(params?.[0]).toBe("host-1");
        expect(params?.[1]).toBe("stopping");
        expect(params?.[3].desired_state).toBe("stopped");
        expect(params?.[3].billing.enforcement.state).toBe(
          "stopped_billing_blocked",
        );
        expect(params?.[3].billing.enforcement.final_backup_status).toBe(
          "succeeded",
        );
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    expect(enqueueCloudVmWorkMock).toHaveBeenCalledWith({
      vm_id: "host-1",
      action: "stop",
      payload: { provider: "gcp", intent_generation: 0 },
    });
    expect(
      notifyDedicatedHostBillingEnforcementBestEffortMock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_account_id: "acc-1",
        host_id: "host-1",
        state: "stopped_billing_blocked",
        previous_state: "draining",
        final_backup_status: "succeeded",
      }),
    );
    expect(createLroMock).not.toHaveBeenCalled();
  });

  it("queues deprovision after stopped billing grace expires", async () => {
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
              status: "off",
              metadata: {
                owner: "acc-1",
                desired_state: "stopped",
                machine: {
                  cloud: "gcp",
                  machine_type: "n1-standard-4",
                },
                billing: {
                  funding_mode: "account-prepaid",
                  enforcement: {
                    state: "stopped_billing_blocked",
                    reason: "prepaid balance is exhausted",
                    final_backup_status: "succeeded",
                    deprovision_after: "2026-01-01T00:00:00.000Z",
                  },
                },
              },
            },
          ],
        };
      }
      if (
        sql.includes("UPDATE project_hosts") &&
        sql.includes("SET metadata=(")
      ) {
        expect(params?.[0]).toBe("host-1");
        expect(params?.[1].billing.enforcement.state).toBe(
          "deprovision_pending",
        );
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    expect(closeDedicatedHostPurchaseSessionForAccountMock).toHaveBeenCalled();
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "host-deprovision",
        scope_type: "host",
        scope_id: "host-1",
        input: expect.objectContaining({
          id: "host-1",
          account_id: "acc-1",
          skip_backups: true,
          billing_enforcement: true,
        }),
      }),
    );
    expect(
      notifyDedicatedHostBillingEnforcementBestEffortMock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_account_id: "acc-1",
        host_id: "host-1",
        state: "deprovision_pending",
        previous_state: "stopped_billing_blocked",
      }),
    );
  });

  it("does not queue a deprovision when a relocation took the host after it was read", async () => {
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
              status: "off",
              metadata: {
                owner: "acc-1",
                desired_state: "stopped",
                machine: {
                  cloud: "gcp",
                  machine_type: "n1-standard-4",
                },
                billing: {
                  funding_mode: "account-prepaid",
                  enforcement: {
                    state: "stopped_billing_blocked",
                    reason: "prepaid balance is exhausted",
                    final_backup_status: "succeeded",
                    deprovision_after: "2026-01-01T00:00:00.000Z",
                  },
                },
              },
            },
          ],
        };
      }
      if (
        sql.includes("UPDATE project_hosts") &&
        sql.includes("SET metadata=(")
      ) {
        expect(params?.[0]).toBe("host-1");
        expect(params?.[1].billing.enforcement.state).toBe(
          "deprovision_pending",
        );
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    // A relocation took the host after this pass read it: nothing queued.
    expect(createLroMock).not.toHaveBeenCalled();
    expect(enqueueCloudVmWorkMock).not.toHaveBeenCalled();
    expect(
      notifyDedicatedHostBillingEnforcementBestEffortMock,
    ).not.toHaveBeenCalled();
  });
  it("automatically clears inactive billing enforcement after limits recover", async () => {
    isDedicatedHostLaneCurrentlyAllowedMock = jest.fn(() => true);
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
      balance: "250",
      postpaid_unbilled_exposure_usd: "0",
      dedicated_host_window_usage: {
        prepaid_5h_usd: "10",
        prepaid_7d_usd: "20",
        credit_5h_usd: "0",
        credit_7d_usd: "0",
      },
    }));
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
              status: "off",
              metadata: {
                owner: "acc-1",
                desired_state: "stopped",
                machine: {
                  cloud: "gcp",
                  machine_type: "n1-standard-4",
                },
                billing: {
                  funding_mode: "account-prepaid",
                  enforcement: {
                    state: "stopped_billing_blocked",
                    reason: "prepaid balance is exhausted",
                    final_backup_status: "succeeded",
                    deprovision_after: "2026-01-01T00:00:00.000Z",
                  },
                },
              },
            },
          ],
        };
      }
      if (
        sql.includes("UPDATE project_hosts") &&
        sql.includes("SET metadata=(")
      ) {
        expect(params?.[0]).toBe("host-1");
        expect(params?.[1].billing.enforcement).toEqual({ state: "ok" });
        expect(params?.[1].billing.funding_lane).toBe("prepaid");
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    expect(closeDedicatedHostPurchaseSessionForAccountMock).toHaveBeenCalled();
    expect(
      notifyDedicatedHostBillingEnforcementBestEffortMock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_account_id: "acc-1",
        host_id: "host-1",
        state: "ok",
        previous_state: "stopped_billing_blocked",
      }),
    );
    expect(createLroMock).not.toHaveBeenCalled();
  });

  it("marks deprovisioned billing-enforced hosts as recoverable", async () => {
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
              status: "deprovisioned",
              metadata: {
                owner: "acc-1",
                desired_state: "stopped",
                machine: {
                  cloud: "gcp",
                  machine_type: "n1-standard-4",
                },
                billing: {
                  funding_mode: "account-prepaid",
                  enforcement: {
                    state: "deprovision_pending",
                    reason: "prepaid balance is exhausted",
                    final_backup_status: "succeeded",
                  },
                },
              },
            },
          ],
        };
      }
      if (
        sql.includes("UPDATE project_hosts") &&
        sql.includes("SET metadata=(")
      ) {
        expect(params?.[0]).toBe("host-1");
        expect(params?.[1].billing.enforcement.state).toBe(
          "deprovisioned_recoverable",
        );
        expect(params?.[1].billing.enforcement.deprovisioned_at).toBeTruthy();
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    expect(closeDedicatedHostPurchaseSessionForAccountMock).toHaveBeenCalled();
    expect(
      notifyDedicatedHostBillingEnforcementBestEffortMock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_account_id: "acc-1",
        host_id: "host-1",
        state: "deprovisioned_recoverable",
        previous_state: "deprovision_pending",
      }),
    );
    expect(createLroMock).not.toHaveBeenCalled();
  });

  it("keeps an explicit stopped billing session for retained provider resources", async () => {
    getDedicatedHostPolicySnapshotForAccountMock = jest.fn(async () => ({
      account_id: "acc-1",
      funding_mode: "account-prepaid",
      effective_limits: {
        prepaid_host_usage_limit_5h_usd: 300,
        prepaid_host_usage_limit_7d_usd: 1000,
      },
      has_payment_method: true,
      has_usage_subscription: false,
      balance: "1000",
      dedicated_host_window_usage: {
        prepaid_5h_usd: "0",
        prepaid_7d_usd: "0",
        credit_5h_usd: "0",
        credit_7d_usd: "0",
      },
    }));
    isDedicatedHostLaneCurrentlyAllowedMock = jest.fn(() => true);
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: "host-1",
              name: "GPU Host",
              region: "us-central1",
              status: "off",
              metadata: {
                owner: "acc-1",
                size: "n1-standard-4",
                runtime: { instance_id: "gcp-host-1" },
                machine: {
                  cloud: "gcp",
                  machine_type: "n1-standard-4",
                  disk_gb: 100,
                  disk_type: "balanced",
                },
                billing: {
                  funding_mode: "account-prepaid",
                  funding_lane: "prepaid",
                },
              },
            },
          ],
        };
      }
      if (
        sql.includes("UPDATE project_hosts") &&
        sql.includes("SET metadata=(")
      ) {
        expect(params?.[1].billing.hourly_cost_usd).toBe("12");
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    expect(estimateDedicatedHostRateMock).toHaveBeenCalledWith(
      expect.objectContaining({ billing_state: "stopped" }),
    );
    expect(
      reconcileDedicatedHostPurchaseSessionForAccountMock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "host-1",
        billing_state: "stopped",
        pricing_snapshot: expect.objectContaining({
          billing_state: "stopped",
        }),
      }),
    );
    expect(
      closeDedicatedHostPurchaseSessionForAccountMock,
    ).not.toHaveBeenCalled();
  });

  it("uses the last immutable snapshot when stopped pricing is temporarily unavailable", async () => {
    estimateDedicatedHostRateMock = jest.fn(async () => undefined);
    dedicatedHostRateFromPricingSnapshotMock = jest.fn(() =>
      rateEstimate("0.5", "stopped"),
    );
    getDedicatedHostPolicySnapshotForAccountMock = jest.fn(async () => ({
      account_id: "acc-1",
      funding_mode: "account-prepaid",
      effective_limits: {
        prepaid_host_usage_limit_5h_usd: 300,
        prepaid_host_usage_limit_7d_usd: 1000,
      },
      has_payment_method: true,
      has_usage_subscription: false,
      balance: "1000",
      dedicated_host_window_usage: {
        prepaid_5h_usd: "0",
        prepaid_7d_usd: "0",
        credit_5h_usd: "0",
        credit_7d_usd: "0",
      },
    }));
    isDedicatedHostLaneCurrentlyAllowedMock = jest.fn(() => true);
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: "host-1",
              name: "GPU Host",
              region: "us-central1",
              status: "stopped",
              metadata: {
                owner: "acc-1",
                runtime: { instance_id: "gcp-host-1" },
                machine: {
                  cloud: "gcp",
                  machine_type: "n1-standard-4",
                  disk_gb: 100,
                  disk_type: "balanced",
                },
                billing: {
                  funding_mode: "account-prepaid",
                  funding_lane: "prepaid",
                  pricing_snapshot: rateEstimate("12").pricing_snapshot,
                },
              },
            },
          ],
        };
      }
      if (
        sql.includes("UPDATE project_hosts") &&
        sql.includes("SET metadata=(")
      ) {
        expect(params?.[1].billing.pricing_snapshot.billing_state).toBe(
          "stopped",
        );
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    expect(dedicatedHostRateFromPricingSnapshotMock).toHaveBeenCalledWith({
      pricing_snapshot: expect.objectContaining({ billing_state: "running" }),
      billing_state: "stopped",
    });
    expect(
      reconcileDedicatedHostPurchaseSessionForAccountMock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "host-1",
        billing_state: "stopped",
        hourly_cost_usd: "0.5",
      }),
    );
    expect(
      closeDedicatedHostPurchaseSessionForAccountMock,
    ).not.toHaveBeenCalled();
  });

  it("does not fail open when stopped pricing and its fallback are unavailable", async () => {
    estimateDedicatedHostRateMock = jest.fn(async () => undefined);
    dedicatedHostRateFromPricingSnapshotMock = jest.fn(() => undefined);
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: "host-1",
              name: "GPU Host",
              region: "us-central1",
              status: "off",
              metadata: {
                owner: "acc-1",
                runtime: { instance_id: "gcp-host-1" },
                machine: {
                  cloud: "gcp",
                  machine_type: "n1-standard-4",
                  disk_gb: 100,
                  disk_type: "balanced",
                },
                billing: {
                  funding_mode: "account-prepaid",
                  funding_lane: "prepaid",
                },
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    expect(
      reconcileDedicatedHostPurchaseSessionForAccountMock,
    ).not.toHaveBeenCalled();
    expect(
      closeDedicatedHostPurchaseSessionForAccountMock,
    ).not.toHaveBeenCalled();
    expect(adminAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Stopped dedicated-host pricing unavailable: host-1",
      }),
    );
  });

  it("does not deprovision a stopped host whose projects are not confirmed recoverable", async () => {
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: "host-1",
              name: "GPU Host",
              region: "us-central1",
              status: "off",
              metadata: {
                owner: "acc-1",
                runtime: { instance_id: "gcp-host-1" },
                machine: {
                  cloud: "gcp",
                  machine_type: "n1-standard-4",
                  disk_gb: 100,
                  disk_type: "balanced",
                },
                billing: {
                  funding_mode: "account-prepaid",
                  funding_lane: "prepaid",
                },
              },
            },
          ],
        };
      }
      if (sql.includes("COUNT(*)::text AS count")) {
        return { rows: [{ count: "1" }] };
      }
      if (
        sql.includes("UPDATE project_hosts") &&
        sql.includes("SET metadata=(")
      ) {
        expect(params?.[1].billing.enforcement).toMatchObject({
          state: "stopped_billing_blocked",
          final_backup_status: "unknown",
        });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { runDedicatedHostSpendMaintenancePass } =
      await import("./spend-maintenance");
    await runDedicatedHostSpendMaintenancePass();

    expect(createLroMock).not.toHaveBeenCalled();
  });

  it("sends and records the final reminder during the last 24 hours of grace", async () => {
    const deprovisionAfter = new Date(Date.now() + 12 * 3600_000).toISOString();
    const run = async ({
      reserved,
      sent,
    }: {
      reserved: boolean;
      sent: boolean;
    }) => {
      jest.resetModules();
      const updates: Array<{ sql: string; params?: any[] }> = [];
      notifyDedicatedHostDeprovisionReminderBestEffortMock = jest.fn(
        async () => sent,
      );
      queryMock = jest.fn(async (sql: string, params?: any[]) => {
        if (sql.includes("FROM project_hosts")) {
          return {
            rows: [
              {
                id: "host-1",
                name: "GPU Host",
                region: "us-central1",
                status: "off",
                metadata: {
                  owner: "acc-1",
                  machine: {
                    cloud: "gcp",
                    machine_type: "n1-standard-4",
                  },
                  billing: {
                    funding_mode: "account-prepaid",
                    enforcement: {
                      state: "stopped_billing_blocked",
                      final_backup_status: "succeeded",
                      deprovision_after: deprovisionAfter,
                    },
                  },
                },
              },
            ],
          };
        }
        if (sql.includes("UPDATE project_hosts")) {
          updates.push({ sql, params });
          if (sql.includes("deprovision_reminder_sent_at' IS NULL")) {
            return { rows: [], rowCount: reserved ? 1 : 0 };
          }
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unexpected query: ${sql}`);
      });
      const { runDedicatedHostSpendMaintenancePass } =
        await import("./spend-maintenance");
      await runDedicatedHostSpendMaintenancePass();
      return updates;
    };

    // Reserved first, then sent: recorded once, nothing to undo.
    let updates = await run({ reserved: true, sent: true });
    expect(
      notifyDedicatedHostDeprovisionReminderBestEffortMock,
    ).toHaveBeenCalledWith({
      owner_account_id: "acc-1",
      host_id: "host-1",
      host_name: "GPU Host",
      deprovision_after: deprovisionAfter,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain(
      "NOT IN ('preparing','in_progress','failed')",
    );
    expect(createLroMock).not.toHaveBeenCalled();

    // Another pass (or a relocation) got there first: nothing is sent.
    updates = await run({ reserved: false, sent: true });
    expect(
      notifyDedicatedHostDeprovisionReminderBestEffortMock,
    ).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);

    // The send failed: only this pass's reservation is released.
    updates = await run({ reserved: true, sent: false });
    expect(updates).toHaveLength(2);
    expect(updates[1].sql).toContain(
      "#- '{billing,enforcement,deprovision_reminder_sent_at}'",
    );
    expect(updates[1].params?.[1]).toBe(updates[0].params?.[1]);
  });

  it("tells the owner of a running host about a change only once it is stored", async () => {
    // A postpaid host whose credit lane has room again.
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
      dedicated_host_window_usage: {
        prepaid_5h_usd: "0",
        prepaid_7d_usd: "0",
        credit_5h_usd: "100",
        credit_7d_usd: "150",
      },
    }));
    isDedicatedHostLaneCurrentlyAllowedMock = jest.fn(() => true);
    const readRows = queryMock;
    for (const stored of [false, true]) {
      jest.resetModules();
      const admission = await import("./admission");
      (admission.selectDedicatedHostFundingLane as jest.Mock).mockReturnValue(
        "credit",
      );
      notifyDedicatedHostBillingEnforcementBestEffortMock.mockClear();
      queryMock = jest.fn(async (sql: string, params?: any[]) => {
        if (sql.includes("UPDATE project_hosts")) {
          return { rows: [], rowCount: stored ? 1 : 0 };
        }
        const result = await readRows(sql, params);
        if (sql.includes("FROM project_hosts")) {
          // It was at risk; its lanes have recovered.
          for (const row of result.rows ?? []) {
            row.metadata = {
              ...row.metadata,
              billing: {
                ...(row.metadata?.billing ?? {}),
                enforcement: { state: "at_risk", reason: "low runway" },
              },
            };
          }
        }
        return result;
      });
      const { runDedicatedHostSpendMaintenancePass } =
        await import("./spend-maintenance");
      await runDedicatedHostSpendMaintenancePass();
      expect(
        notifyDedicatedHostBillingEnforcementBestEffortMock,
      ).toHaveBeenCalledTimes(stored ? 1 : 0);
    }
  });

  it("tells the owner billing recovered only once the change is stored", async () => {
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
      dedicated_host_window_usage: {
        prepaid_5h_usd: "0",
        prepaid_7d_usd: "0",
        credit_5h_usd: "0",
        credit_7d_usd: "0",
      },
    }));
    const readRows = queryMock;
    for (const stored of [false, true]) {
      jest.resetModules();
      notifyDedicatedHostBillingEnforcementBestEffortMock.mockClear();
      queryMock = jest.fn(async (sql: string, params?: any[]) => {
        if (sql.includes("UPDATE project_hosts")) {
          return { rows: [], rowCount: stored ? 1 : 0 };
        }
        if (sql.includes("COUNT(*)::text AS count")) {
          return { rows: [{ count: "1" }] };
        }
        const result = await readRows(sql, params);
        if (sql.includes("FROM project_hosts")) {
          // A stopped host that was at risk, whose owner is now site-funded.
          for (const row of result.rows ?? []) {
            row.status = "off";
            row.metadata = {
              ...row.metadata,
              desired_state: "stopped",
              runtime: { instance_id: "instance-1" },
              billing: {
                ...(row.metadata?.billing ?? {}),
                enforcement: { state: "at_risk", reason: "low runway" },
              },
            };
          }
        }
        return result;
      });
      const { runDedicatedHostSpendMaintenancePass } =
        await import("./spend-maintenance");
      await runDedicatedHostSpendMaintenancePass();
      expect(
        notifyDedicatedHostBillingEnforcementBestEffortMock,
      ).toHaveBeenCalledTimes(stored ? 1 : 0);
    }
  });
});

describe("spend maintenance metadata patches", () => {
  it("writes only the keys a pass changed", async () => {
    const { metadataPatch } = await import("./spend-maintenance");
    // Read before a relocation that later rolled back: the pass changed only
    // billing, so placement, runtime and intent restored meanwhile survive.
    const read = {
      owner: "acc-1",
      desired_state: "running",
      machine: { zone: "us-south1-c", machine_type: "t2d-standard-16" },
      runtime: { instance_id: "i-1" },
      billing: { enforcement: { state: "ok" } },
      last_action_error: "old",
    };
    const next = {
      ...read,
      billing: { enforcement: { state: "draining" } },
      last_action_error: undefined,
    };
    expect(metadataPatch(read, next)).toEqual({
      set: { billing: { enforcement: { state: "draining" } } },
      remove: ["last_action_error"],
    });
    expect(metadataPatch(read, { ...read })).toEqual({ set: {}, remove: [] });
  });
});
