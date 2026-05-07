/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let queryMock: jest.Mock;
let resolveAccountHomeBayMock: jest.Mock;
let getClusterAccountByIdMock: jest.Mock;
let updateClusterAccountHomeBayMock: jest.Mock;
let updateClusterAccountApiKeysHomeBayMock: jest.Mock;
let listBrowserSessionsForAccountMock: jest.Mock;
let getLiveBrowserSessionInfoMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: queryMock,
  })),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-1"),
}));

jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...args: any[]) => resolveAccountHomeBayMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: (...args: any[]) => getClusterAccountByIdMock(...args),
  updateClusterAccountHomeBay: (...args: any[]) =>
    updateClusterAccountHomeBayMock(...args),
  updateClusterAccountApiKeysHomeBay: (...args: any[]) =>
    updateClusterAccountApiKeysHomeBayMock(...args),
}));

jest.mock("@cocalc/server/conat/api/browser-sessions", () => ({
  listBrowserSessionsForAccount: (...args: any[]) =>
    listBrowserSessionsForAccountMock(...args),
}));

jest.mock("@cocalc/server/conat/api/browser-sessions-live", () => ({
  getLiveBrowserSessionInfo: (...args: any[]) =>
    getLiveBrowserSessionInfoMock(...args),
}));

jest.mock("@cocalc/server/bay-public-origin", () => ({
  getBayPublicOrigin: jest.fn(async () => "https://bay-2.example.test"),
  getClusterBayPublicOrigins: jest.fn(async () => ({})),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: jest.fn(async () => true),
}));

jest.mock("@cocalc/server/accounts/rehome-fence", () => ({
  lockAccountRehomeFence: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/bay-registry", () => ({
  listClusterBayRegistry: jest.fn(async () => []),
}));

jest.mock("@cocalc/conat/service/browser-session", () => ({
  createBrowserSessionClient: jest.fn(() => ({
    action: jest.fn(async () => undefined),
  })),
}));

jest.mock("@cocalc/backend/conat", () => ({
  conat: jest.fn(() => ({})),
}));

jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: jest.fn(() => ({})),
}));

jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: jest.fn(() => ({
    acceptRehome: jest.fn(async () => undefined),
    copyRehomeState: jest.fn(async () => undefined),
    getRehomeOperation: jest.fn(async () => null),
    reconcileRehome: jest.fn(async () => undefined),
  })),
}));

describe("account rehome", () => {
  const OP_ID = "11111111-1111-4111-8111-111111111111";
  const TARGET_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
  const REQUESTED_BY = "33333333-3333-4333-8333-333333333333";
  let operationRow: any;

  beforeEach(() => {
    jest.resetModules();
    operationRow = {
      op_id: OP_ID,
      account_id: TARGET_ACCOUNT_ID,
      source_bay_id: "bay-1",
      dest_bay_id: "bay-2",
      requested_by: REQUESTED_BY,
      reason: null,
      campaign_id: null,
      status: "running",
      stage: "projections_copied",
      attempt: 0,
      account: {
        account_id: TARGET_ACCOUNT_ID,
        home_bay_id: "bay-1",
      },
      last_error: null,
      created_at: new Date("2026-05-06T01:00:00.000Z"),
      updated_at: new Date("2026-05-06T01:00:00.000Z"),
      finished_at: null,
    };
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS account_rehome_operations") ||
        sql.includes("CREATE INDEX IF NOT EXISTS account_rehome_operations")
      ) {
        return { rows: [] };
      }
      if (
        sql.includes("UPDATE account_rehome_operations") &&
        sql.includes("attempt = CASE")
      ) {
        operationRow = {
          ...operationRow,
          attempt: operationRow.attempt + 1,
          status: "running",
          last_error: null,
          finished_at: null,
        };
        return { rows: [operationRow] };
      }
      if (sql.includes("UPDATE cluster_accounts")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE account_rehome_operations")) {
        const stage = params?.find((value) =>
          [
            "requested",
            "destination_accepted",
            "source_flipped",
            "projections_copied",
            "directory_updated",
            "complete",
          ].includes(value),
        );
        const status = params?.find((value) =>
          ["running", "succeeded", "failed"].includes(value),
        );
        operationRow = {
          ...operationRow,
          ...(stage ? { stage } : {}),
          ...(status ? { status } : {}),
          updated_at: new Date("2026-05-06T01:00:05.000Z"),
          ...(status === "succeeded"
            ? { finished_at: new Date("2026-05-06T01:00:05.000Z") }
            : {}),
        };
        return { rows: [operationRow] };
      }
      if (sql.includes("SELECT * FROM account_rehome_operations")) {
        return { rows: [operationRow] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    resolveAccountHomeBayMock = jest.fn(
      async ({ account_id, user_account_id }) => {
        if (
          account_id === REQUESTED_BY &&
          user_account_id === TARGET_ACCOUNT_ID
        ) {
          throw new Error("not authorized");
        }
        return {
          account_id: user_account_id ?? account_id,
          home_bay_id: "bay-2",
          source: "cluster-directory",
        };
      },
    );
    getClusterAccountByIdMock = jest.fn(async () => ({
      account_id: TARGET_ACCOUNT_ID,
      home_bay_id: "bay-1",
    }));
    updateClusterAccountHomeBayMock = jest.fn(async () => undefined);
    updateClusterAccountApiKeysHomeBayMock = jest.fn(async () => undefined);
    listBrowserSessionsForAccountMock = jest.fn(() => []);
    getLiveBrowserSessionInfoMock = jest.fn(async () => ({}));
  });

  it("polls route convergence using the rehomed account on attached source bays", async () => {
    const { runAccountRehomeOperation } = await import("./rehome");

    const result = await runAccountRehomeOperation(OP_ID);

    expect(resolveAccountHomeBayMock).toHaveBeenCalledWith({
      account_id: TARGET_ACCOUNT_ID,
      user_account_id: TARGET_ACCOUNT_ID,
    });
    expect(resolveAccountHomeBayMock).not.toHaveBeenCalledWith({
      account_id: REQUESTED_BY,
      user_account_id: TARGET_ACCOUNT_ID,
    });
    expect(updateClusterAccountHomeBayMock).toHaveBeenCalledWith({
      account_id: TARGET_ACCOUNT_ID,
      home_bay_id: "bay-2",
    });
    expect(result).toEqual({
      op_id: OP_ID,
      account_id: TARGET_ACCOUNT_ID,
      previous_bay_id: "bay-1",
      home_bay_id: "bay-2",
      operation_stage: "complete",
      operation_status: "succeeded",
      status: "rehomed",
    });
  });
});
