export {};

let queryMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

describe("bay-backfill", () => {
  let prevBayId: string | undefined;

  beforeEach(() => {
    jest.resetModules();
    prevBayId = process.env.COCALC_BAY_ID;
    delete process.env.COCALC_BAY_ID;
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM accounts")) {
        return { rows: [{ count: "3" }] };
      }
      if (sql.includes("FROM projects")) {
        return { rows: [{ count: "5" }] };
      }
      if (sql.includes("FROM project_hosts")) {
        return { rows: [{ count: "2" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  afterEach(() => {
    if (prevBayId == null) {
      delete process.env.COCALC_BAY_ID;
    } else {
      process.env.COCALC_BAY_ID = prevBayId;
    }
  });

  it("reports missing rows in dry-run mode using the configured bay", async () => {
    process.env.COCALC_BAY_ID = "bay-local";
    const { backfillBayOwnership } = await import("./bay-backfill");

    await expect(backfillBayOwnership({})).resolves.toEqual({
      bay_id: "bay-local",
      dry_run: true,
      limit_per_table: null,
      accounts_missing: 3,
      projects_missing: 5,
      hosts_missing: 2,
      accounts_updated: 0,
      projects_updated: 0,
      hosts_updated: 0,
    });
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it("updates missing rows in bounded write mode", async () => {
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("SELECT COUNT(*)::TEXT AS count")) {
        if (sql.includes("FROM accounts")) return { rows: [{ count: "4" }] };
        if (sql.includes("FROM projects")) return { rows: [{ count: "6" }] };
        if (sql.includes("FROM project_hosts")) {
          return { rows: [{ count: "2" }] };
        }
      }
      if (sql.includes("WITH targets AS")) {
        if (sql.includes("UPDATE accounts")) {
          expect(params).toEqual(["bay-7", 2]);
          return {
            rows: [{ account_id: "a1" }, { account_id: "a2" }],
          };
        }
        if (sql.includes("UPDATE projects")) {
          expect(params).toEqual(["bay-7", 2]);
          return {
            rows: [{ project_id: "p1" }],
          };
        }
        if (sql.includes("UPDATE project_hosts")) {
          expect(params).toEqual(["bay-7", 2]);
          return {
            rows: [{ id: "h1" }, { id: "h2" }],
          };
        }
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const { backfillBayOwnership } = await import("./bay-backfill");

    await expect(
      backfillBayOwnership({
        bay_id: "bay-7",
        dry_run: false,
        limit_per_table: 2,
      }),
    ).resolves.toEqual({
      bay_id: "bay-7",
      dry_run: false,
      limit_per_table: 2,
      accounts_missing: 4,
      projects_missing: 6,
      hosts_missing: 2,
      accounts_updated: 2,
      projects_updated: 1,
      hosts_updated: 2,
    });
  });
});
