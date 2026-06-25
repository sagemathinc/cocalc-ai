/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();
const getProjectUsageAccountIdMock = jest.fn();
const listActiveAbuseReviewAnnotationsMock = jest.fn();
const ensureAccountUsageWindowsForEventMock = jest.fn();
const getActiveAccountUsageWindowsMock = jest.fn();
const getManagedCpuAccountingClassificationForHostMock = jest.fn();
const getAdminAccountMembershipStatusMapMock = jest.fn();

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

jest.mock("./abuse-review-annotations", () => ({
  listActiveAbuseReviewAnnotations: (...args: any[]) =>
    listActiveAbuseReviewAnnotationsMock(...args),
}));

jest.mock("./admin-account-status", () => ({
  getAdminAccountMembershipStatusMap: (...args: any[]) =>
    getAdminAccountMembershipStatusMapMock(...args),
}));

jest.mock("./usage-windows", () => ({
  ensureAccountUsageWindowsForEvent: (...args: any[]) =>
    ensureAccountUsageWindowsForEventMock(...args),
  getActiveAccountUsageWindows: (...args: any[]) =>
    getActiveAccountUsageWindowsMock(...args),
}));

jest.mock("./managed-cpu-scope", () => ({
  getManagedCpuAccountingClassificationForHost: (...args: any[]) =>
    getManagedCpuAccountingClassificationForHostMock(...args),
}));

function mockSchemaQueries() {
  queryMock.mockImplementation(async (sql: string) => {
    if (
      sql.includes("CREATE TABLE IF NOT EXISTS account_cpu_usage_events") ||
      sql.includes("ALTER TABLE account_cpu_usage_events") ||
      sql.includes("UPDATE account_cpu_usage_events") ||
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
    listActiveAbuseReviewAnnotationsMock.mockReset();
    ensureAccountUsageWindowsForEventMock.mockReset();
    getActiveAccountUsageWindowsMock.mockReset();
    getManagedCpuAccountingClassificationForHostMock.mockReset();
    getAdminAccountMembershipStatusMapMock.mockReset();
    listActiveAbuseReviewAnnotationsMock.mockResolvedValue([]);
    getAdminAccountMembershipStatusMapMock.mockResolvedValue(new Map());
    ensureAccountUsageWindowsForEventMock.mockResolvedValue({});
    getManagedCpuAccountingClassificationForHostMock.mockResolvedValue({
      scope: "shared_managed",
      counts_toward_managed_cpu_budget: true,
      host_tier_snapshot: 1,
      host_kind_snapshot: "shared-tiered-host",
    });
    getActiveAccountUsageWindowsMock.mockResolvedValue({
      "5h": {
        starts_at: new Date("2026-05-30T08:00:00.000Z"),
        resets_at: new Date("2026-05-30T13:00:00.000Z"),
      },
      "7d": {
        starts_at: new Date("2026-05-29T08:00:00.000Z"),
        resets_at: new Date("2026-06-05T08:00:00.000Z"),
      },
    });
    mockSchemaQueries();
  });

  it("records positive CPU usage against the resolved project usage account", async () => {
    getProjectUsageAccountIdMock.mockResolvedValue("account-1");
    queryMock.mockImplementation(async (sql: string, params?: any[]) => {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS account_cpu_usage_events") ||
        sql.includes("ALTER TABLE account_cpu_usage_events") ||
        sql.includes("UPDATE account_cpu_usage_events") ||
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
          "shared_managed",
          true,
          null,
          1,
          "shared-tiered-host",
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
    expect(ensureAccountUsageWindowsForEventMock).toHaveBeenCalledWith({
      account_id: "account-1",
      occurred_at: new Date("2026-05-30T10:01:00.000Z"),
    });
  });

  it("records account-funded dedicated CPU without creating shared budget windows", async () => {
    getManagedCpuAccountingClassificationForHostMock.mockResolvedValue({
      scope: "account_funded_dedicated",
      counts_toward_managed_cpu_budget: false,
      host_funding_mode_snapshot: "account-prepaid",
      host_kind_snapshot: "account-funded-dedicated",
    });
    queryMock.mockImplementation(async (sql: string, params?: any[]) => {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS account_cpu_usage_events") ||
        sql.includes("ALTER TABLE account_cpu_usage_events") ||
        sql.includes("UPDATE account_cpu_usage_events") ||
        sql.includes("CREATE INDEX IF NOT EXISTS account_cpu_usage_events_")
      ) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO account_cpu_usage_events")) {
        expect(params).toEqual([
          "account-1",
          null,
          "11111111-1111-4111-8111-111111111111",
          30,
          null,
          null,
          "project-host-cgroup",
          "account_funded_dedicated",
          false,
          "account-prepaid",
          null,
          "account-funded-dedicated",
          null,
        ]);
        return { rows: [] };
      }
      throw new Error(`unhandled query: ${sql}`);
    });

    const { recordManagedProjectCpuUsage } = await import("./managed-cpu");
    await expect(
      recordManagedProjectCpuUsage({
        account_id: "account-1",
        host_id: "11111111-1111-4111-8111-111111111111",
        cpu_seconds: 30,
      }),
    ).resolves.toEqual({ recorded: true, account_id: "account-1" });
    expect(ensureAccountUsageWindowsForEventMock).not.toHaveBeenCalled();
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
    queryMock.mockImplementation(async (sql: string, params?: any[]) => {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS account_cpu_usage_events") ||
        sql.includes("ALTER TABLE account_cpu_usage_events") ||
        sql.includes("UPDATE account_cpu_usage_events") ||
        sql.includes("CREATE INDEX IF NOT EXISTS account_cpu_usage_events_")
      ) {
        return { rows: [] };
      }
      if (sql.includes("AS seconds_5h")) {
        expect(sql).toContain("events.counts_toward_managed_cpu_budget = TRUE");
        expect(params).toEqual([
          "account-1",
          new Date("2026-05-30T08:00:00.000Z"),
          new Date("2026-05-30T13:00:00.000Z"),
          new Date("2026-05-29T08:00:00.000Z"),
          new Date("2026-06-05T08:00:00.000Z"),
        ]);
        return {
          rows: [{ seconds_5h: "120.5", seconds_7d: "900.25" }],
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
        sql.includes("ALTER TABLE account_cpu_usage_events") ||
        sql.includes("UPDATE account_cpu_usage_events") ||
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
              display_name: "Ada Lovelace",
              first_name: "Ada",
              last_name: "Lovelace",
              banned: true,
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
              display_name: "Ada Lovelace",
              first_name: "Ada",
              last_name: "Lovelace",
              banned: true,
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
        display_name: "Ada Lovelace",
        first_name: "Ada",
        last_name: "Lovelace",
        banned: true,
        membership_class: "free",
        membership_label: "Free",
        membership_source: "free",
        cpu_seconds: 3000,
        active_abuse_annotations: [],
      },
    ]);
    expect(overview.top_projects).toEqual([
      {
        account_id: "account-1",
        email_address: "ada@example.com",
        display_name: "Ada Lovelace",
        first_name: "Ada",
        last_name: "Lovelace",
        banned: true,
        membership_class: "free",
        membership_label: "Free",
        membership_source: "free",
        project_id: "project-1",
        project_title: "Number theory",
        host_id: "11111111-1111-4111-8111-111111111111",
        cpu_seconds: 3000,
        active_abuse_annotations: [],
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

  it("aggregates CPU admin history into bounded time buckets", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS account_cpu_usage_events") ||
        sql.includes("ALTER TABLE account_cpu_usage_events") ||
        sql.includes("UPDATE account_cpu_usage_events") ||
        sql.includes("CREATE INDEX IF NOT EXISTS account_cpu_usage_events_")
      ) {
        return { rows: [] };
      }
      if (sql.includes("GROUP BY bucket_start")) {
        return {
          rows: [
            {
              bucket_start: "2026-05-30T10:00:00.000Z",
              cpu_seconds: "200",
            },
            {
              bucket_start: "2026-05-30T11:00:00.000Z",
              cpu_seconds: "300",
            },
          ],
        };
      }
      if (sql.includes("SELECT COALESCE(SUM(events.cpu_seconds), 0)")) {
        return { rows: [{ cpu_seconds: "500" }] };
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
              display_name: "Ada Lovelace",
              first_name: "Ada",
              last_name: "Lovelace",
              banned: false,
              cpu_seconds: "500",
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
              display_name: "Ada Lovelace",
              first_name: "Ada",
              last_name: "Lovelace",
              banned: false,
              project_id: "project-1",
              project_title: "Number theory",
              host_id: "11111111-1111-4111-8111-111111111111",
              cpu_seconds: "450",
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
              sample_started_at: "2026-05-30T11:59:00.000Z",
              sample_ended_at: "2026-05-30T12:00:00.000Z",
              source: "project-host-proc-tree",
              metadata: { runtime_key: "runtime-1" },
            },
          ],
        };
      }
      throw new Error(`unhandled query: ${sql}`);
    });

    const { getManagedCpuAdminHistory } = await import("./managed-cpu");
    const result = await getManagedCpuAdminHistory({
      account_id: "account-1",
      project_id: "project-1",
      start: "2026-05-30T10:15:00.000Z",
      end: "2026-05-30T12:15:00.000Z",
      bucket: "1h",
      recent_event_limit: 5,
      top_account_limit: 5,
      top_project_limit: 5,
    });

    expect(result.total_cpu_seconds).toBe(500);
    expect(result.points).toHaveLength(3);
    expect(result.points[0]).toMatchObject({
      start: "2026-05-30T10:00:00.000Z",
      cpu_seconds: 200,
    });
    expect(result.points[1]).toMatchObject({
      start: "2026-05-30T11:00:00.000Z",
      cpu_seconds: 300,
    });
    expect(result.points[2]).toMatchObject({
      start: "2026-05-30T12:00:00.000Z",
      cpu_seconds: 0,
    });
    expect(result.top_accounts).toEqual([
      {
        account_id: "account-1",
        email_address: "ada@example.com",
        display_name: "Ada Lovelace",
        first_name: "Ada",
        last_name: "Lovelace",
        banned: false,
        membership_class: "free",
        membership_label: "Free",
        membership_source: "free",
        cpu_seconds: 500,
        active_abuse_annotations: [],
      },
    ]);
    expect(result.top_projects).toEqual([
      {
        account_id: "account-1",
        email_address: "ada@example.com",
        display_name: "Ada Lovelace",
        first_name: "Ada",
        last_name: "Lovelace",
        banned: false,
        membership_class: "free",
        membership_label: "Free",
        membership_source: "free",
        project_id: "project-1",
        project_title: "Number theory",
        host_id: "11111111-1111-4111-8111-111111111111",
        cpu_seconds: 450,
        active_abuse_annotations: [],
      },
    ]);
    expect(result.recent_events).toEqual([
      {
        account_id: "account-1",
        project_id: "project-1",
        project_title: "Number theory",
        host_id: "11111111-1111-4111-8111-111111111111",
        cpu_seconds: 60,
        sample_started_at: "2026-05-30T11:59:00.000Z",
        sample_ended_at: "2026-05-30T12:00:00.000Z",
        source: "project-host-proc-tree",
        metadata: { runtime_key: "runtime-1" },
      },
    ]);
  });

  it("rejects overly granular CPU history requests", async () => {
    const { getManagedCpuAdminHistory } = await import("./managed-cpu");
    await expect(
      getManagedCpuAdminHistory({
        start: "2026-03-01T00:00:00.000Z",
        end: "2026-03-16T00:00:00.000Z",
        bucket: "5m",
      }),
    ).rejects.toThrow("history query is too granular");
  });
});
