/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();
const listActiveAbuseReviewAnnotationsMock = jest.fn();
const getAdminAccountMembershipStatusMapMock = jest.fn();
const ensureAccountUsageWindowsForEventMock = jest.fn();
const getActiveAccountUsageWindowsMock = jest.fn();
const ensureAccountUsageCountersInitializedMock = jest.fn();
const getAccountUsageCounterValuesMock = jest.fn();
const recordAccountUsageCounterDeltaMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: (...args: any[]) => queryMock(...args),
  }),
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

jest.mock("./usage-counters", () => ({
  ensureAccountUsageCountersInitialized: (...args: any[]) =>
    ensureAccountUsageCountersInitializedMock(...args),
  getAccountUsageCounterValues: (...args: any[]) =>
    getAccountUsageCounterValuesMock(...args),
  recordAccountUsageCounterDelta: (...args: any[]) =>
    recordAccountUsageCounterDeltaMock(...args),
}));

describe("managed egress history", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock.mockReset();
    listActiveAbuseReviewAnnotationsMock.mockReset();
    getAdminAccountMembershipStatusMapMock.mockReset();
    ensureAccountUsageWindowsForEventMock.mockReset();
    getActiveAccountUsageWindowsMock.mockReset();
    ensureAccountUsageCountersInitializedMock.mockReset();
    getAccountUsageCounterValuesMock.mockReset();
    recordAccountUsageCounterDeltaMock.mockReset();
    listActiveAbuseReviewAnnotationsMock.mockResolvedValue([]);
    getAdminAccountMembershipStatusMapMock.mockResolvedValue(new Map());
    ensureAccountUsageCountersInitializedMock.mockResolvedValue(undefined);
    getAccountUsageCounterValuesMock.mockResolvedValue({
      "5h": {},
      "7d": {},
    });
    const windows = {
      "5h": {
        id: "11111111-1111-4111-8111-111111111111",
        starts_at: new Date("2026-04-28T07:00:00.000Z"),
        resets_at: new Date("2026-04-28T12:00:00.000Z"),
      },
      "7d": {
        id: "22222222-2222-4222-8222-222222222222",
        starts_at: new Date("2026-04-21T12:00:00.000Z"),
        resets_at: new Date("2026-04-28T12:00:00.000Z"),
      },
    };
    ensureAccountUsageWindowsForEventMock.mockResolvedValue(windows);
    getActiveAccountUsageWindowsMock.mockResolvedValue(windows);
    queryMock.mockImplementation(async (sql: string) => {
      throw new Error(`unhandled query: ${sql}`);
    });
  });

  it("aggregates account history into bounded time buckets", async () => {
    queryMock.mockImplementation(async (sql: string, params?: any[]) => {
      const reportingExclusions = sql.includes(
        "ORDER BY events.last_occurred_at DESC",
      )
        ? params?.slice(-2)[0]
        : params?.slice(-1)[0];
      expect(reportingExclusions).toEqual(["interactive-conat"]);
      if (
        sql.includes(
          "SELECT events.category, COALESCE(SUM(events.bytes), 0) AS bytes",
        )
      ) {
        return {
          rows: [
            { category: "file-download", bytes: "200" },
            { category: "raw-network", bytes: "300" },
            { category: "backup-upload", bytes: "100" },
          ],
        };
      }
      if (sql.includes("GROUP BY 1, events.category")) {
        return {
          rows: [
            {
              bucket_start: "2026-04-28T10:00:00.000Z",
              category: "file-download",
              bytes: "75",
            },
            {
              bucket_start: "2026-04-28T10:00:00.000Z",
              category: "file-download",
              bytes: "125",
            },
            {
              bucket_start: "2026-04-28T11:00:00.000Z",
              category: "raw-network",
              bytes: "300",
            },
            {
              bucket_start: "2026-04-28T11:00:00.000Z",
              category: "backup-upload",
              bytes: "100",
            },
          ],
        };
      }
      if (sql.includes("GROUP BY events.project_id, projects.title")) {
        return {
          rows: [
            {
              project_id: "project-1",
              project_title: "Lite One",
              bytes: "550",
            },
            {
              project_id: null,
              project_title: null,
              bytes: "50",
            },
          ],
        };
      }
      if (sql.includes("ORDER BY events.last_occurred_at DESC")) {
        return {
          rows: [
            {
              account_id: "account-1",
              project_id: "project-1",
              project_title: "Lite One",
              category: "backup-upload",
              bytes: "100",
              occurred_at: "2026-04-28T11:30:00.000Z",
              metadata: { backup_id: "backup-1" },
            },
          ],
        };
      }
      throw new Error(`unhandled query: ${sql}`);
    });

    const { getManagedEgressHistoryForAccount } =
      await import("./managed-egress");
    const result = await getManagedEgressHistoryForAccount({
      account_id: "account-1",
      start: "2026-04-28T10:15:00.000Z",
      end: "2026-04-28T12:15:00.000Z",
      bucket: "1h",
      recent_event_limit: 5,
      top_project_limit: 5,
    });

    expect(result.account_id).toBe("account-1");
    expect(result.total_bytes).toBe(600);
    expect(result.categories_bytes).toEqual({
      "backup-upload": 100,
      "file-download": 200,
      "raw-network": 300,
    });
    expect(result.points).toHaveLength(3);
    expect(result.points[0]).toMatchObject({
      start: "2026-04-28T10:00:00.000Z",
      bytes: 200,
      categories_bytes: { "file-download": 200 },
    });
    expect(result.points[1]).toMatchObject({
      start: "2026-04-28T11:00:00.000Z",
      bytes: 400,
      categories_bytes: { "backup-upload": 100, "raw-network": 300 },
    });
    expect(result.points[2]).toMatchObject({
      start: "2026-04-28T12:00:00.000Z",
      bytes: 0,
      categories_bytes: {},
    });
    expect(result.top_projects).toEqual([
      {
        project_id: "project-1",
        project_title: "Lite One",
        bytes: 550,
      },
      {
        project_id: null,
        project_title: null,
        bytes: 50,
      },
    ]);
    expect(result.recent_events).toEqual([
      {
        account_id: "account-1",
        project_id: "project-1",
        project_title: "Lite One",
        category: "backup-upload",
        bytes: 100,
        occurred_at: "2026-04-28T11:30:00.000Z",
        metadata: { backup_id: "backup-1" },
      },
    ]);
  });

  it("rejects overly granular history requests", async () => {
    const { getManagedEgressHistoryForAccount } =
      await import("./managed-egress");
    await expect(
      getManagedEgressHistoryForAccount({
        account_id: "account-1",
        start: "2026-03-01T00:00:00.000Z",
        end: "2026-03-16T00:00:00.000Z",
        bucket: "5m",
      }),
    ).rejects.toThrow("history query is too granular");
  });

  it("computes membership quota usage without interactive or control traffic", async () => {
    const starts5h = new Date("2026-04-28T07:00:00.000Z");
    const resets5h = new Date("2026-04-28T12:00:00.000Z");
    const starts7d = new Date("2026-04-21T12:00:00.000Z");
    const resets7d = new Date("2026-04-28T12:00:00.000Z");
    getActiveAccountUsageWindowsMock.mockResolvedValue({
      "5h": {
        id: "11111111-1111-4111-8111-111111111111",
        starts_at: starts5h,
        resets_at: resets5h,
      },
      "7d": {
        id: "22222222-2222-4222-8222-222222222222",
        starts_at: starts7d,
        resets_at: resets7d,
      },
    });
    getAccountUsageCounterValuesMock.mockResolvedValue({
      "5h": { "raw-network": 200 },
      "7d": { "raw-network": 500 },
    });

    const { getManagedEgressUsageForAccount } =
      await import("./managed-egress");
    const result = await getManagedEgressUsageForAccount({
      account_id: "account-1",
      limit5h: 1000,
      limit7d: 2000,
    });

    expect(result.managed_egress_5h_bytes).toBe(200);
    expect(result.managed_egress_7d_bytes).toBe(500);
    expect(result.managed_egress_categories_5h_bytes).toEqual({
      "raw-network": 200,
    });
    expect(result.managed_egress_categories_7d_bytes).toEqual({
      "raw-network": 500,
    });
    expect(ensureAccountUsageCountersInitializedMock).toHaveBeenCalledTimes(1);
    expect(getAccountUsageCounterValuesMock).toHaveBeenCalledTimes(1);
  });

  it("preserves 7-day usage when the shorter window has expired", async () => {
    getActiveAccountUsageWindowsMock.mockResolvedValue({
      "7d": {
        id: "22222222-2222-4222-8222-222222222222",
        starts_at: new Date("2026-04-21T12:00:00.000Z"),
        resets_at: new Date("2026-04-28T12:00:00.000Z"),
      },
    });
    getAccountUsageCounterValuesMock.mockResolvedValue({
      "5h": {},
      "7d": { "raw-network": 500 },
    });
    const { getManagedEgressUsageForAccount } =
      await import("./managed-egress");

    await expect(
      getManagedEgressUsageForAccount({
        account_id: "account-1",
        limit5h: 1000,
        limit7d: 400,
      }),
    ).resolves.toMatchObject({
      managed_egress_5h_bytes: 0,
      managed_egress_7d_bytes: 500,
      over_managed_egress_5h: false,
      over_managed_egress_7d: true,
    });
  });

  it("opens quota windows for backups but not control-plane traffic", async () => {
    const { recordManagedProjectEgress } = await import("./managed-egress");

    await recordManagedProjectEgress({
      account_id: "account-1",
      project_id: "project-1",
      category: "backup-upload",
      bytes: 100,
    });
    expect(ensureAccountUsageWindowsForEventMock).toHaveBeenCalledTimes(1);

    await recordManagedProjectEgress({
      account_id: "account-1",
      category: "control-plane-conat",
      bytes: 100,
    });
    expect(ensureAccountUsageWindowsForEventMock).toHaveBeenCalledTimes(1);
    expect(ensureAccountUsageWindowsForEventMock).toHaveBeenCalledWith({
      account_id: "account-1",
      occurred_at: undefined,
    });
    expect(recordAccountUsageCounterDeltaMock).toHaveBeenCalledTimes(1);
  });

  it("computes a dedicated rolling category usage window", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    queryMock.mockImplementation(async (sql: string, params?: any[]) => {
      if (
        sql.includes("category = $2") &&
        sql.includes("SUM(CASE WHEN bucket_start >= $3")
      ) {
        expect(params).toEqual([
          "account-1",
          "control-plane-conat",
          new Date("2026-04-28T07:00:00.000Z"),
          new Date("2026-04-21T12:00:00.000Z"),
          now,
        ]);
        return { rows: [{ bytes_5h: "123", bytes_7d: "456" }] };
      }
      throw new Error(`unhandled query: ${sql}`);
    });

    const {
      getManagedEgressCategoryUsageForAccount,
      recordManagedProjectEgress,
    } = await import("./managed-egress");
    await recordManagedProjectEgress({
      account_id: "account-1",
      category: "control-plane-conat",
      bytes: 10,
      occurred_at: new Date("2026-04-28T11:59:00.000Z"),
    });
    await expect(
      getManagedEgressCategoryUsageForAccount({
        account_id: "account-1",
        category: "control-plane-conat",
        now,
      }),
    ).resolves.toEqual({ bytes_5h: 133, bytes_7d: 466 });
  });

  it("aggregates admin-wide top accounts and projects", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (
        sql.includes(
          "SELECT events.category, COALESCE(SUM(events.bytes), 0) AS bytes",
        )
      ) {
        return {
          rows: [{ category: "raw-network", bytes: "8192" }],
        };
      }
      if (
        sql.includes("accounts.email_address") &&
        sql.includes("GROUP BY") &&
        sql.includes("events.account_id") &&
        !sql.includes("projects.title AS project_title")
      ) {
        return {
          rows: [
            {
              account_id: "acct-1",
              email_address: "ada@example.com",
              display_name: "Ada Lovelace",
              first_name: "Ada",
              last_name: "Lovelace",
              banned: true,
              bytes: "6000",
            },
            {
              account_id: "acct-2",
              email_address: "alan@example.com",
              display_name: "Alan Turing",
              first_name: "Alan",
              last_name: "Turing",
              banned: false,
              bytes: "2192",
            },
          ],
        };
      }
      if (
        sql.includes("projects.title AS project_title") &&
        sql.includes("accounts.email_address")
      ) {
        return {
          rows: [
            {
              account_id: "acct-1",
              email_address: "ada@example.com",
              display_name: "Ada Lovelace",
              first_name: "Ada",
              last_name: "Lovelace",
              banned: true,
              project_id: "project-1",
              project_title: "Lite One",
              bytes: "4096",
            },
          ],
        };
      }
      if (sql.includes("ORDER BY events.last_occurred_at DESC")) {
        return {
          rows: [
            {
              account_id: "acct-1",
              project_id: "project-1",
              project_title: "Lite One",
              category: "raw-network",
              bytes: "4096",
              occurred_at: "2026-04-28T11:30:00.000Z",
              metadata: { interface_name: "ens4" },
            },
          ],
        };
      }
      throw new Error(`unhandled query: ${sql}`);
    });

    const { getManagedEgressAdminOverview } = await import("./managed-egress");
    const result = await getManagedEgressAdminOverview({
      start: "2026-04-28T10:00:00.000Z",
      end: "2026-04-29T10:00:00.000Z",
      top_account_limit: 5,
      top_project_limit: 5,
      recent_event_limit: 5,
    });

    expect(result.total_bytes).toBe(8192);
    expect(result.categories_bytes).toEqual({ "raw-network": 8192 });
    expect(result.top_accounts).toEqual([
      {
        account_id: "acct-1",
        email_address: "ada@example.com",
        display_name: "Ada Lovelace",
        first_name: "Ada",
        last_name: "Lovelace",
        banned: true,
        membership_class: "free",
        membership_label: "Free",
        membership_source: "free",
        bytes: 6000,
        active_abuse_annotations: [],
      },
      {
        account_id: "acct-2",
        email_address: "alan@example.com",
        display_name: "Alan Turing",
        first_name: "Alan",
        last_name: "Turing",
        banned: false,
        membership_class: "free",
        membership_label: "Free",
        membership_source: "free",
        bytes: 2192,
        active_abuse_annotations: [],
      },
    ]);
    expect(result.top_projects).toEqual([
      {
        account_id: "acct-1",
        email_address: "ada@example.com",
        display_name: "Ada Lovelace",
        first_name: "Ada",
        last_name: "Lovelace",
        banned: true,
        membership_class: "free",
        membership_label: "Free",
        membership_source: "free",
        project_id: "project-1",
        project_title: "Lite One",
        bytes: 4096,
        active_abuse_annotations: [],
      },
    ]);
    expect(result.recent_events).toEqual([
      {
        account_id: "acct-1",
        project_id: "project-1",
        project_title: "Lite One",
        category: "raw-network",
        bytes: 4096,
        occurred_at: "2026-04-28T11:30:00.000Z",
        metadata: { interface_name: "ens4" },
      },
    ]);

    queryMock.mockClear();
    listActiveAbuseReviewAnnotationsMock.mockClear();
    getAdminAccountMembershipStatusMapMock.mockClear();

    const cachedResult = await getManagedEgressAdminOverview({
      start: "2026-04-28T10:00:00.000Z",
      end: "2026-04-29T10:00:00.000Z",
      top_account_limit: 5,
      top_project_limit: 5,
      recent_event_limit: 5,
    });

    expect(cachedResult.total_bytes).toBe(8192);
    expect(
      queryMock.mock.calls.filter(([sql]) =>
        `${sql}`.includes(
          "SELECT events.category, COALESCE(SUM(events.bytes), 0) AS bytes",
        ),
      ),
    ).toHaveLength(0);
    expect(listActiveAbuseReviewAnnotationsMock).toHaveBeenCalledTimes(1);
    expect(getAdminAccountMembershipStatusMapMock).toHaveBeenCalledTimes(1);
  });

  it("aggregates admin-wide history into bounded time buckets", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (
        sql.includes(
          "SELECT events.category, COALESCE(SUM(events.bytes), 0) AS bytes",
        )
      ) {
        return {
          rows: [
            { category: "file-download", bytes: "200" },
            { category: "raw-network", bytes: "300" },
          ],
        };
      }
      if (sql.includes("GROUP BY 1, events.category")) {
        return {
          rows: [
            {
              bucket_start: "2026-04-28T10:00:00.000Z",
              category: "file-download",
              bytes: "75",
            },
            {
              bucket_start: "2026-04-28T10:00:00.000Z",
              category: "file-download",
              bytes: "125",
            },
            {
              bucket_start: "2026-04-28T11:00:00.000Z",
              category: "raw-network",
              bytes: "300",
            },
          ],
        };
      }
      if (
        sql.includes("accounts.email_address") &&
        sql.includes("GROUP BY") &&
        sql.includes("events.account_id") &&
        !sql.includes("projects.title AS project_title")
      ) {
        return {
          rows: [
            {
              account_id: "acct-1",
              email_address: "ada@example.com",
              display_name: "Ada Lovelace",
              first_name: "Ada",
              last_name: "Lovelace",
              banned: false,
              bytes: "450",
            },
          ],
        };
      }
      if (
        sql.includes("projects.title AS project_title") &&
        sql.includes("accounts.email_address")
      ) {
        return {
          rows: [
            {
              account_id: "acct-1",
              email_address: "ada@example.com",
              display_name: "Ada Lovelace",
              first_name: "Ada",
              last_name: "Lovelace",
              banned: false,
              project_id: "project-1",
              project_title: "Lite One",
              bytes: "450",
            },
          ],
        };
      }
      if (sql.includes("ORDER BY events.last_occurred_at DESC")) {
        return {
          rows: [
            {
              account_id: "acct-1",
              project_id: "project-1",
              project_title: "Lite One",
              category: "raw-network",
              bytes: "300",
              occurred_at: "2026-04-28T11:30:00.000Z",
              metadata: { interface_name: "ens4" },
            },
          ],
        };
      }
      throw new Error(`unhandled query: ${sql}`);
    });

    const { getManagedEgressAdminHistory } = await import("./managed-egress");
    const result = await getManagedEgressAdminHistory({
      start: "2026-04-28T10:15:00.000Z",
      end: "2026-04-28T12:15:00.000Z",
      bucket: "1h",
      recent_event_limit: 5,
      top_account_limit: 5,
      top_project_limit: 5,
    });

    expect(result.total_bytes).toBe(500);
    expect(result.categories_bytes).toEqual({
      "file-download": 200,
      "raw-network": 300,
    });
    expect(result.points).toHaveLength(3);
    expect(result.points[0]).toMatchObject({
      start: "2026-04-28T10:00:00.000Z",
      bytes: 200,
      categories_bytes: { "file-download": 200 },
    });
    expect(result.points[1]).toMatchObject({
      start: "2026-04-28T11:00:00.000Z",
      bytes: 300,
      categories_bytes: { "raw-network": 300 },
    });
    expect(result.points[2]).toMatchObject({
      start: "2026-04-28T12:00:00.000Z",
      bytes: 0,
      categories_bytes: {},
    });
    expect(result.top_accounts).toEqual([
      {
        account_id: "acct-1",
        email_address: "ada@example.com",
        display_name: "Ada Lovelace",
        first_name: "Ada",
        last_name: "Lovelace",
        banned: false,
        membership_class: "free",
        membership_label: "Free",
        membership_source: "free",
        bytes: 450,
        active_abuse_annotations: [],
      },
    ]);
    expect(result.top_projects).toEqual([
      {
        account_id: "acct-1",
        email_address: "ada@example.com",
        display_name: "Ada Lovelace",
        first_name: "Ada",
        last_name: "Lovelace",
        banned: false,
        membership_class: "free",
        membership_label: "Free",
        membership_source: "free",
        project_id: "project-1",
        project_title: "Lite One",
        bytes: 450,
        active_abuse_annotations: [],
      },
    ]);
    expect(result.recent_events).toEqual([
      {
        account_id: "acct-1",
        project_id: "project-1",
        project_title: "Lite One",
        category: "raw-network",
        bytes: 300,
        occurred_at: "2026-04-28T11:30:00.000Z",
        metadata: { interface_name: "ens4" },
      },
    ]);
  });
});
