export {};

let clientQueryMock: jest.Mock;
let clientReleaseMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    connect: jest.fn(async () => ({
      query: clientQueryMock,
      release: clientReleaseMock,
    })),
  })),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-0"),
}));

describe("account rehome write fence", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    clientReleaseMock = jest.fn();
    delete process.env.COCALC_BAY_ID;
  });

  afterEach(() => {
    delete process.env.COCALC_BAY_ID;
  });

  it("allows writes when no account rehome table exists yet", async () => {
    const calls: string[] = [];
    clientQueryMock = jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("to_regclass")) {
        return { rows: [{ table_name: null }] };
      }
      if (sql.includes("FROM accounts")) {
        return { rows: [{ home_bay_id: "bay-0" }] };
      }
      return { rows: [] };
    });

    const { withAccountRehomeWriteFence } = await import("./rehome-fence");
    const result = await withAccountRehomeWriteFence({
      account_id: ACCOUNT_ID,
      action: "set password",
      fn: async (db) => {
        await db.query(
          "UPDATE accounts SET password_hash=$1 WHERE account_id=$2",
        );
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(calls[0]).toBe("BEGIN");
    expect(calls.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(
      true,
    );
    expect(calls).toContain("COMMIT");
    expect(clientReleaseMock).toHaveBeenCalled();
  });

  it("blocks writes on a stale non-home bay after rehome completes", async () => {
    const calls: string[] = [];
    clientQueryMock = jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("to_regclass")) {
        return { rows: [{ table_name: "account_rehome_operations" }] };
      }
      if (sql.includes("FROM account_rehome_operations")) {
        return { rows: [] };
      }
      if (sql.includes("FROM accounts")) {
        return { rows: [{ home_bay_id: "bay-1" }] };
      }
      return { rows: [] };
    });

    const { withAccountRehomeWriteFence } = await import("./rehome-fence");
    await expect(
      withAccountRehomeWriteFence({
        account_id: ACCOUNT_ID,
        action: "set password",
        fn: async () => {
          throw new Error("write should be on the home bay");
        },
      }),
    ).rejects.toThrow(/account is homed on bay-1/);

    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
    expect(clientReleaseMock).toHaveBeenCalled();
  });

  it("blocks writes while an account rehome operation is running", async () => {
    const calls: string[] = [];
    clientQueryMock = jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("to_regclass")) {
        return { rows: [{ table_name: "account_rehome_operations" }] };
      }
      if (sql.includes("FROM account_rehome_operations")) {
        return {
          rows: [
            {
              op_id: "22222222-2222-4222-8222-222222222222",
              source_bay_id: "bay-0",
              dest_bay_id: "bay-1",
              stage: "source_flipped",
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { withAccountRehomeWriteFence } = await import("./rehome-fence");
    await expect(
      withAccountRehomeWriteFence({
        account_id: ACCOUNT_ID,
        action: "set password",
        fn: async () => {
          throw new Error("write should be fenced");
        },
      }),
    ).rejects.toThrow(/account rehome .* is running/);

    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
    expect(clientReleaseMock).toHaveBeenCalled();
  });

  it("uses the cluster account directory as the authoritative post-rehome home bay", async () => {
    process.env.COCALC_BAY_ID = "bay-1";
    const calls: string[] = [];
    clientQueryMock = jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("to_regclass")) {
        return { rows: [{ table_name: "exists" }] };
      }
      if (sql.includes("FROM account_rehome_operations")) {
        return { rows: [] };
      }
      if (sql.includes("FROM cluster_account_directory")) {
        return { rows: [{ home_bay_id: "bay-2" }] };
      }
      if (sql.includes("FROM accounts")) {
        return { rows: [{ home_bay_id: "bay-1" }] };
      }
      return { rows: [] };
    });

    const { withAccountRehomeWriteFence } = await import("./rehome-fence");
    await expect(
      withAccountRehomeWriteFence({
        account_id: ACCOUNT_ID,
        action: "user-query account update",
        fn: async () => {
          throw new Error("write should be rejected by directory home bay");
        },
      }),
    ).rejects.toThrow(/account is homed on bay-2/);

    expect(calls.some((sql) => sql.includes("cluster_account_directory"))).toBe(
      true,
    );
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
    expect(clientReleaseMock).toHaveBeenCalled();
  });
});
