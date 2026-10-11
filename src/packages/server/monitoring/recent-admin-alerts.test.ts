/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const queryMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: (...args: any[]) => queryMock(...args),
  }),
  getCachedReadPool: () => ({
    query: (...args: any[]) => queryMock(...args),
  }),
}));

describe("recent admin alert summary", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock.mockReset();
  });

  it("returns a bounded count and timestamp/subject details", async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          subject: "Admin Alert - Project-host browser route failed: host-1",
          sent: "2026-07-17T07:06:00.000Z",
          total_count: 37,
        },
      ],
    });
    const {
      getRecentAdminAlertSummary,
      MAX_ADMIN_ALERT_WINDOW_HOURS,
      MAX_RECENT_ADMIN_ALERT_DETAILS,
    } = await import("./recent-admin-alerts");

    await expect(
      getRecentAdminAlertSummary({ windowHours: 100_000, limit: 100_000 }),
    ).resolves.toEqual({
      count: 37,
      alerts: [
        {
          sent_at: "2026-07-17T07:06:00.000Z",
          subject: "Admin Alert - Project-host browser route failed: host-1",
        },
      ],
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("subject LIKE 'Admin Alert - %'"),
      [MAX_ADMIN_ALERT_WINDOW_HOURS, MAX_RECENT_ADMIN_ALERT_DETAILS],
    );
  });

  it("reports an empty window without inventing alerts", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const { getRecentAdminAlertSummary } =
      await import("./recent-admin-alerts");
    await expect(getRecentAdminAlertSummary()).resolves.toEqual({
      count: 0,
      alerts: [],
    });
  });
});
