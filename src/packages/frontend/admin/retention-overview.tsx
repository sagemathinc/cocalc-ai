/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import { useCallback, useEffect, useState } from "react";

import type {
  AdminActiveUsersBucket,
  AdminActiveUsersOverview,
  AdminRetentionActivitySignal,
  AdminRetentionCohortUnit,
  AdminRetentionOverview,
  AdminRetentionPeriodCell,
} from "@cocalc/conat/hub/api/purchases";
import ShowError from "@cocalc/frontend/components/error";
import Plot from "@cocalc/frontend/components/plotly";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { COLORS } from "@cocalc/util/theme";

const { Paragraph, Text } = Typography;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const RETENTION_PREFERENCES_STORAGE_KEY = "cocalc-admin-retention-preferences";

type RetentionMode = "cohort" | "active";
type RetentionPreferences = {
  excludeBanned: boolean;
  openedProjectOnly: boolean;
};

const DEFAULT_RETENTION_PREFERENCES: RetentionPreferences = {
  excludeBanned: true,
  openedProjectOnly: true,
};

function floorUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function floorUtcHour(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
    ),
  );
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function startOfUtcWeek(date: Date): Date {
  const day = floorUtcDay(date);
  const dayOfWeek = day.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  return addUtcDays(day, mondayOffset);
}

function readRetentionPreferences(): RetentionPreferences {
  if (typeof window === "undefined") {
    return DEFAULT_RETENTION_PREFERENCES;
  }
  try {
    const raw = window.localStorage.getItem(RETENTION_PREFERENCES_STORAGE_KEY);
    if (raw == null) return DEFAULT_RETENTION_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<RetentionPreferences>;
    return {
      excludeBanned:
        typeof parsed.excludeBanned === "boolean"
          ? parsed.excludeBanned
          : DEFAULT_RETENTION_PREFERENCES.excludeBanned,
      openedProjectOnly:
        typeof parsed.openedProjectOnly === "boolean"
          ? parsed.openedProjectOnly
          : DEFAULT_RETENTION_PREFERENCES.openedProjectOnly,
    };
  } catch {
    return DEFAULT_RETENTION_PREFERENCES;
  }
}

function writeRetentionPreferences(preferences: RetentionPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      RETENTION_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // Ignore private browsing and storage quota failures.
  }
}

function getDefaultPeriodCount(unit: AdminRetentionCohortUnit): number {
  return unit === "week" ? 12 : 14;
}

function getDefaultWindow(unit: AdminRetentionCohortUnit): {
  start: Date;
  end: Date;
  period_count: number;
} {
  const period_count = getDefaultPeriodCount(unit);
  if (unit === "week") {
    const end = addUtcDays(startOfUtcWeek(new Date()), 7);
    return { start: addUtcDays(end, -7 * period_count), end, period_count };
  }
  const end = addUtcDays(floorUtcDay(new Date()), 1);
  return {
    start: new Date(end.getTime() - period_count * DAY_MS),
    end,
    period_count,
  };
}

function getDefaultActiveWindow(bucket: AdminActiveUsersBucket): {
  start: Date;
  end: Date;
} {
  if (bucket === "hour") {
    const end = new Date(floorUtcHour(new Date()).getTime() + HOUR_MS);
    return { start: new Date(end.getTime() - 48 * HOUR_MS), end };
  }
  if (bucket === "week") {
    const end = addUtcDays(startOfUtcWeek(new Date()), 7);
    return { start: addUtcDays(end, -12 * 7), end };
  }
  const end = addUtcDays(floorUtcDay(new Date()), 1);
  return { start: addUtcDays(end, -30), end };
}

function formatCell(cell: AdminRetentionPeriodCell): string {
  if (!cell.complete) return "-";
  return `${cell.retention_pct.toFixed(1)}%`;
}

function getCellBackground(cell: AdminRetentionPeriodCell): string | undefined {
  if (!cell.complete) return COLORS.GRAY_LLL;
  if (cell.retention_pct >= 60) return COLORS.BS_GREEN_LL;
  if (cell.retention_pct >= 30) return COLORS.BLUE_LLLL;
  if (cell.retention_pct > 0) return COLORS.GRAY_LL;
  return undefined;
}

function PeriodCell({ cell }: { cell: AdminRetentionPeriodCell }) {
  return (
    <td
      title={`${cell.period_start} to ${cell.period_end}`}
      style={{
        background: getCellBackground(cell),
        border: `1px solid ${COLORS.GRAY_LL}`,
        minWidth: 86,
        padding: "6px 8px",
        textAlign: "right",
        verticalAlign: "top",
      }}
    >
      <Text strong={cell.complete}>{formatCell(cell)}</Text>
      {cell.complete ? (
        <div>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {cell.active_accounts} active
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>
            {cell.rolling_retention_pct.toFixed(1)}% later
          </Text>
        </div>
      ) : (
        <div>
          <Text type="secondary" style={{ fontSize: 11 }}>
            incomplete
          </Text>
        </div>
      )}
    </td>
  );
}

function RetentionTable({ overview }: { overview: AdminRetentionOverview }) {
  if (overview.cohorts.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No cohorts matched this window."
      />
    );
  }
  const labels = Array.from({ length: overview.period_count }, (_, i) =>
    overview.unit === "week" ? `W${i}` : `D${i}`,
  );
  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          borderCollapse: "collapse",
          fontSize: 13,
          minWidth: "100%",
        }}
      >
        <thead>
          <tr>
            <th
              style={{
                border: `1px solid ${COLORS.GRAY_LL}`,
                padding: "6px 8px",
                textAlign: "left",
                whiteSpace: "nowrap",
              }}
            >
              Cohort
            </th>
            <th
              style={{
                border: `1px solid ${COLORS.GRAY_LL}`,
                padding: "6px 8px",
                textAlign: "right",
              }}
            >
              Size
            </th>
            {labels.map((label) => (
              <th
                key={label}
                style={{
                  border: `1px solid ${COLORS.GRAY_LL}`,
                  padding: "6px 8px",
                  textAlign: "right",
                }}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {overview.cohorts.map((cohort) => (
            <tr key={cohort.cohort_start}>
              <td
                style={{
                  border: `1px solid ${COLORS.GRAY_LL}`,
                  padding: "6px 8px",
                  whiteSpace: "nowrap",
                }}
              >
                <Text strong>{cohort.cohort_start}</Text>
                {overview.unit === "week" ? (
                  <div>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      through {cohort.cohort_end}
                    </Text>
                  </div>
                ) : null}
              </td>
              <td
                style={{
                  border: `1px solid ${COLORS.GRAY_LL}`,
                  padding: "6px 8px",
                  textAlign: "right",
                }}
              >
                {cohort.cohort_size}
              </td>
              {cohort.periods.map((cell) => (
                <PeriodCell key={cell.period_index} cell={cell} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActiveUsersPlot({ overview }: { overview: AdminActiveUsersOverview }) {
  if (overview.points.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No active-user buckets matched this window."
      />
    );
  }
  const x = overview.points.map((point) => point.start);
  const y = overview.points.map((point) => point.active_accounts);
  return (
    <Plot
      style={{ width: "100%" }}
      data={[
        {
          x,
          y,
          type: "bar",
          marker: { color: COLORS.BLUE_L },
          name: "Active users",
        },
      ]}
      layout={{
        height: 360,
        margin: { l: 55, r: 20, t: 20, b: 60 },
        xaxis: { title: "Time" },
        yaxis: { title: "Active users" },
      }}
      config={{ responsive: true }}
    />
  );
}

export function RetentionAdminOverview() {
  const preferences = readRetentionPreferences();
  const [mode, setMode] = useState<RetentionMode>("cohort");
  const [unit, setUnit] = useState<AdminRetentionCohortUnit>("day");
  const [activeBucket, setActiveBucket] =
    useState<AdminActiveUsersBucket>("day");
  const [activitySignal, setActivitySignal] =
    useState<AdminRetentionActivitySignal>("browser-project-activity");
  const [excludeBanned, setExcludeBanned] = useState(preferences.excludeBanned);
  const [openedProjectOnly, setOpenedProjectOnly] = useState(
    preferences.openedProjectOnly,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [overview, setOverview] = useState<AdminRetentionOverview | null>(null);
  const [activeOverview, setActiveOverview] =
    useState<AdminActiveUsersOverview | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (mode === "active") {
        const activeWindow = getDefaultActiveWindow(activeBucket);
        const result =
          (await webapp_client.conat_client.hub.purchases.getAdminActiveUsersOverview(
            {
              start: activeWindow.start,
              end: activeWindow.end,
              bucket: activeBucket,
              activity_signal: activitySignal,
              exclude_banned: excludeBanned,
              opened_project_only: openedProjectOnly,
            },
          )) as AdminActiveUsersOverview;
        setActiveOverview(result);
      } else {
        const cohortWindow = getDefaultWindow(unit);
        const result =
          (await webapp_client.conat_client.hub.purchases.getAdminRetentionOverview(
            {
              start: cohortWindow.start,
              end: cohortWindow.end,
              unit,
              activity_signal: activitySignal,
              period_count: cohortWindow.period_count,
              exclude_banned: excludeBanned,
              opened_project_only: openedProjectOnly,
            },
          )) as AdminRetentionOverview;
        setOverview(result);
      }
      setLoadedAt(new Date());
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }, [
    activeBucket,
    activitySignal,
    excludeBanned,
    mode,
    openedProjectOnly,
    unit,
  ]);

  useEffect(() => {
    writeRetentionPreferences({ excludeBanned, openedProjectOnly });
  }, [excludeBanned, openedProjectOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const latestActiveCount =
    activeOverview?.points[activeOverview.points.length - 1]?.active_accounts;
  const maxActiveCount = activeOverview?.points.reduce(
    (max, point) => Math.max(max, point.active_accounts),
    0,
  );
  const loadedEmpty =
    loading &&
    ((mode === "cohort" && overview == null) ||
      (mode === "active" && activeOverview == null));

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Cohort mode shows accounts created each day or week and whether they
        came back later. Active mode shows how many distinct users were active
        in each hour, day, or week using the same selected activity signal and
        filters.
      </Paragraph>
      <Space wrap>
        <Segmented
          value={mode}
          options={[
            { label: "Cohort retention", value: "cohort" },
            { label: "Active users", value: "active" },
          ]}
          onChange={(value) => setMode(value as RetentionMode)}
        />
        {mode === "cohort" ? (
          <Segmented
            value={unit}
            options={[
              { label: "Daily cohorts", value: "day" },
              { label: "Weekly cohorts", value: "week" },
            ]}
            onChange={(value) => setUnit(value as AdminRetentionCohortUnit)}
          />
        ) : (
          <Segmented
            value={activeBucket}
            options={[
              { label: "Hourly active", value: "hour" },
              { label: "Daily active", value: "day" },
              { label: "Weekly active", value: "week" },
            ]}
            onChange={(value) =>
              setActiveBucket(value as AdminActiveUsersBucket)
            }
          />
        )}
        <Segmented
          value={activitySignal}
          options={[
            {
              label: "Browser project activity",
              value: "browser-project-activity",
            },
            { label: "Managed CPU", value: "managed-cpu" },
          ]}
          onChange={(value) =>
            setActivitySignal(value as AdminRetentionActivitySignal)
          }
        />
        <Checkbox
          checked={excludeBanned}
          onChange={(e) => setExcludeBanned(e.target.checked)}
        >
          Exclude banned accounts
        </Checkbox>
        <Checkbox
          checked={openedProjectOnly}
          onChange={(e) => setOpenedProjectOnly(e.target.checked)}
        >
          {mode === "cohort"
            ? "Cohort: only users who ever opened a project"
            : "Only users who ever opened a project"}
        </Checkbox>
        <Button onClick={load} loading={loading}>
          Refresh
        </Button>
        {loadedAt != null ? (
          <Text type="secondary">Loaded {loadedAt.toLocaleTimeString()}</Text>
        ) : null}
      </Space>
      <Alert
        type="info"
        showIcon
        message={mode === "cohort" ? "How to read this" : "Active-user count"}
        description={
          mode === "cohort"
            ? "Each cell shows exact activity for that period. The small 'later' number is the percent active in that period or any later displayed period, so it forms a non-increasing retention curve across the row. Current and future periods are marked incomplete. Managed CPU is useful as a compute-retention proxy, but can be inflated by long-running idle projects."
            : "Each bar counts distinct accounts active in that bucket using the selected signal. Browser project activity is the preferred product-engagement signal; managed CPU is useful as a compute-engagement proxy but can be inflated by long-running idle projects."
        }
      />
      {error ? <ShowError error={error} /> : null}
      {loadedEmpty ? <Spin /> : null}
      {mode === "cohort" && overview != null ? (
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Space wrap>
            <Tag>{overview.unit === "week" ? "Weekly" : "Daily"}</Tag>
            <Tag>{overview.activity_signal}</Tag>
            <Tag>{overview.cohorts.length} cohorts</Tag>
            <Text type="secondary">
              {new Date(overview.start).toISOString().slice(0, 10)} to{" "}
              {new Date(overview.end).toISOString().slice(0, 10)}
            </Text>
          </Space>
          <RetentionTable overview={overview} />
        </Space>
      ) : null}
      {mode === "active" && activeOverview != null ? (
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Space wrap>
            <Tag>{activeOverview.bucket} buckets</Tag>
            <Tag>{activeOverview.activity_signal}</Tag>
            <Tag>{activeOverview.points.length} points</Tag>
            {latestActiveCount != null ? (
              <Tag>{latestActiveCount} latest</Tag>
            ) : null}
            {maxActiveCount != null ? <Tag>{maxActiveCount} peak</Tag> : null}
            <Text type="secondary">
              {new Date(activeOverview.start).toISOString().slice(0, 10)} to{" "}
              {new Date(activeOverview.end).toISOString().slice(0, 10)}
            </Text>
          </Space>
          <ActiveUsersPlot overview={activeOverview} />
        </Space>
      ) : null}
    </Space>
  );
}
