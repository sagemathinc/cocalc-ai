export {};

let queryMock: jest.Mock;
let resolveMembershipForAccountMock: jest.Mock;
let getServerSettingsMock: jest.Mock;
let enqueueCloudVmWorkMock: jest.Mock;
let hasActiveSecondFactorMock: jest.Mock;
let hasPaymentMethodMock: jest.Mock;
let getBalanceMock: jest.Mock;
let resolveAccountHomeBayMock: jest.Mock;
let assertDedicatedHostAdmissionForAccountMock: jest.Mock;
let getDedicatedHostPolicySnapshotForAccountMock: jest.Mock;
let isBillableDedicatedHostCloudMock: jest.Mock;
let selectDedicatedHostFundingLaneMock: jest.Mock;
let estimateDedicatedHostRateUsdPerHourMock: jest.Mock;
let reconcileDedicatedHostPurchaseSessionForAccountMock: jest.Mock;
let requireFreshAuthForSessionHashMock: jest.Mock;

const ACCOUNT_ID = "81e787c4-8705-46c5-86df-9d07bc424a01";

function maybeHandleAccountDirectoryQuery(sql: string, params: any[]) {
  if (
    sql.includes("CREATE TABLE IF NOT EXISTS cluster_account_directory") ||
    sql.includes("CREATE INDEX IF NOT EXISTS cluster_account_directory_")
  ) {
    return { rows: [], rowCount: 0 };
  }
  if (
    sql.includes("FROM cluster_account_directory") &&
    sql.includes("WHERE account_id=$1")
  ) {
    expect(params[0]).toBe(ACCOUNT_ID);
    return { rows: [] };
  }
  if (
    sql.includes("FROM accounts") &&
    sql.includes("email_address_verified") &&
    sql.includes("WHERE account_id=$1")
  ) {
    expect(params[0]).toBe(ACCOUNT_ID);
    return {
      rows: [
        {
          account_id: ACCOUNT_ID,
          first_name: "Test",
          last_name: "User",
          email_address: "test@example.com",
          home_bay_id: "bay-0",
          created: new Date("2026-01-01T00:00:00.000Z"),
          last_active: new Date("2026-01-02T00:00:00.000Z"),
          banned: false,
          email_address_verified: {
            "test@example.com": "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    };
  }
  return undefined;
}

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/membership/resolve", () => ({
  __esModule: true,
  resolveMembershipForAccount: (...args: any[]) =>
    resolveMembershipForAccountMock(...args),
}));

jest.mock("@cocalc/server/auth/two-factor", () => ({
  __esModule: true,
  hasActiveSecondFactor: (...args: any[]) => hasActiveSecondFactorMock(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/get-payment-methods", () => ({
  __esModule: true,
  hasPaymentMethod: (...args: any[]) => hasPaymentMethodMock(...args),
}));

jest.mock("@cocalc/server/purchases/get-balance", () => ({
  __esModule: true,
  default: (...args: any[]) => getBalanceMock(...args),
}));

jest.mock("@cocalc/server/bay-directory", () => ({
  __esModule: true,
  resolveAccountHomeBay: (...args: any[]) => resolveAccountHomeBayMock(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  __esModule: true,
  requireFreshAuthForSessionHash: (...args: any[]) =>
    requireFreshAuthForSessionHashMock(...args),
}));

jest.mock("@cocalc/server/project-host/admission", () => ({
  __esModule: true,
  applyDedicatedHostFundingModeOverride: jest.fn(
    (snapshot: any, funding_mode_override?: string) =>
      funding_mode_override == null
        ? snapshot
        : { ...snapshot, funding_mode: funding_mode_override },
  ),
  assertDedicatedHostAdmissionForAccount: (...args: any[]) =>
    assertDedicatedHostAdmissionForAccountMock(...args),
  getDedicatedHostPolicySnapshotForAccount: (...args: any[]) =>
    getDedicatedHostPolicySnapshotForAccountMock(...args),
  isBillableDedicatedHostCloud: (...args: any[]) =>
    isBillableDedicatedHostCloudMock(...args),
  selectDedicatedHostFundingLane: (...args: any[]) =>
    selectDedicatedHostFundingLaneMock(...args),
}));

jest.mock("@cocalc/server/project-host/spend", () => ({
  __esModule: true,
  estimateDedicatedHostRateUsdPerHour: (...args: any[]) =>
    estimateDedicatedHostRateUsdPerHourMock(...args),
  reconcileDedicatedHostPurchaseSessionForAccount: (...args: any[]) =>
    reconcileDedicatedHostPurchaseSessionForAccountMock(...args),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

jest.mock("@cocalc/server/cloud", () => ({
  __esModule: true,
  enqueueCloudVmWork: (...args: any[]) => enqueueCloudVmWorkMock(...args),
  listCloudVmLog: jest.fn(),
  logCloudVmEvent: jest.fn(),
  refreshCloudCatalogNow: jest.fn(),
  deleteHostDns: jest.fn(),
  hasDns: jest.fn(async () => false),
}));

jest.mock("@cocalc/server/cloud/host-gpu", () => ({
  __esModule: true,
  machineHasGpu: jest.fn(() => false),
  normalizeMachineGpuInPlace: jest.fn((machine: any) => machine),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: jest.fn(async () => false),
}));

jest.mock("@cocalc/server/accounts/is-banned", () => ({
  __esModule: true,
  default: jest.fn(async () => false),
}));

describe("hosts.createHost", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.COCALC_BAY_ID = "bay-0";
    process.env.COCALC_CLUSTER_BAY_IDS = "bay-0,bay-1,bay-2";
    resolveMembershipForAccountMock = jest.fn(async () => ({
      class: "member",
      entitlements: { features: { create_hosts: true } },
      effective_limits: {
        prepaid_host_usage_limit_5h_usd: 300,
        prepaid_host_usage_limit_7d_usd: 1000,
      },
    }));
    getServerSettingsMock = jest.fn(async () => ({}));
    enqueueCloudVmWorkMock = jest.fn(async () => undefined);
    hasActiveSecondFactorMock = jest.fn(async () => true);
    hasPaymentMethodMock = jest.fn(async () => true);
    getBalanceMock = jest.fn(async () => "25");
    resolveAccountHomeBayMock = jest.fn(async () => ({
      home_bay_id: "bay-0",
      epoch: 1,
    }));
    assertDedicatedHostAdmissionForAccountMock = jest.fn(async () => undefined);
    getDedicatedHostPolicySnapshotForAccountMock = jest.fn(async () => ({
      account_id: ACCOUNT_ID,
      can_create_hosts: true,
      funding_mode: "account-prepaid",
      has_active_second_factor: true,
      has_payment_method: true,
      has_usage_subscription: false,
      balance: "25",
      postpaid_unbilled_exposure_usd: "0",
      effective_limits: {
        prepaid_host_usage_limit_5h_usd: 300,
        prepaid_host_usage_limit_7d_usd: 1000,
      },
      dedicated_host_window_usage: {
        prepaid_5h_usd: "0",
        prepaid_7d_usd: "0",
        credit_5h_usd: "0",
        credit_7d_usd: "0",
      },
    }));
    isBillableDedicatedHostCloudMock = jest.fn(
      (provider?: string | null) => provider === "gcp",
    );
    selectDedicatedHostFundingLaneMock = jest.fn(() => "prepaid");
    estimateDedicatedHostRateUsdPerHourMock = jest.fn(async () => "1.25");
    reconcileDedicatedHostPurchaseSessionForAccountMock = jest.fn(
      async () => undefined,
    );
    requireFreshAuthForSessionHashMock = jest.fn(async () => undefined);
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      const accountResult = maybeHandleAccountDirectoryQuery(sql, params);
      if (accountResult != null) {
        return accountResult;
      }
      if (sql.startsWith("INSERT INTO project_hosts ")) {
        expect(params[4]?.pricing_model).toBe("spot");
        expect(params[4]?.interruption_restore_policy).toBe("immediate");
        expect(params[4]?.desired_state).toBe("running");
        expect(params[4]?.billing).toEqual({
          funding_mode: "account-prepaid",
          funding_lane: "prepaid",
          hourly_cost_usd: "1.25",
          started_at: expect.any(String),
        });
        expect(params[5]).toBeNull();
        expect(params[6]).toBe("bay-0");
        return { rowCount: 1 };
      }
      if (
        sql.includes(
          "SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return {
          rows: [
            {
              id: params[0],
              name: "fresh-gcp",
              region: "us-west1",
              status: "starting",
              metadata: {
                owner: ACCOUNT_ID,
                size: "e2-standard-2",
                gpu: false,
                pricing_model: "spot",
                interruption_restore_policy: "immediate",
                desired_state: "running",
                machine: { cloud: "gcp" },
              },
              last_seen: null,
            },
          ],
        };
      }
      if (sql.includes("FROM account_impersonation_sessions")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  it("does not seed cloud hosts with a synthetic heartbeat", async () => {
    const { createHost } = await import("./hosts");
    const host = await createHost({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      name: "fresh-gcp",
      region: "us-west1",
      size: "e2-standard-2",
      pricing_model: "spot",
      machine: { cloud: "gcp" },
    });

    expect(host.status).toBe("starting");
    expect(host.last_seen).toBeUndefined();
    expect(host.pricing_model).toBe("spot");
    expect(host.interruption_restore_policy).toBe("immediate");
    expect(host.desired_state).toBe("running");
    expect(enqueueCloudVmWorkMock).toHaveBeenCalledWith(
      expect.objectContaining({
        vm_id: host.id,
        action: "provision",
        payload: { provider: "gcp" },
      }),
    );
    expect(
      reconcileDedicatedHostPurchaseSessionForAccountMock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        host_id: host.id,
        provider: "gcp",
        funding_lane: "prepaid",
        hourly_cost_usd: "1.25",
      }),
    );
  });

  it("rejects GCP standard persistent disks on create", async () => {
    const { createHost } = await import("./hosts");
    await expect(
      createHost({
        account_id: ACCOUNT_ID,
        session_hash: "session-hash",
        name: "standard-gcp",
        region: "us-west1",
        size: "e2-standard-2",
        machine: {
          cloud: "gcp",
          disk_gb: 100,
          disk_type: "standard",
          storage_mode: "persistent",
        },
      }),
    ).rejects.toThrow("GCP standard persistent disks are not supported");
    expect(queryMock).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO project_hosts"),
      expect.anything(),
    );
  });

  it("can create a managed cloud host without starting it", async () => {
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      const accountResult = maybeHandleAccountDirectoryQuery(sql, params);
      if (accountResult != null) {
        return accountResult;
      }
      if (sql.startsWith("INSERT INTO project_hosts ")) {
        expect(params[3]).toBe("off");
        expect(params[4]?.desired_state).toBe("stopped");
        expect(params[4]?.bootstrap).toBeUndefined();
        expect(params[4]?.billing).toBeUndefined();
        expect(params[5]).toBeNull();
        expect(params[6]).toBe("bay-0");
        return { rowCount: 1 };
      }
      if (
        sql.includes(
          "SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return {
          rows: [
            {
              id: params[0],
              name: "fresh-gcp",
              region: "us-west1",
              status: "off",
              metadata: {
                owner: ACCOUNT_ID,
                size: "e2-standard-2",
                gpu: false,
                pricing_model: "spot",
                interruption_restore_policy: "immediate",
                desired_state: "stopped",
                machine: { cloud: "gcp" },
              },
              last_seen: null,
            },
          ],
        };
      }
      if (sql.includes("FROM account_impersonation_sessions")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { createHost } = await import("./hosts");
    const host = await createHost({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      name: "fresh-gcp",
      region: "us-west1",
      size: "e2-standard-2",
      pricing_model: "spot",
      start_after_create: false,
      machine: { cloud: "gcp" },
    });

    expect(host.status).toBe("off");
    expect(host.desired_state).toBe("stopped");
    expect(enqueueCloudVmWorkMock).not.toHaveBeenCalled();
    expect(
      reconcileDedicatedHostPurchaseSessionForAccountMock,
    ).not.toHaveBeenCalled();
    expect(estimateDedicatedHostRateUsdPerHourMock).not.toHaveBeenCalled();
  });

  it("creates site-funded cloud hosts without opening an account-funded purchase session", async () => {
    getDedicatedHostPolicySnapshotForAccountMock = jest.fn(async () => ({
      account_id: ACCOUNT_ID,
      can_create_hosts: true,
      funding_mode: "site-funded",
      has_active_second_factor: true,
      has_payment_method: false,
      has_usage_subscription: false,
      balance: "0",
      postpaid_unbilled_exposure_usd: "0",
      effective_limits: {},
      dedicated_host_window_usage: {
        prepaid_5h_usd: "0",
        prepaid_7d_usd: "0",
        credit_5h_usd: "0",
        credit_7d_usd: "0",
      },
    }));
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      const accountResult = maybeHandleAccountDirectoryQuery(sql, params);
      if (accountResult != null) {
        return accountResult;
      }
      if (sql.startsWith("INSERT INTO project_hosts ")) {
        expect(params[4]?.billing).toEqual({
          funding_mode: "site-funded",
          started_at: expect.any(String),
        });
        return { rowCount: 1 };
      }
      if (
        sql.includes(
          "SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return {
          rows: [
            {
              id: params[0],
              name: "fresh-gcp",
              region: "us-west1",
              status: "starting",
              metadata: {
                owner: ACCOUNT_ID,
                size: "e2-standard-2",
                gpu: false,
                pricing_model: "spot",
                interruption_restore_policy: "immediate",
                desired_state: "running",
                machine: { cloud: "gcp" },
              },
              last_seen: null,
            },
          ],
        };
      }
      if (sql.includes("FROM account_impersonation_sessions")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { createHost } = await import("./hosts");
    await createHost({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      name: "fresh-gcp",
      region: "us-west1",
      size: "e2-standard-2",
      pricing_model: "spot",
      machine: { cloud: "gcp" },
    });

    expect(
      reconcileDedicatedHostPurchaseSessionForAccountMock,
    ).not.toHaveBeenCalled();
  });

  it("rejects site-funded cloud hosts when pricing is unavailable", async () => {
    getDedicatedHostPolicySnapshotForAccountMock = jest.fn(async () => ({
      account_id: ACCOUNT_ID,
      can_create_hosts: true,
      funding_mode: "site-funded",
      has_active_second_factor: true,
      has_payment_method: false,
      has_usage_subscription: false,
      balance: "0",
      postpaid_unbilled_exposure_usd: "0",
      effective_limits: {},
      dedicated_host_window_usage: {
        prepaid_5h_usd: "0",
        prepaid_7d_usd: "0",
        credit_5h_usd: "0",
        credit_7d_usd: "0",
      },
    }));
    estimateDedicatedHostRateUsdPerHourMock = jest.fn(async () => undefined);

    const { createHost } = await import("./hosts");
    await expect(
      createHost({
        account_id: ACCOUNT_ID,
        session_hash: "session-hash",
        name: "fresh-gcp",
        region: "us-west1",
        size: "e2-standard-2",
        pricing_model: "spot",
        machine: { cloud: "gcp" },
      }),
    ).rejects.toMatchObject({
      message: "unable to determine the create hourly rate for provider 'gcp'",
      code: "host_pricing_unavailable",
    });
    expect(queryMock).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO project_hosts"),
      expect.anything(),
    );
  });

  it("rejects billable cloud host creation when the estimated rate has no billing runway", async () => {
    estimateDedicatedHostRateUsdPerHourMock = jest.fn(async () => "100");

    const { createHost } = await import("./hosts");
    await expect(
      createHost({
        account_id: ACCOUNT_ID,
        session_hash: "session-hash",
        name: "expensive-gcp",
        region: "us-west1",
        size: "e2-standard-2",
        pricing_model: "spot",
        machine: { cloud: "gcp" },
      }),
    ).rejects.toMatchObject({
      code: "dedicated_host_billing_runway_too_low",
    });
    expect(queryMock).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO project_hosts"),
      expect.anything(),
    );
  });

  it("rejects managed cloud hosts below the minimum disk size", async () => {
    const { createHost } = await import("./hosts");
    await expect(
      createHost({
        account_id: ACCOUNT_ID,
        session_hash: "session-hash",
        name: "tiny-gcp",
        region: "us-west1",
        size: "e2-standard-2",
        machine: {
          cloud: "gcp",
          disk_gb: 50,
          storage_mode: "persistent",
        },
      }),
    ).rejects.toThrow("disk_gb must be at least 75 GB");
    expect(estimateDedicatedHostRateUsdPerHourMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO project_hosts"),
      expect.anything(),
    );
  });

  it("normalizes Nebius shared scratch fields on create", async () => {
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      const accountResult = maybeHandleAccountDirectoryQuery(sql, params);
      if (accountResult != null) {
        return accountResult;
      }
      if (sql.startsWith("INSERT INTO project_hosts ")) {
        expect(params[4]?.machine).toMatchObject({
          cloud: "nebius",
          shared_disk_gb: 93,
          shared_disk_type: "ssd",
          metadata: {
            shared_disk_mount: "/mnt/cocalc-scratch",
            shared_disk_filesystem: "ext4",
          },
        });
        return { rowCount: 1 };
      }
      if (
        sql.includes(
          "SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return {
          rows: [
            {
              id: params[0],
              name: "scratch-nebius",
              region: "us-central1",
              status: "starting",
              metadata: {
                owner: ACCOUNT_ID,
                size: "cpu-standard-v3",
                gpu: false,
                machine: {
                  cloud: "nebius",
                  shared_disk_gb: 93,
                  shared_disk_type: "ssd",
                },
              },
              last_seen: null,
            },
          ],
        };
      }
      if (sql.includes("FROM account_impersonation_sessions")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { createHost } = await import("./hosts");
    await createHost({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      name: "scratch-nebius",
      region: "us-central1",
      size: "cpu-standard-v3",
      machine: {
        cloud: "nebius",
        disk_gb: 100,
        disk_type: "ssd",
        storage_mode: "persistent",
        shared_disk_gb: 50,
      },
    });
  });

  it("rejects shared scratch disks above the backend cap on create", async () => {
    const { createHost } = await import("./hosts");
    await expect(
      createHost({
        account_id: ACCOUNT_ID,
        session_hash: "session-hash",
        name: "huge-scratch-nebius",
        region: "us-central1",
        size: "cpu-standard-v3",
        machine: {
          cloud: "nebius",
          disk_gb: 100,
          disk_type: "ssd",
          storage_mode: "persistent",
          shared_disk_gb: 20000,
        },
      }),
    ).rejects.toThrow("shared_disk_gb must be at most 10,044 GB");
    expect(estimateDedicatedHostRateUsdPerHourMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO project_hosts"),
      expect.anything(),
    );
  });

  it("rejects shared scratch for providers without support", async () => {
    const { createHost } = await import("./hosts");
    await expect(
      createHost({
        account_id: ACCOUNT_ID,
        session_hash: "session-hash",
        name: "scratch-lambda",
        region: "us-east-1",
        size: "gpu_1x_a10",
        machine: {
          cloud: "lambda",
          shared_disk_gb: 100,
        },
      }),
    ).rejects.toThrow(
      "shared scratch disks are not supported for provider 'lambda'",
    );
    expect(estimateDedicatedHostRateUsdPerHourMock).not.toHaveBeenCalled();
  });

  it("creates postpaid cloud hosts with a credit-funded purchase session", async () => {
    getDedicatedHostPolicySnapshotForAccountMock = jest.fn(async () => ({
      account_id: ACCOUNT_ID,
      can_create_hosts: true,
      funding_mode: "account-postpaid",
      has_active_second_factor: true,
      has_payment_method: true,
      has_usage_subscription: true,
      balance: "0",
      postpaid_unbilled_exposure_usd: "0",
      effective_limits: {
        credit_spend_limit_5h_usd: 300,
        credit_spend_limit_7d_usd: 1000,
      },
      dedicated_host_window_usage: {
        prepaid_5h_usd: "0",
        prepaid_7d_usd: "0",
        credit_5h_usd: "0",
        credit_7d_usd: "0",
      },
    }));
    selectDedicatedHostFundingLaneMock = jest.fn(() => "credit");
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      const accountResult = maybeHandleAccountDirectoryQuery(sql, params);
      if (accountResult != null) {
        return accountResult;
      }
      if (sql.startsWith("INSERT INTO project_hosts ")) {
        expect(params[4]?.billing).toEqual({
          funding_mode: "account-postpaid",
          funding_lane: "credit",
          hourly_cost_usd: "1.25",
          started_at: expect.any(String),
        });
        return { rowCount: 1 };
      }
      if (
        sql.includes(
          "SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        return {
          rows: [
            {
              id: params[0],
              name: "fresh-gcp",
              region: "us-west1",
              status: "starting",
              metadata: {
                owner: ACCOUNT_ID,
                size: "e2-standard-2",
                gpu: false,
                pricing_model: "spot",
                interruption_restore_policy: "immediate",
                desired_state: "running",
                machine: { cloud: "gcp" },
              },
              last_seen: null,
            },
          ],
        };
      }
      if (sql.includes("FROM account_impersonation_sessions")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { createHost } = await import("./hosts");
    const host = await createHost({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      name: "fresh-gcp",
      region: "us-west1",
      size: "e2-standard-2",
      pricing_model: "spot",
      machine: { cloud: "gcp" },
    });

    expect(
      reconcileDedicatedHostPurchaseSessionForAccountMock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        host_id: host.id,
        provider: "gcp",
        funding_lane: "credit",
        hourly_cost_usd: "1.25",
      }),
    );
  });

  it("requires two-factor authentication for billable cloud hosts", async () => {
    assertDedicatedHostAdmissionForAccountMock = jest.fn(async () => {
      throw new Error("enable two-factor authentication");
    });
    const { createHost } = await import("./hosts");
    await expect(
      createHost({
        account_id: ACCOUNT_ID,
        session_hash: "session-hash",
        name: "fresh-gcp",
        region: "us-west1",
        size: "e2-standard-2",
        pricing_model: "spot",
        machine: { cloud: "gcp" },
      }),
    ).rejects.toThrow("enable two-factor authentication");
    expect(assertDedicatedHostAdmissionForAccountMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      action: "create",
      funding_mode_override: undefined,
      has_active_second_factor_override: undefined,
      machine_cloud: "gcp",
    });
  });
});

describe("hosts.startHostInternal", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.COCALC_BAY_ID = "bay-0";
    process.env.COCALC_CLUSTER_BAY_IDS = "bay-0,bay-1,bay-2";
    resolveMembershipForAccountMock = jest.fn(async () => ({
      class: "member",
      entitlements: { features: { create_hosts: true } },
      effective_limits: {},
    }));
    getServerSettingsMock = jest.fn(async () => ({}));
    enqueueCloudVmWorkMock = jest.fn(async () => undefined);
    hasActiveSecondFactorMock = jest.fn(async () => true);
    hasPaymentMethodMock = jest.fn(async () => false);
    getBalanceMock = jest.fn(async () => "0");
    resolveAccountHomeBayMock = jest.fn(async () => ({
      home_bay_id: "bay-0",
      epoch: 1,
    }));
    assertDedicatedHostAdmissionForAccountMock = jest.fn(async () => undefined);
    getDedicatedHostPolicySnapshotForAccountMock = jest.fn(async () => ({
      account_id: ACCOUNT_ID,
      can_create_hosts: true,
      funding_mode: "account-prepaid",
      has_active_second_factor: true,
      has_payment_method: false,
      has_usage_subscription: false,
      balance: "0",
      postpaid_unbilled_exposure_usd: "0",
      effective_limits: {},
      dedicated_host_window_usage: {
        prepaid_5h_usd: "0",
        prepaid_7d_usd: "0",
        credit_5h_usd: "0",
        credit_7d_usd: "0",
      },
    }));
    isBillableDedicatedHostCloudMock = jest.fn(
      (provider?: string | null) => provider === "gcp",
    );
    selectDedicatedHostFundingLaneMock = jest.fn(() => {
      throw new Error("should not select an account-funded lane");
    });
    estimateDedicatedHostRateUsdPerHourMock = jest.fn(async () => "1.25");
    reconcileDedicatedHostPurchaseSessionForAccountMock = jest.fn(
      async () => undefined,
    );
  });

  it("honors an existing host-level site-funded override during start", async () => {
    let selectCount = 0;
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (
        sql.includes(
          "SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        selectCount += 1;
        return {
          rows: [
            {
              id: params[0],
              name: "existing-gcp",
              region: "us-west1",
              status: selectCount >= 2 ? "starting" : "off",
              metadata: {
                owner: ACCOUNT_ID,
                size: "e2-standard-2",
                pricing_model: "on_demand",
                desired_state: "stopped",
                machine: { cloud: "gcp", machine_type: "e2-standard-2" },
                billing: {
                  funding_mode: "site-funded",
                  started_at: "2026-05-07T00:00:00.000Z",
                },
              },
              last_seen: null,
            },
          ],
        };
      }
      if (sql.includes("SELECT metadata FROM project_hosts")) {
        return {
          rows: [
            {
              metadata: {
                owner: ACCOUNT_ID,
                size: "e2-standard-2",
                pricing_model: "on_demand",
                desired_state: "stopped",
                machine: { cloud: "gcp", machine_type: "e2-standard-2" },
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
        sql.includes("UPDATE project_hosts SET status=$2") &&
        sql.includes("metadata=$4")
      ) {
        expect(params[1]).toBe("starting");
        expect(params[3]?.billing).toEqual({
          funding_mode: "site-funded",
          started_at: expect.any(String),
        });
        return { rows: [] };
      }
      if (
        sql.includes("UPDATE project_hosts") &&
        sql.includes("SET metadata = jsonb_set")
      ) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { startHostInternal } = await import("./hosts");
    const host = await startHostInternal({
      account_id: ACCOUNT_ID,
      id: "host-1",
    });

    expect(host.status).toBe("starting");
    expect(enqueueCloudVmWorkMock).toHaveBeenCalledWith({
      vm_id: "host-1",
      action: "start",
      payload: { provider: "gcp" },
    });
    expect(
      reconcileDedicatedHostPurchaseSessionForAccountMock,
    ).not.toHaveBeenCalled();
  });

  it("rejects site-funded starts when pricing is unavailable", async () => {
    let selectCount = 0;
    estimateDedicatedHostRateUsdPerHourMock = jest.fn(async () => undefined);
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (
        sql.includes(
          "SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        )
      ) {
        selectCount += 1;
        return {
          rows: [
            {
              id: params[0],
              name: "existing-gcp",
              region: "us-west1",
              status: "off",
              metadata: {
                owner: ACCOUNT_ID,
                size: "e2-standard-2",
                pricing_model: "on_demand",
                desired_state: "stopped",
                machine: { cloud: "gcp", machine_type: "e2-standard-2" },
                billing: {
                  funding_mode: "site-funded",
                  started_at: "2026-05-07T00:00:00.000Z",
                },
              },
              last_seen: null,
            },
          ],
        };
      }
      if (sql.includes("SELECT metadata FROM project_hosts")) {
        return {
          rows: [
            {
              metadata: {
                owner: ACCOUNT_ID,
                size: "e2-standard-2",
                pricing_model: "on_demand",
                desired_state: "stopped",
                machine: { cloud: "gcp", machine_type: "e2-standard-2" },
                billing: {
                  funding_mode: "site-funded",
                  started_at: "2026-05-07T00:00:00.000Z",
                },
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { startHostInternal } = await import("./hosts");
    await expect(
      startHostInternal({
        account_id: ACCOUNT_ID,
        id: "host-1",
      }),
    ).rejects.toMatchObject({
      message: "unable to determine the start hourly rate for provider 'gcp'",
      code: "host_pricing_unavailable",
    });
    expect(enqueueCloudVmWorkMock).not.toHaveBeenCalled();
  });
});
