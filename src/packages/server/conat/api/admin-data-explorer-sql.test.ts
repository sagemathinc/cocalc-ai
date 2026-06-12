/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let isAdminMock: jest.Mock;
let requireDangerousSessionAuthMock: jest.Mock;
let centralLogMock: jest.Mock;

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("./dangerous-session-auth", () => ({
  __esModule: true,
  requireDangerousSessionAuth: (...args: any[]) =>
    requireDangerousSessionAuthMock(...args),
}));

jest.mock("@cocalc/database/postgres/central-log", () => ({
  __esModule: true,
  default: (...args: any[]) => centralLogMock(...args),
}));

describe("Admin Data Explorer SQL validation", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    isAdminMock = jest.fn(async () => true);
    requireDangerousSessionAuthMock = jest.fn(async () => ({}));
    centralLogMock = jest.fn(async () => undefined);
  });

  it("accepts one read-only SELECT over allowlisted relations", async () => {
    const { validateSql } = await import("./admin-data-explorer");
    const result = await validateSql({
      account_id: ACCOUNT_ID,
      session_hash: "fresh",
      sql: "select account_id, email_address from accounts order by created desc limit 10",
      limit: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.relations).toEqual(["accounts"]);
    expect(result.enforced_limit).toBe(10);
    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: undefined,
      session_hash: "fresh",
      require_second_factor: true,
    });
  });

  it("rejects multiple statements, mutations, blocked schemas, and unknown functions", async () => {
    const { validateSql } = await import("./admin-data-explorer");

    await expect(
      validateSql({
        account_id: ACCOUNT_ID,
        session_hash: "fresh",
        sql: "select 1; select 2",
      }),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["exactly one SQL statement is allowed"],
    });

    await expect(
      validateSql({
        account_id: ACCOUNT_ID,
        session_hash: "fresh",
        sql: "update accounts set first_name = 'bad'",
      }),
    ).resolves.toMatchObject({
      ok: false,
      errors: [
        "only SELECT and read-only WITH statements are allowed, not update",
      ],
    });

    await expect(
      validateSql({
        account_id: ACCOUNT_ID,
        session_hash: "fresh",
        sql: "select relname from pg_catalog.pg_tables",
      }),
    ).resolves.toMatchObject({
      ok: false,
      errors: [
        "schema 'pg_catalog' is not allowed",
        "relation 'pg_tables' is not allowed",
      ],
    });

    await expect(
      validateSql({
        account_id: ACCOUNT_ID,
        session_hash: "fresh",
        sql: "select pg_sleep(10)",
      }),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["function 'pg_sleep' is not allowed"],
    });
  });

  it("rejects wildcard projections but allows count(*)", async () => {
    const { validateSql } = await import("./admin-data-explorer");

    await expect(
      validateSql({
        account_id: ACCOUNT_ID,
        session_hash: "fresh",
        sql: "select * from accounts",
      }),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["SELECT * is not allowed; choose allowed columns explicitly"],
    });

    await expect(
      validateSql({
        account_id: ACCOUNT_ID,
        session_hash: "fresh",
        sql: "select accounts.* from accounts",
      }),
    ).resolves.toMatchObject({
      ok: false,
      errors: [
        "SELECT * is not allowed; choose allowed columns explicitly",
        "wildcard column reference 'accounts.*' is not allowed",
      ],
    });

    await expect(
      validateSql({
        account_id: ACCOUNT_ID,
        session_hash: "fresh",
        sql: "select count(*) from accounts",
      }),
    ).resolves.toMatchObject({
      ok: true,
      errors: [],
    });
  });

  it("enforces relation column allowlists", async () => {
    const { validateSql } = await import("./admin-data-explorer");

    await expect(
      validateSql({
        account_id: ACCOUNT_ID,
        session_hash: "fresh",
        sql: "select password_hash from accounts",
      }),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["column 'accounts.password_hash' is not allowed"],
    });

    await expect(
      validateSql({
        account_id: ACCOUNT_ID,
        session_hash: "fresh",
        sql: "select accounts.account_id from accounts",
      }),
    ).resolves.toMatchObject({
      ok: true,
      errors: [],
    });
  });

  it("requires column qualification when querying multiple base relations", async () => {
    const { validateSql } = await import("./admin-data-explorer");

    await expect(
      validateSql({
        account_id: ACCOUNT_ID,
        session_hash: "fresh",
        sql: "select account_id from accounts join projects on accounts.account_id = projects.project_id",
      }),
    ).resolves.toMatchObject({
      ok: false,
      errors: [
        "column 'account_id' must be qualified when querying multiple relations",
      ],
    });

    await expect(
      validateSql({
        account_id: ACCOUNT_ID,
        session_hash: "fresh",
        sql: "select accounts.account_id, projects.project_id from accounts join projects on accounts.account_id = projects.project_id",
      }),
    ).resolves.toMatchObject({
      ok: true,
      errors: [],
    });
  });

  it("validates all bundled starter SQL views", async () => {
    const { validateSql } = await import("./admin-data-explorer");
    const { ADMIN_DATA_EXPLORER_STARTER_VIEWS } =
      await import("@cocalc/conat/hub/api/admin-data-explorer");

    for (const view of ADMIN_DATA_EXPLORER_STARTER_VIEWS) {
      if (view.query_kind !== "sql") continue;
      const result = await validateSql({
        account_id: ACCOUNT_ID,
        session_hash: "fresh",
        sql: view.query.sql,
        limit: view.default_limit ?? undefined,
      });
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });
});
