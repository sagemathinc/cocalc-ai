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
  AdminRetentionActivitySignal,
  AdminRetentionCohortUnit,
  AdminRetentionOverview,
  AdminRetentionPeriodCell,
} from "@cocalc/conat/hub/api/purchases";
import ShowError from "@cocalc/frontend/components/error";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { COLORS } from "@cocalc/util/theme";

const { Paragraph, Text } = Typography;

const DAY_MS = 24 * 60 * 60 * 1000;

function floorUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
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

export function RetentionAdminOverview() {
  const [unit, setUnit] = useState<AdminRetentionCohortUnit>("day");
  const [activitySignal, setActivitySignal] =
    useState<AdminRetentionActivitySignal>("browser-project-activity");
  const [excludeBanned, setExcludeBanned] = useState(true);
  const [openedProjectOnly, setOpenedProjectOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [overview, setOverview] = useState<AdminRetentionOverview | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const window = getDefaultWindow(unit);
      const result =
        (await webapp_client.conat_client.hub.purchases.getAdminRetentionOverview(
          {
            start: window.start,
            end: window.end,
            unit,
            activity_signal: activitySignal,
            period_count: window.period_count,
            exclude_banned: excludeBanned,
            opened_project_only: openedProjectOnly,
          },
        )) as AdminRetentionOverview;
      setOverview(result);
      setLoadedAt(new Date());
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }, [activitySignal, excludeBanned, openedProjectOnly, unit]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Signup cohort retention using browser-observed project activity as the
        default activity signal. This first version measures whether users came
        back and opened or used projects; it does not yet include passive
        browsing or course-specific cohorts.
      </Paragraph>
      <Space wrap>
        <Segmented
          value={unit}
          options={[
            { label: "Daily cohorts", value: "day" },
            { label: "Weekly cohorts", value: "week" },
          ]}
          onChange={(value) => setUnit(value as AdminRetentionCohortUnit)}
        />
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
          Cohort: only users who ever opened a project
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
        message="How to read this"
        description="Each cell shows exact activity for that period. The small 'later' number is the percent active in that period or any later displayed period, so it forms a non-increasing retention curve across the row. Current and future periods are marked incomplete. Managed CPU is useful as a compute-retention proxy, but can be inflated by long-running idle projects."
      />
      {error ? <ShowError error={error} /> : null}
      {loading && overview == null ? <Spin /> : null}
      {overview != null ? (
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
    </Space>
  );
}
