import type { ActiveUserMapHistoryPoint } from "@cocalc/conat/inter-bay/api";
import {
  activeUsersHistoryTickStep,
  buildActiveUsersHistoryPlotSeries,
} from "./active-users-map-history-plot";

function point(
  snapshot_hour: string,
  total_active: number,
): ActiveUserMapHistoryPoint {
  return {
    snapshot_hour,
    captured_at: snapshot_hour,
    total_active,
    mapped_active: total_active,
    unknown_location: 0,
    usage_metrics_not_enabled: 0,
    bay_count: 1,
    active_count: total_active,
  };
}

describe("buildActiveUsersHistoryPlotSeries", () => {
  it("shows all available days before a full comparison period exists", () => {
    const result = buildActiveUsersHistoryPlotSeries([
      point("2026-08-01T23:00:00.000Z", 10),
      point("2026-08-03T23:00:00.000Z", 12),
    ]);

    expect(result.current).toEqual([
      {
        actual_date: "2026-08-01",
        display_date: "2026-08-01",
        snapshot_hour: "2026-08-01T23:00:00.000Z",
        active_count: 10,
      },
      {
        actual_date: "2026-08-02",
        display_date: "2026-08-02",
        snapshot_hour: null,
        active_count: null,
      },
      {
        actual_date: "2026-08-03",
        display_date: "2026-08-03",
        snapshot_hour: "2026-08-03T23:00:00.000Z",
        active_count: 12,
      },
    ]);
    expect(result.previous).toEqual([]);
  });

  it("aligns the preceding period by 364 days", () => {
    const result = buildActiveUsersHistoryPlotSeries([
      point("2025-08-08T23:00:00.000Z", 8),
      point("2026-08-07T23:00:00.000Z", 15),
    ]);

    expect(result.current.at(-1)).toMatchObject({
      actual_date: "2026-08-07",
      display_date: "2026-08-07",
      active_count: 15,
    });
    expect(result.previous.at(-1)).toEqual({
      actual_date: "2025-08-08",
      display_date: "2026-08-07",
      snapshot_hour: "2025-08-08T23:00:00.000Z",
      active_count: 8,
    });
  });

  it("aligns hourly history by four weeks", () => {
    const result = buildActiveUsersHistoryPlotSeries(
      [
        point("2026-07-10T14:00:00.000Z", 6),
        point("2026-08-07T14:00:00.000Z", 14),
      ],
      60,
    );

    expect(result.current.at(-1)).toMatchObject({
      actual_date: "2026-08-07T14:00:00.000Z",
      active_count: 14,
    });
    expect(result.previous.at(-1)).toEqual({
      actual_date: "2026-07-10T14:00:00.000Z",
      display_date: "2026-08-07T14:00:00.000Z",
      snapshot_hour: "2026-07-10T14:00:00.000Z",
      active_count: 6,
    });
  });
});

describe("activeUsersHistoryTickStep", () => {
  function series(
    current: Array<number | null>,
    previous: Array<number | null> = [],
  ) {
    const points = (counts: Array<number | null>) =>
      counts.map((active_count, index) => ({
        actual_date: `2026-08-${index + 1}`,
        display_date: `2026-08-${index + 1}`,
        snapshot_hour: null,
        active_count,
      }));
    return { current: points(current), previous: points(previous) };
  }

  it("never selects a fractional user interval", () => {
    expect(activeUsersHistoryTickStep(series([0, 1]))).toBe(1);
  });

  it("selects a readable integer interval for larger counts", () => {
    expect(activeUsersHistoryTickStep(series([2, 8]))).toBe(2);
    expect(activeUsersHistoryTickStep(series([2], [3_400]))).toBe(1_000);
  });
});
