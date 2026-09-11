/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Empty, Flex, Select, Space, Spin, Typography } from "antd";

import type {
  ActiveUserMapHistoryPoint,
  ActiveUserMapHistorySeries,
  ActiveUserMapHistoryWindowMinutes,
} from "@cocalc/conat/inter-bay/api";
import Plot from "@cocalc/frontend/components/plotly";
import { COLORS } from "@cocalc/util/theme";
import { activeUsersMapCountryName } from "./active-users-map-country";

const DAILY_COMPARISON_STEPS = 364;
const HOURLY_COMPARISON_STEPS = 28 * 24;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ALL_COUNTRIES = "all";

export interface ActiveUsersHistoryPlotPoint {
  actual_date: string;
  display_date: string;
  snapshot_hour: string | null;
  active_count: number | null;
}

export interface ActiveUsersHistoryPlotSeries {
  current: ActiveUsersHistoryPlotPoint[];
  previous: ActiveUsersHistoryPlotPoint[];
}

export function activeUsersHistoryTickStep(
  series: ActiveUsersHistoryPlotSeries,
  targetIntervals = 5,
): number {
  const maximum = Math.max(
    0,
    ...series.current.map(({ active_count }) => active_count ?? 0),
    ...series.previous.map(({ active_count }) => active_count ?? 0),
  );
  const roughStep = Math.max(1, maximum / targetIntervals);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const factor =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return Math.max(1, factor * magnitude);
}

function bucketDate(
  value: string | Date,
  activeMinutes: ActiveUserMapHistoryWindowMinutes,
): Date | undefined {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return;
  if (activeMinutes === 1440) {
    parsed.setUTCHours(0, 0, 0, 0);
  } else {
    parsed.setUTCMinutes(0, 0, 0);
  }
  return parsed;
}

function bucketKey(
  date: Date,
  activeMinutes: ActiveUserMapHistoryWindowMinutes,
): string {
  return activeMinutes === 1440
    ? date.toISOString().slice(0, 10)
    : date.toISOString();
}

export function buildActiveUsersHistoryPlotSeries(
  points: ActiveUserMapHistoryPoint[],
  activeMinutes: ActiveUserMapHistoryWindowMinutes = 1440,
): ActiveUsersHistoryPlotSeries {
  const stepMs = activeMinutes === 1440 ? DAY_MS : HOUR_MS;
  const comparisonSteps =
    activeMinutes === 1440 ? DAILY_COMPARISON_STEPS : HOURLY_COMPARISON_STEPS;
  const comparisonMs = comparisonSteps * stepMs;
  const byBucket = new Map<
    string,
    { bucket: Date; point: ActiveUserMapHistoryPoint }
  >();
  for (const point of points) {
    const bucket = bucketDate(point.snapshot_hour, activeMinutes);
    if (!bucket) continue;
    const key = bucketKey(bucket, activeMinutes);
    const current = byBucket.get(key);
    if (
      !current ||
      new Date(point.snapshot_hour).valueOf() >
        new Date(current.point.snapshot_hour).valueOf()
    ) {
      byBucket.set(key, { bucket, point });
    }
  }
  const available = [...byBucket.values()].sort(
    (a, b) => a.bucket.valueOf() - b.bucket.valueOf(),
  );
  if (!available.length) return { current: [], previous: [] };

  const latest = available[available.length - 1].bucket;
  const fullCurrentStart = new Date(
    latest.valueOf() - (comparisonSteps - 1) * stepMs,
  );
  const currentStart =
    available[0].bucket.valueOf() > fullCurrentStart.valueOf()
      ? available[0].bucket
      : fullCurrentStart;
  const current: ActiveUsersHistoryPlotPoint[] = [];
  const previous: ActiveUsersHistoryPlotPoint[] = [];
  for (
    let display = currentStart;
    display.valueOf() <= latest.valueOf();
    display = new Date(display.valueOf() + stepMs)
  ) {
    const display_date = bucketKey(display, activeMinutes);
    const currentEntry = byBucket.get(display_date)?.point;
    current.push({
      actual_date: display_date,
      display_date,
      snapshot_hour: currentEntry?.snapshot_hour ?? null,
      active_count: currentEntry?.active_count ?? null,
    });

    const previousDate = new Date(display.valueOf() - comparisonMs);
    const previous_date = bucketKey(previousDate, activeMinutes);
    const previousEntry = byBucket.get(previous_date)?.point;
    previous.push({
      actual_date: previous_date,
      display_date,
      snapshot_hour: previousEntry?.snapshot_hour ?? null,
      active_count: previousEntry?.active_count ?? null,
    });
  }
  return {
    current,
    previous: previous.some(({ active_count }) => active_count != null)
      ? previous
      : [],
  };
}

function plotMode(points: ActiveUsersHistoryPlotPoint[]): "lines" | "markers" {
  return points.filter(({ active_count }) => active_count != null).length > 1
    ? "lines"
    : "markers";
}

function traceData(points: ActiveUsersHistoryPlotPoint[]) {
  return {
    x: points.map(({ display_date }) => display_date),
    y: points.map(({ active_count }) => active_count),
    customdata: points.map(({ actual_date, snapshot_hour }) => [
      actual_date,
      snapshot_hour,
    ]),
  };
}

function selectedDisplayDate(
  series: ActiveUsersHistoryPlotSeries,
  activeMinutes: ActiveUserMapHistoryWindowMinutes,
  selectedSnapshotHour?: string,
): string | undefined {
  if (!selectedSnapshotHour) return;
  const selectedBucket = bucketDate(selectedSnapshotHour, activeMinutes);
  if (!selectedBucket) return;
  const selectedKey = bucketKey(selectedBucket, activeMinutes);
  return [...series.current, ...series.previous].find(
    ({ actual_date }) => actual_date === selectedKey,
  )?.display_date;
}

export function ActiveUsersMapHistoryPlot({
  history,
  loading,
  selectedCountryCode,
  selectedSnapshotHour,
  onCountryChange,
  onSelectSnapshot,
}: {
  history?: ActiveUserMapHistorySeries;
  loading: boolean;
  selectedCountryCode?: string;
  selectedSnapshotHour?: string;
  onCountryChange: (countryCode?: string) => void;
  onSelectSnapshot: (snapshotHour: string) => void;
}) {
  const activeMinutes = history?.active_minutes ?? 1440;
  const title =
    activeMinutes === 1440 ? "Daily active users" : "Hourly active users";
  const series = history
    ? buildActiveUsersHistoryPlotSeries(history.points, activeMinutes)
    : undefined;
  const selectedDate = series
    ? selectedDisplayDate(series, activeMinutes, selectedSnapshotHour)
    : undefined;
  const hasPrevious = (series?.previous.length ?? 0) > 0;
  const comparisonLabel = activeMinutes === 1440 ? "364 days" : "28 days";
  const yTickStep = series ? activeUsersHistoryTickStep(series) : 1;
  const countryOptions = [
    { label: "All the world", value: ALL_COUNTRIES },
    ...(history?.country_codes ?? []).map((countryCode) => ({
      label: activeUsersMapCountryName(countryCode),
      value: countryCode,
    })),
  ];

  return (
    <Space vertical style={{ width: "100%" }}>
      <Flex justify="space-between" align="center" wrap gap="small">
        <Space align="center" wrap>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          <Select
            showSearch
            optionFilterProp="label"
            options={countryOptions}
            value={selectedCountryCode ?? ALL_COUNTRIES}
            onChange={(value) =>
              onCountryChange(value === ALL_COUNTRIES ? undefined : value)
            }
            style={{ minWidth: 180 }}
          />
        </Space>
        <Typography.Text type="secondary">
          Select a time to view it on the map.
        </Typography.Text>
      </Flex>
      {!history ? (
        loading ? (
          <Spin />
        ) : null
      ) : !series?.current.length ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No active-user history has been recorded yet."
        />
      ) : (
        <Plot
          style={{ width: "100%" }}
          data={[
            {
              ...traceData(series.current),
              type: "scatter",
              mode: plotMode(series.current),
              connectgaps: false,
              line: { color: COLORS.CATEGORICAL[0], width: 3 },
              marker: { color: COLORS.CATEGORICAL[0] },
              name: hasPrevious ? `Latest ${comparisonLabel}` : "Active users",
              hovertemplate: "%{y:,}<extra>%{fullData.name}</extra>",
            },
            ...(hasPrevious
              ? [
                  {
                    ...traceData(series.previous),
                    type: "scatter" as const,
                    mode: plotMode(series.previous),
                    connectgaps: false,
                    line: { color: COLORS.CATEGORICAL[1], width: 2 },
                    marker: { color: COLORS.CATEGORICAL[1] },
                    name: `Previous ${comparisonLabel}`,
                    hovertemplate: "%{y:,}<extra>%{fullData.name}</extra>",
                  },
                ]
              : []),
          ]}
          layout={{
            height: 320,
            hovermode: "x unified",
            legend: {
              orientation: "h",
              x: 0,
              xanchor: "left",
              y: 1,
              yanchor: "top",
            },
            margin: { l: 20, r: 55, t: 20, b: 45 },
            shapes: selectedDate
              ? [
                  {
                    type: "line",
                    x0: selectedDate,
                    x1: selectedDate,
                    y0: 0,
                    y1: 1,
                    yref: "paper",
                    line: { color: COLORS.COCALC_ORANGE, width: 2 },
                  },
                ]
              : [],
            showlegend: hasPrevious,
            xaxis: {
              type: "date",
              hoverformat:
                activeMinutes === 1440
                  ? "%B %-d, %Y UTC"
                  : "%B %-d, %Y, %H:%M UTC",
            },
            yaxis: {
              dtick: yTickStep,
              rangemode: "tozero",
              side: "right",
              tickformat: ",d",
            },
          }}
          config={{ displayModeBar: false, responsive: true }}
          onClick={(event) => {
            const snapshotHour = event?.points?.[0]?.customdata?.[1];
            if (typeof snapshotHour === "string") {
              onSelectSnapshot(snapshotHour);
            }
          }}
        />
      )}
    </Space>
  );
}
