/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();
const ensureUxLatencySchemaMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
}));

jest.mock("@cocalc/server/monitoring/ux-latency", () => ({
  ensureUxLatencySchema: (...args: any[]) => ensureUxLatencySchemaMock(...args),
}));

import {
  clearAdminRetentionOverviewCacheForTests,
  getAdminActiveUsersOverview,
  getAdminRetentionOverview,
} from "./retention-overview";

describe("admin retention overview", () => {
  beforeEach(() => {
    queryMock.mockReset();
    ensureUxLatencySchemaMock.mockReset();
    ensureUxLatencySchemaMock.mockResolvedValue(undefined);
    clearAdminRetentionOverviewCacheForTests();
  });

  it("maps browser project activity rows into cohort retention cells by default", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          cohort_start: "2026-06-20",
          cohort_end: "2026-06-21",
          cohort_size: "3",
          period_index: "0",
          period_start: "2026-06-20",
          period_end: "2026-06-21",
          complete: true,
          active_accounts: "2",
          rolling_active_accounts: "3",
        },
        {
          cohort_start: "2026-06-20",
          cohort_end: "2026-06-21",
          cohort_size: "3",
          period_index: "1",
          period_start: "2026-06-21",
          period_end: "2026-06-22",
          complete: false,
          active_accounts: "1",
          rolling_active_accounts: "1",
        },
      ],
    });

    const result = await getAdminRetentionOverview({
      start: new Date("2026-06-20T00:00:00Z"),
      end: new Date("2026-06-22T00:00:00Z"),
      unit: "day",
      period_count: 2,
      exclude_banned: true,
      opened_project_only: true,
    });

    expect(result).toMatchObject({
      unit: "day",
      period_count: 2,
      activity_signal: "browser-project-activity",
      exclude_banned: true,
      opened_project_only: true,
      cohorts: [
        {
          cohort_start: "2026-06-20",
          cohort_end: "2026-06-21",
          cohort_size: 3,
          periods: [
            {
              period_index: 0,
              active_accounts: 2,
              retention_pct: 66.7,
              rolling_active_accounts: 3,
              rolling_retention_pct: 100,
              complete: true,
            },
            {
              period_index: 1,
              active_accounts: 1,
              retention_pct: 33.3,
              rolling_active_accounts: 1,
              rolling_retention_pct: 33.3,
              complete: false,
            },
          ],
        },
      ],
    });
    expect(ensureUxLatencySchemaMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("ux_latency_events");
    expect(sql).toContain("project_start_running");
    expect(sql).toContain("account_project_index");
    expect(params).toEqual([
      new Date("2026-06-20T00:00:00Z"),
      new Date("2026-06-22T00:00:00Z"),
      true,
      true,
      2,
    ]);
  });

  it("can use managed CPU as an explicit alternate activity signal", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const result = await getAdminRetentionOverview({
      start: new Date("2026-06-20T00:00:00Z"),
      end: new Date("2026-06-22T00:00:00Z"),
      unit: "day",
      activity_signal: "managed-cpu",
      period_count: 2,
    });

    expect(result.activity_signal).toBe("managed-cpu");
    expect(ensureUxLatencySchemaMock).not.toHaveBeenCalled();
    expect(queryMock.mock.calls[0][0]).toContain("account_cpu_usage_events");
  });

  it("clamps weekly period counts", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const result = await getAdminRetentionOverview({
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-06-01T00:00:00Z"),
      unit: "week",
      period_count: 1000,
    });

    expect(result.period_count).toBe(26);
    expect(queryMock.mock.calls[0][1][4]).toBe(26);
  });

  it("maps active-user browser activity rows into buckets", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          start: "2026-06-20",
          end: "2026-06-21",
          active_accounts: "12",
        },
        {
          start: "2026-06-21",
          end: "2026-06-22",
          active_accounts: "5",
        },
      ],
    });

    const result = await getAdminActiveUsersOverview({
      start: new Date("2026-06-20T00:00:00Z"),
      end: new Date("2026-06-22T00:00:00Z"),
      bucket: "day",
      exclude_banned: true,
      opened_project_only: true,
    });

    expect(result).toMatchObject({
      bucket: "day",
      activity_signal: "browser-project-activity",
      exclude_banned: true,
      opened_project_only: true,
      points: [
        {
          start: "2026-06-20",
          end: "2026-06-21",
          active_accounts: 12,
        },
        {
          start: "2026-06-21",
          end: "2026-06-22",
          active_accounts: 5,
        },
      ],
    });
    expect(ensureUxLatencySchemaMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("generate_series");
    expect(sql).toContain("ux_latency_events");
    expect(sql).toContain("project_start_running");
    expect(sql).toContain("account_project_index");
    expect(params).toEqual([
      new Date("2026-06-20T00:00:00Z"),
      new Date("2026-06-22T00:00:00Z"),
      true,
      true,
    ]);
  });

  it("can use managed CPU for active-user buckets", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const result = await getAdminActiveUsersOverview({
      start: new Date("2026-06-20T00:00:00Z"),
      end: new Date("2026-06-22T00:00:00Z"),
      bucket: "hour",
      activity_signal: "managed-cpu",
    });

    expect(result.bucket).toBe("hour");
    expect(result.activity_signal).toBe("managed-cpu");
    expect(ensureUxLatencySchemaMock).not.toHaveBeenCalled();
    expect(queryMock.mock.calls[0][0]).toContain("account_cpu_usage_events");
    expect(queryMock.mock.calls[0][0]).toContain("1 hour");
  });
});
