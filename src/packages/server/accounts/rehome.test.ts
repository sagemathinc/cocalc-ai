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
let acceptRehomeMock: jest.Mock;
let copyRehomeStateMock: jest.Mock;
let getMembershipPortableStateMock: jest.Mock;
let replaceMembershipPortableStateMock: jest.Mock;
let createInterBayAccountLocalClientMock: jest.Mock;

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
  listConfiguredBays: jest.fn(async () => [
    { bay_id: "bay-0" },
    { bay_id: "bay-1" },
    { bay_id: "bay-2" },
  ]),
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
  createInterBayAccountLocalClient: (...args: any[]) =>
    createInterBayAccountLocalClientMock(...args),
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
        sql.includes("CREATE INDEX IF NOT EXISTS account_rehome_operations") ||
        sql.includes(
          "ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_id TEXT",
        ) ||
        sql.includes(
          "CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_id_unique_idx",
        )
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
      if (
        sql.includes('DELETE FROM "account_project_index" WHERE account_id=$1')
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "account_collaborator_index" WHERE account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "account_notification_index" WHERE account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('DELETE FROM "remember_me" WHERE account_id=$1')) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes('DELETE FROM "account_auth_sessions" WHERE account_id=$1')
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "account_auth_challenges" WHERE account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes('DELETE FROM "account_second_factors" WHERE account_id=$1')
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "account_second_factor_recovery_codes" WHERE account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "account_impersonation_grants" WHERE subject_account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "account_impersonation_sessions" WHERE subject_account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('DELETE FROM "auth_tokens" WHERE account_id=$1')) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes("DELETE FROM api_keys") &&
        sql.includes("project_id IS NULL")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('DELETE FROM "membership_grants" WHERE account_id=$1')) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes("DELETE FROM membership_package_assignments") &&
        sql.includes("WHERE package_id IN")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "membership_packages" WHERE owner_account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "membership_side_effects_outbox" WHERE owner_account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
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
    acceptRehomeMock = jest.fn(async () => undefined);
    copyRehomeStateMock = jest.fn(async () => undefined);
    getMembershipPortableStateMock = jest.fn(async () => ({
      membership_grants: [],
      membership_packages: [],
      membership_package_assignments: [],
      membership_side_effects_outbox: [],
    }));
    replaceMembershipPortableStateMock = jest.fn(async () => undefined);
    createInterBayAccountLocalClientMock = jest.fn(({ dest_bay }) => ({
      acceptRehome: async (opts: any) => await acceptRehomeMock(opts),
      copyRehomeState: async (opts: any) => await copyRehomeStateMock(opts),
      getRehomeOperation: jest.fn(async () => null),
      reconcileRehome: jest.fn(async () => undefined),
      getMembershipPortableState: async (opts: any) =>
        await getMembershipPortableStateMock({ dest_bay, ...opts }),
      replaceMembershipPortableState: async (opts: any) =>
        await replaceMembershipPortableStateMock({ dest_bay, ...opts }),
    }));
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

  it("copies membership portability state during source-flipped account rehome", async () => {
    operationRow = {
      ...operationRow,
      stage: "source_flipped",
    };
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS account_rehome_operations") ||
        sql.includes("CREATE INDEX IF NOT EXISTS account_rehome_operations") ||
        sql.includes(
          "ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_id TEXT",
        ) ||
        sql.includes(
          "CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_id_unique_idx",
        )
      ) {
        return { rows: [] };
      }
      if (
        sql.includes("UPDATE account_rehome_operations") &&
        sql.includes("attempt = CASE")
      ) {
        return { rows: [operationRow] };
      }
      if (sql.includes('FROM "account_project_index"')) {
        return { rows: [{ rows: [] }] };
      }
      if (sql.includes('FROM "account_collaborator_index"')) {
        return { rows: [{ rows: [] }] };
      }
      if (sql.includes('FROM "account_notification_index"')) {
        return { rows: [{ rows: [] }] };
      }
      if (sql.includes('FROM "remember_me"')) {
        return { rows: [{ rows: [] }] };
      }
      if (sql.includes('FROM "account_auth_sessions"')) {
        return { rows: [{ rows: [] }] };
      }
      if (sql.includes('FROM "account_auth_challenges"')) {
        return { rows: [{ rows: [] }] };
      }
      if (sql.includes('FROM "account_second_factors"')) {
        return { rows: [{ rows: [] }] };
      }
      if (sql.includes('FROM "account_second_factor_recovery_codes"')) {
        return { rows: [{ rows: [] }] };
      }
      if (sql.includes('FROM "account_impersonation_grants"')) {
        return { rows: [{ rows: [] }] };
      }
      if (sql.includes('FROM "account_impersonation_sessions"')) {
        return { rows: [{ rows: [] }] };
      }
      if (sql.includes('FROM "auth_tokens"')) {
        return { rows: [{ rows: [] }] };
      }
      if (
        sql.includes("FROM api_keys") &&
        sql.includes("project_id IS NULL") &&
        sql.includes("jsonb_agg")
      ) {
        return { rows: [{ rows: [] }] };
      }
      if (sql.includes('FROM "membership_grants"')) {
        return {
          rows: [
            {
              rows: [
                {
                  id: "grant-1",
                  account_id: TARGET_ACCOUNT_ID,
                  membership_class: "member",
                  source: "team-seat",
                  package_id: "package-1",
                },
              ],
            },
          ],
        };
      }
      if (sql.includes('FROM "membership_packages"')) {
        return {
          rows: [
            {
              rows: [
                {
                  id: "package-1",
                  owner_account_id: TARGET_ACCOUNT_ID,
                  kind: "team",
                  membership_class: "member",
                  seat_count: 3,
                },
              ],
            },
          ],
        };
      }
      if (
        sql.includes("FROM membership_package_assignments a") &&
        sql.includes("JOIN membership_packages p")
      ) {
        return {
          rows: [
            {
              rows: [
                {
                  id: "assignment-1",
                  package_id: "package-1",
                  account_id: "beneficiary-1",
                },
              ],
            },
          ],
        };
      }
      if (sql.includes('FROM "membership_side_effects_outbox"')) {
        return {
          rows: [
            {
              rows: [
                {
                  effect_key: "grant-sync:assignment-1",
                  owner_account_id: TARGET_ACCOUNT_ID,
                  package_id: "package-1",
                  assignment_id: "assignment-1",
                  effect_kind: "grant-sync",
                  desired_revision: 1,
                  applied_revision: 0,
                },
              ],
            },
          ],
        };
      }
      if (
        sql.includes('DELETE FROM "account_project_index" WHERE account_id=$1')
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "account_collaborator_index" WHERE account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "account_notification_index" WHERE account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('DELETE FROM "remember_me" WHERE account_id=$1')) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes('DELETE FROM "account_auth_sessions" WHERE account_id=$1')
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "account_auth_challenges" WHERE account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes('DELETE FROM "account_second_factors" WHERE account_id=$1')
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "account_second_factor_recovery_codes" WHERE account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "account_impersonation_grants" WHERE subject_account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "account_impersonation_sessions" WHERE subject_account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('DELETE FROM "auth_tokens" WHERE account_id=$1')) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes("DELETE FROM api_keys") &&
        sql.includes("project_id IS NULL")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('DELETE FROM "membership_grants" WHERE account_id=$1')) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes("DELETE FROM membership_package_assignments") &&
        sql.includes("WHERE package_id IN")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "membership_packages" WHERE owner_account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "membership_side_effects_outbox" WHERE owner_account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
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

    const { runAccountRehomeOperation } = await import("./rehome");
    await runAccountRehomeOperation(OP_ID);

    expect(copyRehomeStateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target_account_id: TARGET_ACCOUNT_ID,
        source_bay_id: "bay-1",
        dest_bay_id: "bay-2",
        membership_grants: [
          expect.objectContaining({
            id: "grant-1",
            account_id: TARGET_ACCOUNT_ID,
          }),
        ],
        membership_packages: [
          expect.objectContaining({
            id: "package-1",
            owner_account_id: TARGET_ACCOUNT_ID,
          }),
        ],
        membership_package_assignments: [
          expect.objectContaining({
            id: "assignment-1",
            package_id: "package-1",
          }),
        ],
        membership_side_effects_outbox: [
          expect.objectContaining({
            effect_key: "grant-sync:assignment-1",
            owner_account_id: TARGET_ACCOUNT_ID,
          }),
        ],
      }),
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'DELETE FROM "membership_grants" WHERE account_id=$1',
      ),
      [TARGET_ACCOUNT_ID],
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'DELETE FROM "membership_packages" WHERE owner_account_id=$1',
      ),
      [TARGET_ACCOUNT_ID],
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'DELETE FROM "membership_side_effects_outbox" WHERE owner_account_id=$1',
      ),
      [TARGET_ACCOUNT_ID],
    );
  });

  it("repairs historical membership portability state onto the current home bay", async () => {
    getClusterAccountByIdMock = jest.fn(async () => ({
      account_id: TARGET_ACCOUNT_ID,
      home_bay_id: "bay-2",
    }));
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes('FROM "membership_grants"') &&
        sql.includes("WHERE account_id=$1")
      ) {
        return { rows: [{ rows: [] }] };
      }
      if (
        sql.includes('FROM "membership_packages"') &&
        sql.includes("WHERE owner_account_id=$1")
      ) {
        return { rows: [{ rows: [] }] };
      }
      if (
        sql.includes("FROM membership_package_assignments a") &&
        sql.includes("JOIN membership_packages p")
      ) {
        return { rows: [{ rows: [] }] };
      }
      if (
        sql.includes('FROM "membership_side_effects_outbox"') &&
        sql.includes("WHERE owner_account_id=$1")
      ) {
        return { rows: [{ rows: [] }] };
      }
      if (sql.includes('DELETE FROM "membership_grants" WHERE account_id=$1')) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "membership_packages" WHERE owner_account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes("DELETE FROM membership_package_assignments") &&
        sql.includes("WHERE package_id IN")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes(
          'DELETE FROM "membership_side_effects_outbox" WHERE owner_account_id=$1',
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO "membership_grants"')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO "membership_packages"')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO "membership_package_assignments"')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO "membership_side_effects_outbox"')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    getMembershipPortableStateMock = jest.fn(
      async ({ dest_bay, account_id }) => {
        expect(account_id).toBe(TARGET_ACCOUNT_ID);
        if (dest_bay !== "bay-0") {
          return {
            membership_grants: [],
            membership_packages: [],
            membership_package_assignments: [],
            membership_side_effects_outbox: [],
          };
        }
        return {
          membership_grants: [
            {
              id: "grant-1",
              account_id: TARGET_ACCOUNT_ID,
              membership_class: "member",
              source: "team-seat",
              package_id: "package-1",
              updated: "2026-05-06T01:00:00.000Z",
            },
          ],
          membership_packages: [
            {
              id: "package-1",
              owner_account_id: TARGET_ACCOUNT_ID,
              kind: "team",
              membership_class: "member",
              seat_count: 2,
              updated: "2026-05-06T01:00:00.000Z",
            },
          ],
          membership_package_assignments: [
            {
              id: "assignment-1",
              package_id: "package-1",
              account_id: "beneficiary-1",
              updated: "2026-05-06T01:00:00.000Z",
            },
          ],
          membership_side_effects_outbox: [
            {
              effect_key: "grant-sync:assignment-1",
              owner_account_id: TARGET_ACCOUNT_ID,
              package_id: "package-1",
              assignment_id: "assignment-1",
              effect_kind: "grant-sync",
              desired_revision: 1,
              updated_at: "2026-05-06T01:00:00.000Z",
            },
          ],
        };
      },
    );

    const { repairAccountMembershipPortability } = await import("./rehome");
    const result = await repairAccountMembershipPortability({
      account_id: REQUESTED_BY,
      target_account_id: TARGET_ACCOUNT_ID,
      dry_run: false,
      clear_stale: true,
    });

    expect(getMembershipPortableStateMock).toHaveBeenCalledWith({
      dest_bay: "bay-2",
      account_id: TARGET_ACCOUNT_ID,
    });
    expect(getMembershipPortableStateMock).toHaveBeenCalledWith({
      dest_bay: "bay-0",
      account_id: TARGET_ACCOUNT_ID,
    });
    expect(replaceMembershipPortableStateMock).toHaveBeenCalledWith({
      dest_bay: "bay-2",
      account_id: TARGET_ACCOUNT_ID,
      membership_grants: [
        expect.objectContaining({
          id: "grant-1",
          account_id: TARGET_ACCOUNT_ID,
        }),
      ],
      membership_packages: [
        expect.objectContaining({
          id: "package-1",
          owner_account_id: TARGET_ACCOUNT_ID,
        }),
      ],
      membership_package_assignments: [
        expect.objectContaining({
          id: "assignment-1",
          package_id: "package-1",
        }),
      ],
      membership_side_effects_outbox: [
        expect.objectContaining({
          effect_key: "grant-sync:assignment-1",
          owner_account_id: TARGET_ACCOUNT_ID,
        }),
      ],
    });
    expect(replaceMembershipPortableStateMock).toHaveBeenCalledWith({
      dest_bay: "bay-0",
      account_id: TARGET_ACCOUNT_ID,
      membership_grants: [],
      membership_packages: [],
      membership_package_assignments: [],
      membership_side_effects_outbox: [],
    });
    expect(result).toEqual({
      account_id: TARGET_ACCOUNT_ID,
      home_bay_id: "bay-2",
      dry_run: false,
      clear_stale: true,
      scanned_bays: [
        {
          bay_id: "bay-2",
          membership_grants: 0,
          membership_packages: 0,
          membership_package_assignments: 0,
          membership_side_effects_outbox: 0,
          total: 0,
        },
        {
          bay_id: "bay-1",
          membership_grants: 0,
          membership_packages: 0,
          membership_package_assignments: 0,
          membership_side_effects_outbox: 0,
          total: 0,
        },
        {
          bay_id: "bay-0",
          membership_grants: 1,
          membership_packages: 1,
          membership_package_assignments: 1,
          membership_side_effects_outbox: 1,
          total: 4,
        },
      ],
      source_bays_with_rows: ["bay-0"],
      stale_bay_ids: ["bay-0"],
      cleared_stale_bay_ids: ["bay-0"],
      merged_counts: {
        membership_grants: 1,
        membership_packages: 1,
        membership_package_assignments: 1,
        membership_side_effects_outbox: 1,
        total: 4,
      },
      applied: true,
    });
  });
});
