export {};

let queryMock: jest.Mock;
let resolveMembershipForAccountMock: jest.Mock;
let getServerSettingsMock: jest.Mock;
let enqueueCloudVmWorkMock: jest.Mock;

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
      entitlements: { features: { create_hosts: true } },
    }));
    getServerSettingsMock = jest.fn(async () => ({}));
    enqueueCloudVmWorkMock = jest.fn(async () => undefined);
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql.startsWith("INSERT INTO project_hosts ")) {
        expect(params[4]?.pricing_model).toBe("spot");
        expect(params[4]?.interruption_restore_policy).toBe("immediate");
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
    expect(enqueueCloudVmWorkMock).toHaveBeenCalledWith(
      expect.objectContaining({
        vm_id: host.id,
        action: "provision",
        payload: { provider: "gcp" },
      }),
    );
  });
});
