/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Segmented,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from "antd";
import { useEffect, useState } from "react";

import type {
  GrowthActivitySignal,
  GrowthDashboard,
  GrowthRetentionCell,
} from "@cocalc/conat/hub/api/growth-analytics";
import ShowError from "@cocalc/frontend/components/error";
import Plot from "@cocalc/frontend/components/plotly";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { COLORS } from "@cocalc/util/theme";

const { Paragraph, Text, Title } = Typography;
const DAY_MS = 24 * 60 * 60 * 1000;
const RPC_TIMEOUT_MS = 5_000;

function defaultRange(): { start: string; end: string } {
  const now = new Date();
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return {
    start: new Date(end.getTime() - 90 * DAY_MS).toISOString(),
    end: end.toISOString(),
  };
}

function inclusiveUtcEnd(end: string): string {
  return new Date(new Date(end).getTime() - 1).toISOString().slice(0, 10);
}

function sumMetric(dashboard: GrowthDashboard, name: string): number {
  return (
    dashboard.summary.series
      .find(({ metric_name }) => metric_name === name)
      ?.points.reduce((sum, point) => sum + (point.value ?? 0), 0) ?? 0
  );
}

function latestMetric(dashboard: GrowthDashboard, name: string): number {
  const points = dashboard.summary.series.find(
    ({ metric_name }) => metric_name === name,
  )?.points;
  return points?.length ? (points[points.length - 1]?.value ?? 0) : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0
    ? Math.round((1000 * numerator) / denominator) / 10
    : 0;
}

function healthAlert(dashboard: GrowthDashboard) {
  const { health } = dashboard;
  const type =
    health.status === "healthy"
      ? "success"
      : health.status === "error"
        ? "error"
        : "warning";
  return (
    <Alert
      type={type}
      showIcon
      title={`Growth data: ${health.status}`}
      description={
        <Space wrap>
          <Text>Definition {health.metric_version}</Text>
          {health.coverage_start ? (
            <Text>Coverage begins {health.coverage_start.slice(0, 10)}</Text>
          ) : null}
          {health.last_success_at ? (
            <Text>
              Materialized {new Date(health.last_success_at).toLocaleString()}
            </Text>
          ) : null}
          <Text>{health.event_backlog_count} queued events</Text>
          <Text>{health.dirty_period_count} periods awaiting repair</Text>
          {health.last_error ? (
            <Text type="danger">{health.last_error}</Text>
          ) : null}
        </Space>
      }
    />
  );
}

function HeadlineCards({ dashboard }: { dashboard: GrowthDashboard }) {
  const signups = sumMetric(dashboard, "eligible_signups");
  const verified = sumMetric(dashboard, "verified_accounts");
  const activated = sumMetric(dashboard, "activated_24h");
  const active = latestMetric(dashboard, dashboard.summary.activity_signal);
  return (
    <Row gutter={[12, 12]}>
      <Col xs={12} lg={6}>
        <Card size="small">
          <Statistic title="Eligible signups (range total)" value={signups} />
        </Card>
      </Col>
      <Col xs={12} lg={6}>
        <Card size="small">
          <Statistic
            title="Verified signups (range)"
            value={ratio(verified, signups)}
            suffix="%"
          />
        </Card>
      </Col>
      <Col xs={12} lg={6}>
        <Card size="small">
          <Statistic
            title="Activated in 24h (range)"
            value={ratio(activated, signups)}
            suffix="%"
          />
        </Card>
      </Col>
      <Col xs={12} lg={6}>
        <Card size="small">
          <Statistic title="Latest UTC-day active" value={active} />
        </Card>
      </Col>
    </Row>
  );
}

function ActivePlot({ dashboard }: { dashboard: GrowthDashboard }) {
  const series = dashboard.summary.series.find(
    ({ metric_name }) => metric_name === dashboard.summary.activity_signal,
  );
  if (!series?.points.length) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Canonical activity collection has no points in this range yet."
      />
    );
  }
  return (
    <Plot
      style={{ width: "100%" }}
      data={[
        {
          x: series.points.map(({ period_start }) => period_start),
          y: series.points.map(({ value }) => value),
          type: "scatter",
          mode: "lines+markers",
          connectgaps: false,
          line: { color: COLORS.BLUE_D, width: 2 },
          marker: { color: COLORS.BLUE_D },
          name: series.label,
        },
      ]}
      layout={{
        height: 330,
        margin: { l: 55, r: 20, t: 20, b: 50 },
        xaxis: { title: "UTC day" },
        yaxis: { title: "Distinct eligible accounts", rangemode: "tozero" },
      }}
      config={{ responsive: true }}
    />
  );
}

function Funnel({ dashboard }: { dashboard: GrowthDashboard }) {
  return (
    <Table
      size="small"
      pagination={false}
      rowKey="milestone"
      dataSource={dashboard.funnel.steps}
      columns={[
        { title: "Step", dataIndex: "label" },
        {
          title: "Accounts",
          dataIndex: "accounts",
          align: "right" as const,
        },
        {
          title: "From prior",
          dataIndex: "conversion_from_previous_pct",
          align: "right" as const,
          render: (value: number | null) =>
            value == null ? "-" : `${value.toFixed(1)}%`,
        },
        {
          title: "From signup",
          dataIndex: "conversion_from_created_pct",
          align: "right" as const,
          render: (value: number | null) =>
            value == null ? "-" : `${value.toFixed(1)}%`,
        },
      ]}
    />
  );
}

function retentionColor(cell: GrowthRetentionCell): string | undefined {
  if (!cell.complete) return COLORS.GRAY_LLL;
  const value = cell.exact_retention_pct ?? 0;
  if (value >= 50) return COLORS.BS_GREEN_LL;
  if (value >= 20) return COLORS.BLUE_LLLL;
  return value > 0 ? COLORS.GRAY_LL : undefined;
}

function RetentionMatrix({ dashboard }: { dashboard: GrowthDashboard }) {
  if (!dashboard.retention.cohorts.length) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No mature canonical retention cohorts exist yet."
      />
    );
  }
  const periodCount = Math.max(
    ...dashboard.retention.cohorts.map(({ cells }) => cells.length),
  );
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", minWidth: "100%" }}>
        <thead>
          <tr>
            <th style={{ padding: 6, textAlign: "left" }}>
              UTC {dashboard.retention.cohort_grain} cohort start
            </th>
            <th style={{ padding: 6, textAlign: "right" }}>Size</th>
            {Array.from({ length: periodCount }, (_, index) => (
              <th key={index} style={{ padding: 6, textAlign: "right" }}>
                {dashboard.retention.cohort_grain === "week" ? "W" : "D"}
                {index}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dashboard.retention.cohorts.map((cohort) => (
            <tr key={cohort.cohort_start}>
              <td style={{ border: `1px solid ${COLORS.GRAY_LL}`, padding: 6 }}>
                {cohort.cohort_start}
              </td>
              <td
                style={{
                  border: `1px solid ${COLORS.GRAY_LL}`,
                  padding: 6,
                  textAlign: "right",
                }}
              >
                {cohort.cells[0]?.cohort_size ?? 0}
              </td>
              {cohort.cells.map((cell) => (
                <td
                  key={cell.period_index}
                  title={
                    cell.complete
                      ? `${cell.exact_active_accounts} exact; ${cell.rolling_active_accounts} active in this or a later observed period`
                      : "Incomplete period"
                  }
                  style={{
                    background: retentionColor(cell),
                    border: `1px solid ${COLORS.GRAY_LL}`,
                    minWidth: 74,
                    padding: 6,
                    textAlign: "right",
                  }}
                >
                  {cell.complete && cell.exact_retention_pct != null
                    ? `${cell.exact_retention_pct.toFixed(1)}%`
                    : "-"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WeeklyAccounting({ dashboard }: { dashboard: GrowthDashboard }) {
  return (
    <Table
      size="small"
      pagination={false}
      rowKey="week_start"
      dataSource={dashboard.weekly.points.slice(-12)}
      columns={[
        { title: "UTC week", dataIndex: "week_start" },
        { title: "New", dataIndex: "new_accounts", align: "right" as const },
        {
          title: "Retained",
          dataIndex: "retained_accounts",
          align: "right" as const,
        },
        {
          title: "Resurrected",
          dataIndex: "resurrected_accounts",
          align: "right" as const,
        },
        {
          title: "Churned",
          dataIndex: "churned_accounts",
          align: "right" as const,
        },
        {
          title: "Net",
          dataIndex: "net_growth",
          align: "right" as const,
        },
      ]}
      locale={{ emptyText: "No complete canonical activity weeks yet." }}
    />
  );
}

export function RetentionAdminOverview() {
  const [signal, setSignal] =
    useState<GrowthActivitySignal>("project_engaged_v1");
  const [grain, setGrain] = useState<"day" | "week">("week");
  const [dashboard, setDashboard] = useState<GrowthDashboard>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const range = defaultRange();
      const next =
        await webapp_client.conat_client.hub.growthAnalytics.getGrowthDashboard(
          {
            ...range,
            activity_signal: signal,
            cohort_grain: grain,
            timeout: RPC_TIMEOUT_MS,
          } as any,
        );
      setDashboard(next);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [signal, grain]);

  return (
    <Space vertical size={16} style={{ width: "100%" }}>
      <Space wrap style={{ justifyContent: "space-between", width: "100%" }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            Growth and retention
          </Title>
          <Paragraph type="secondary" style={{ margin: 0 }}>
            Canonical, account-home activity facts. No chart on this page scans
            raw telemetry or account history.
          </Paragraph>
        </div>
        <Space wrap>
          <Segmented
            value={signal}
            options={[
              { label: "Project engaged", value: "project_engaged_v1" },
              { label: "Meaningful work", value: "project_work_v1" },
              { label: "App foreground", value: "app_foreground_v1" },
              { label: "AI engaged", value: "ai_engaged_v1" },
              {
                label: "Self-directed work",
                value: "self_directed_work_v1",
              },
            ]}
            onChange={(value) => setSignal(value as GrowthActivitySignal)}
          />
          <Segmented
            value={grain}
            options={[
              { label: "Daily cohorts", value: "day" },
              { label: "Weekly cohorts", value: "week" },
            ]}
            onChange={(value) => setGrain(value as "day" | "week")}
          />
          <Button onClick={() => void load()} loading={loading}>
            Refresh
          </Button>
        </Space>
      </Space>
      {error ? <ShowError error={error} /> : null}
      {loading && !dashboard ? <Spin /> : null}
      {dashboard ? (
        <>
          {healthAlert(dashboard)}
          <Space wrap>
            <Tag>{dashboard.summary.metric_version}</Tag>
            <Tag>{dashboard.summary.activity_signal}</Tag>
            <Tag>UTC calendar periods</Tag>
            <Tag>
              Range total {dashboard.summary.start.slice(0, 10)} through{" "}
              {inclusiveUtcEnd(dashboard.summary.end)}
            </Tag>
            {grain === "week" ? (
              <Tag>Weekly cohorts are labeled by Monday start</Tag>
            ) : null}
            <Text type="secondary">
              Current periods are partial; unavailable history is not filled
              with zeroes.
            </Text>
          </Space>
          <HeadlineCards dashboard={dashboard} />
          <Card title="Daily active eligible accounts">
            <ActivePlot dashboard={dashboard} />
          </Card>
          <Row gutter={[16, 16]}>
            <Col xs={24} xl={12}>
              <Card title="New-account activation funnel">
                <Funnel dashboard={dashboard} />
              </Card>
            </Col>
            <Col xs={24} xl={12}>
              <Card title="Weekly active growth accounting">
                <WeeklyAccounting dashboard={dashboard} />
              </Card>
            </Col>
          </Row>
          <Card
            title="Exact-period retention"
            extra={<Text type="secondary">Rolling values are in tooltips</Text>}
          >
            <RetentionMatrix dashboard={dashboard} />
          </Card>
        </>
      ) : null}
    </Space>
  );
}
