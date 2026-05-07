export {};

let queryMock: jest.Mock;
let resolveMembershipForAccountMock: jest.Mock;
let getServerSettingsMock: jest.Mock;
let enqueueCloudVmWorkMock: jest.Mock;
let hasActiveSecondFactorMock: jest.Mock;
let hasPaymentMethodMock: jest.Mock;
let getBalanceMock: jest.Mock;
let getMinBalanceMock: jest.Mock;
let resolveAccountHomeBayMock: jest.Mock;

const ACCOUNT_ID = "81e787c4-8705-46c5-86df-9d07bc424a01";

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

jest.mock("@cocalc/server/purchases/get-min-balance", () => ({
  __esModule: true,
  default: (...args: any[]) => getMinBalanceMock(...args),
}));

jest.mock("@cocalc/server/bay-directory", () => ({
  __esModule: true,
  resolveAccountHomeBay: (...args: any[]) => resolveAccountHomeBayMock(...args),
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
    getMinBalanceMock = jest.fn(async () => "0");
    resolveAccountHomeBayMock = jest.fn(async () => ({
      home_bay_id: "bay-0",
      epoch: 1,
    }));
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql.startsWith("INSERT INTO project_hosts ")) {
        expect(params[4]?.pricing_model).toBe("spot");
        expect(params[4]?.interruption_restore_policy).toBe("immediate");
        expect(params[4]?.desired_state).toBe("running");
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
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  it("does not seed cloud hosts with a synthetic heartbeat", async () => {
    const { createHost } = await import("./hosts");
    const host = await createHost({
      account_id: ACCOUNT_ID,
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
  });

  it("requires two-factor authentication for billable cloud hosts", async () => {
    hasActiveSecondFactorMock = jest.fn(async () => false);
    const { createHost } = await import("./hosts");
    await expect(
      createHost({
        account_id: ACCOUNT_ID,
        name: "fresh-gcp",
        region: "us-west1",
        size: "e2-standard-2",
        pricing_model: "spot",
        machine: { cloud: "gcp" },
      }),
    ).rejects.toThrow("enable two-factor authentication");
  });
});
