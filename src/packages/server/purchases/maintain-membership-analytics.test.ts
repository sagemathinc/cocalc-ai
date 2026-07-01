/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockPoolQuery = jest.fn();
const mockEnsureMembershipAnalyticsTables = jest.fn();
const mockSnapshotMembershipAnalyticsDailyCounts = jest.fn();

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  })),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => mockPoolQuery(...args) }),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-test",
}));

jest.mock("@cocalc/server/membership/analytics", () => ({
  ensureMembershipAnalyticsTables: (...args: any[]) =>
    mockEnsureMembershipAnalyticsTables(...args),
  snapshotMembershipAnalyticsDailyCounts: (...args: any[]) =>
    mockSnapshotMembershipAnalyticsDailyCounts(...args),
}));

describe("maintainMembershipAnalytics", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-07-01T17:20:00.000Z") });
    mockPoolQuery.mockReset();
    mockEnsureMembershipAnalyticsTables
      .mockReset()
      .mockResolvedValue(undefined);
    mockSnapshotMembershipAnalyticsDailyCounts.mockReset().mockResolvedValue(4);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("writes today's UTC daily count snapshot when the bay has no snapshot yet", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0 });

    const maintainMembershipAnalytics = (
      await import("./maintain-membership-analytics")
    ).default;

    await maintainMembershipAnalytics();

    expect(mockEnsureMembershipAnalyticsTables).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("membership_analytics_daily_counts"),
      ["2026-07-01", "bay-test"],
    );
    expect(mockSnapshotMembershipAnalyticsDailyCounts).toHaveBeenCalledWith({
      bay_id: "bay-test",
      snapshot_date: "2026-07-01",
    });
  });

  it("does not rewrite a daily count snapshot that already exists for this bay today", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });

    const maintainMembershipAnalytics = (
      await import("./maintain-membership-analytics")
    ).default;

    await maintainMembershipAnalytics();

    expect(mockSnapshotMembershipAnalyticsDailyCounts).not.toHaveBeenCalled();
  });
});
