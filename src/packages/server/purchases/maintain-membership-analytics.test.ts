/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockPoolQuery = jest.fn();
const mockEnsureMembershipAnalyticsTables = jest.fn();
const mockSnapshotMembershipAnalyticsDailyCounts = jest.fn();
const mockBackfillMembershipAllocationFacts = jest.fn();
const mockProjectOutstandingMembershipAllocationFacts = jest.fn();

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

jest.mock("@cocalc/server/membership/allocation-analytics-backfill", () => ({
  backfillMembershipAllocationFacts: (...args: any[]) =>
    mockBackfillMembershipAllocationFacts(...args),
}));

jest.mock("@cocalc/server/membership/allocation-analytics", () => ({
  projectOutstandingMembershipAllocationFacts: (...args: any[]) =>
    mockProjectOutstandingMembershipAllocationFacts(...args),
}));

describe("maintainMembershipAnalytics", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers({ now: new Date("2026-07-01T17:20:00.000Z") });
    mockPoolQuery.mockReset();
    mockEnsureMembershipAnalyticsTables
      .mockReset()
      .mockResolvedValue(undefined);
    mockSnapshotMembershipAnalyticsDailyCounts.mockReset().mockResolvedValue(4);
    mockBackfillMembershipAllocationFacts.mockReset().mockResolvedValue({
      trials: 0,
      personal_purchases: 0,
      direct_student_purchases: 0,
      refunds: 0,
    });
    mockProjectOutstandingMembershipAllocationFacts
      .mockReset()
      .mockResolvedValue(0);
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
    expect(mockBackfillMembershipAllocationFacts).toHaveBeenCalledWith({
      limit: 250,
    });
    expect(
      mockProjectOutstandingMembershipAllocationFacts,
    ).toHaveBeenCalledWith({ limit: 1000 });
  });

  it("does not rewrite a daily count snapshot that already exists for this bay today", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });

    const maintainMembershipAnalytics = (
      await import("./maintain-membership-analytics")
    ).default;

    await maintainMembershipAnalytics();

    expect(mockSnapshotMembershipAnalyticsDailyCounts).not.toHaveBeenCalled();
    expect(mockBackfillMembershipAllocationFacts).toHaveBeenCalledWith({
      limit: 250,
    });
    expect(
      mockProjectOutstandingMembershipAllocationFacts,
    ).toHaveBeenCalledWith({ limit: 1000 });
  });

  it("rechecks an empty legacy backfill daily instead of every maintenance pass", async () => {
    mockPoolQuery.mockResolvedValue({ rowCount: 1 });

    const maintainMembershipAnalytics = (
      await import("./maintain-membership-analytics")
    ).default;

    await maintainMembershipAnalytics();
    await maintainMembershipAnalytics();

    expect(mockBackfillMembershipAllocationFacts).toHaveBeenCalledTimes(1);
    expect(
      mockProjectOutstandingMembershipAllocationFacts,
    ).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    await maintainMembershipAnalytics();

    expect(mockBackfillMembershipAllocationFacts).toHaveBeenCalledTimes(2);
  });

  it("continues draining a legacy backfill while it makes progress", async () => {
    mockPoolQuery.mockResolvedValue({ rowCount: 1 });
    mockBackfillMembershipAllocationFacts.mockResolvedValue({
      trials: 0,
      personal_purchases: 1,
      direct_student_purchases: 0,
      refunds: 0,
    });

    const maintainMembershipAnalytics = (
      await import("./maintain-membership-analytics")
    ).default;

    await maintainMembershipAnalytics();
    await maintainMembershipAnalytics();

    expect(mockBackfillMembershipAllocationFacts).toHaveBeenCalledTimes(2);
  });
});
