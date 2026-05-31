/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();
const getProjectUsageAccountIdMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: (...args: any[]) => queryMock(...args),
  }),
}));

jest.mock("./project-usage", () => ({
  getProjectUsageAccountId: (...args: any[]) =>
    getProjectUsageAccountIdMock(...args),
}));

function mockSchemaQueries() {
  queryMock.mockImplementation(async (sql: string) => {
    if (
      sql.includes("CREATE TABLE IF NOT EXISTS account_cpu_usage_events") ||
      sql.includes("CREATE INDEX IF NOT EXISTS account_cpu_usage_events_")
    ) {
      return { rows: [] };
    }
    throw new Error(`unhandled query: ${sql}`);
  });
}

describe("managed CPU usage accounting", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock.mockReset();
    getProjectUsageAccountIdMock.mockReset();
    mockSchemaQueries();
  });

  it("records positive CPU usage against the resolved project usage account", async () => {
    getProjectUsageAccountIdMock.mockResolvedValue("account-1");
    queryMock.mockImplementation(async (sql: string, params?: any[]) => {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS account_cpu_usage_events") ||
        sql.includes("CREATE INDEX IF NOT EXISTS account_cpu_usage_events_")
      ) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO account_cpu_usage_events")) {
        expect(params).toEqual([
          "account-1",
          "project-1",
          "11111111-1111-4111-8111-111111111111",
          12.5,
          new Date("2026-05-30T10:00:00.000Z"),
          new Date("2026-05-30T10:01:00.000Z"),
          "project-host-cgroup",
          { runtime_key: "runtime-1" },
        ]);
        return { rows: [] };
      }
      throw new Error(`unhandled query: ${sql}`);
    });

    const { recordManagedProjectCpuUsage } = await import("./managed-cpu");
    await expect(
      recordManagedProjectCpuUsage({
        project_id: "project-1",
        host_id: "11111111-1111-4111-8111-111111111111",
        cpu_seconds: 12.5,
        sample_started_at: new Date("2026-05-30T10:00:00.000Z"),
        sample_ended_at: new Date("2026-05-30T10:01:00.000Z"),
        metadata: { runtime_key: "runtime-1" },
      }),
    ).resolves.toEqual({ recorded: true, account_id: "account-1" });
  });

  it("ignores invalid CPU deltas", async () => {
    const { recordManagedProjectCpuUsage } = await import("./managed-cpu");
    await expect(
      recordManagedProjectCpuUsage({
        account_id: "account-1",
        cpu_seconds: 0,
      }),
    ).resolves.toEqual({ recorded: false });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("aggregates 5-hour and 7-day windows for an account", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS account_cpu_usage_events") ||
        sql.includes("CREATE INDEX IF NOT EXISTS account_cpu_usage_events_")
      ) {
        return { rows: [] };
      }
      if (sql.includes("AS seconds_5h")) {
        return {
          rows: [{ seconds_5h: "120.5", seconds_7d: "900.25" }],
        };
      }
      if (
        sql.includes("SELECT sample_ended_at") &&
        sql.includes("interval '5 hours'")
      ) {
        return {
          rows: [{ sample_ended_at: "2026-05-30T08:00:00.000Z" }],
        };
      }
      if (
        sql.includes("SELECT sample_ended_at") &&
        sql.includes("interval '7 days'")
      ) {
        return {
          rows: [{ sample_ended_at: "2026-05-29T08:00:00.000Z" }],
        };
      }
      throw new Error(`unhandled query: ${sql}`);
    });

    const { getManagedCpuUsageForAccount } = await import("./managed-cpu");
    const usage = await getManagedCpuUsageForAccount({
      account_id: "account-1",
      limit5h: 100,
      limit7d: 1000,
    });

    expect(usage).toMatchObject({
      managed_cpu_5h_seconds: 120.5,
      managed_cpu_7d_seconds: 900.25,
      managed_cpu_5h_remaining_seconds: -20.5,
      managed_cpu_7d_remaining_seconds: 99.75,
      over_managed_cpu_5h: true,
      over_managed_cpu_7d: false,
    });
    expect(usage.managed_cpu_5h_reset_at?.toISOString()).toBe(
      "2026-05-30T13:00:00.000Z",
    );
    expect(usage.managed_cpu_7d_reset_at?.toISOString()).toBe(
      "2026-06-05T08:00:00.000Z",
    );
  });

  it("lists top CPU accounts and projects for admin overview", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS account_cpu_usage_events") ||
        sql.includes("CREATE INDEX IF NOT EXISTS account_cpu_usage_events_")
      ) {
        return { rows: [] };
      }
      if (sql.includes("SELECT COALESCE(SUM(events.cpu_seconds), 0)")) {
        return { rows: [{ cpu_seconds: "3600" }] };
      }
      if (
        sql.includes("accounts.email_address") &&
        sql.includes("GROUP BY") &&
        !sql.includes("projects.title AS project_title")
      ) {
        return {
          rows: [
            {
              account_id: "account-1",
              email_address: "ada@example.com",
              first_name: "Ada",
              last_name: "Lovelace",
              cpu_seconds: "3000",
            },
          ],
        };
      }
      if (
        sql.includes("projects.title AS project_title") &&
        sql.includes("GROUP BY") &&
        sql.includes("events.host_id")
      ) {
        return {
          rows: [
            {
              account_id: "account-1",
              email_address: "ada@example.com",
              first_name: "Ada",
              last_name: "Lovelace",
              project_id: "project-1",
              project_title: "Number theory",
              host_id: "11111111-1111-4111-8111-111111111111",
              cpu_seconds: "3000",
            },
          ],
        };
      }
      if (sql.includes("ORDER BY events.sample_ended_at DESC")) {
        return {
          rows: [
            {
              account_id: "account-1",
              project_id: "project-1",
              project_title: "Number theory",
              host_id: "11111111-1111-4111-8111-111111111111",
              cpu_seconds: "60",
              sample_started_at: "2026-05-30T10:00:00.000Z",
              sample_ended_at: "2026-05-30T10:01:00.000Z",
              source: "project-host-cgroup",
              metadata: { runtime_key: "runtime-1" },
            },
          ],
        };
      }
      throw new Error(`unhandled query: ${sql}`);
    });

    const { getManagedCpuAdminOverview } = await import("./managed-cpu");
    const overview = await getManagedCpuAdminOverview({
      start: "2026-05-30T09:00:00.000Z",
      end: "2026-05-30T11:00:00.000Z",
    });

    expect(overview.total_cpu_seconds).toBe(3600);
    expect(overview.top_accounts).toEqual([
      {
        account_id: "account-1",
        email_address: "ada@example.com",
        first_name: "Ada",
        last_name: "Lovelace",
        cpu_seconds: 3000,
      },
    ]);
    expect(overview.top_projects).toEqual([
      {
        account_id: "account-1",
        email_address: "ada@example.com",
        first_name: "Ada",
        last_name: "Lovelace",
        project_id: "project-1",
        project_title: "Number theory",
        host_id: "11111111-1111-4111-8111-111111111111",
        cpu_seconds: 3000,
      },
    ]);
    expect(overview.recent_events).toEqual([
      {
        account_id: "account-1",
        project_id: "project-1",
        project_title: "Number theory",
        host_id: "11111111-1111-4111-8111-111111111111",
        cpu_seconds: 60,
        sample_started_at: "2026-05-30T10:00:00.000Z",
        sample_ended_at: "2026-05-30T10:01:00.000Z",
        source: "project-host-cgroup",
        metadata: { runtime_key: "runtime-1" },
      },
    ]);
  });
});
