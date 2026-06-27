/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
}));

import {
  clearAdminRetentionOverviewCacheForTests,
  getAdminRetentionOverview,
} from "./retention-overview";

describe("admin retention overview", () => {
  beforeEach(() => {
    queryMock.mockReset();
    clearAdminRetentionOverviewCacheForTests();
  });

  it("maps managed CPU activity rows into cohort retention cells", async () => {
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
      activity_signal: "managed-cpu",
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
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("account_cpu_usage_events");
    expect(sql).toContain("account_project_index");
    expect(params).toEqual([
      new Date("2026-06-20T00:00:00Z"),
      new Date("2026-06-22T00:00:00Z"),
      true,
      true,
      2,
    ]);
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
});
