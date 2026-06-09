/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import {
  Alert,
  Card,
  Col,
  Popover,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Typography,
} from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  UxLatencyMetricSummary,
  UxLatencyRecentEvent,
  UxLatencySummary,
} from "@cocalc/conat/hub/api/system";
import { ADMIN_UX_LATENCY_ALERTS_ENABLED_KEY } from "@cocalc/util/admin-alerts";

const { Text } = Typography;

const WINDOW_OPTIONS = [
  { label: "Last hour", value: 60 },
  { label: "Last 6 hours", value: 6 * 60 },
  { label: "Last 24 hours", value: 24 * 60 },
];

function windowLabel(minutes: number): string {
  return (
    WINDOW_OPTIONS.find((option) => option.value === minutes)?.label ??
    `Last ${minutes} minutes`
  );
}

function formatMs(value?: number): string {
  const ms = Math.max(0, Math.round(Number(value) || 0));
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function metricLabel(metric: string): string {
  switch (metric) {
    case "project_start_running":
      return "Project lifecycle to running";
    case "project_start_running_timeout":
      return "Project start timeout";
    case "project_start_request_failed":
      return "Project start request failed";
    case "file_open_visible":
      return "File open to visible";
    case "file_open_sync_ready":
      return "File open to sync ready";
    case "project_exec_ready":
      return "Project exec ready";
    case "project_jupyter_ready":
      return "Project Jupyter ready";
    case "project_terminal_ready":
      return "Project terminal ready";
    default:
      return metric.replace(/_/g, " ");
  }
}

function summaryValue(
  summary: UxLatencySummary | undefined,
  metric: string,
  field: keyof Pick<UxLatencyMetricSummary, "p50_ms" | "p95_ms" | "p99_ms">,
): string {
  const row = summary?.metrics.find((x) => x.metric === metric);
  return row ? formatMs(row[field]) : "n/a";
}

export const UsageStatistics: React.FC = () => {
  const [windowMinutes, setWindowMinutes] = useState(24 * 60);
  const [summary, setSummary] = useState<UxLatencySummary>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const otherSettings = useTypedRedux("account", "other_settings");
  const alertsEnabled =
    otherSettings?.get?.(ADMIN_UX_LATENCY_ALERTS_ENABLED_KEY) !== false;

  useEffect(() => {
    let canceled = false;
    const load = async () => {
      setLoading(true);
      setError(undefined);
      try {
        const next =
          await webapp_client.conat_client.hub.system.getUxLatencySummary({
            window_minutes: windowMinutes,
          });
        if (!canceled) {
          setSummary(next);
        }
      } catch (err) {
        if (!canceled) {
          setError(`${err}`);
        }
      } finally {
        if (!canceled) {
          setLoading(false);
        }
      }
    };
    void load();
    const interval = setInterval(() => void load(), 60_000);
    return () => {
      canceled = true;
      clearInterval(interval);
    };
  }, [windowMinutes]);

  const metricColumns = [
    {
      title: "Metric",
      dataIndex: "metric",
      key: "metric",
      render: (metric: string, row: UxLatencyMetricSummary) => (
        <div>
          <div>{metricLabel(metric)}</div>
          {row.segment ? <small>{row.segment}</small> : null}
        </div>
      ),
    },
    {
      title: "Count",
      dataIndex: "count",
      key: "count",
      align: "right" as const,
    },
    {
      title: "Avg",
      dataIndex: "avg_ms",
      key: "avg_ms",
      align: "right" as const,
      render: formatMs,
    },
    {
      title: "P50",
      dataIndex: "p50_ms",
      key: "p50_ms",
      align: "right" as const,
      render: formatMs,
    },
    {
      title: "P95",
      dataIndex: "p95_ms",
      key: "p95_ms",
      align: "right" as const,
      render: formatMs,
    },
    {
      title: "P99",
      dataIndex: "p99_ms",
      key: "p99_ms",
      align: "right" as const,
      render: formatMs,
    },
    {
      title: "Max",
      dataIndex: "max_ms",
      key: "max_ms",
      align: "right" as const,
      render: formatMs,
    },
  ];

  const recentColumns = [
    {
      title: "When",
      dataIndex: "received_at",
      key: "received_at",
      render: (value: string) => new Date(value).toLocaleString(),
    },
    {
      title: "Metric",
      dataIndex: "metric",
      key: "metric",
      render: metricLabel,
    },
    { title: "Segment", dataIndex: "segment", key: "segment" },
    {
      title: "Duration",
      dataIndex: "duration_ms",
      key: "duration_ms",
      align: "right" as const,
      render: formatMs,
    },
    { title: "Ext", dataIndex: "path_ext", key: "path_ext" },
  ];

  const metricRows = summary?.metrics ?? [];
  const segmentRows = summary?.segments ?? [];
  const recentRows = summary?.recent_slow_events ?? [];
  const activeWindowLabel = windowLabel(windowMinutes).toLowerCase();

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title="User Latency"
        extra={
          <Space wrap>
            <Space>
              <Text type="secondary">My alerts</Text>
              <Popover
                title="Admin alert preference"
                content={
                  <div style={{ maxWidth: 320 }}>
                    The My alerts switch only controls whether this admin
                    account receives UX latency admin alerts. It does not
                    disable monitoring or alerts for other admins.
                  </div>
                }
              >
                <Text type="secondary" style={{ cursor: "help" }}>
                  <Icon name="info-circle" />
                </Text>
              </Popover>
              <Switch
                checked={alertsEnabled}
                onChange={(checked) =>
                  redux
                    .getActions("account")
                    .set_other_settings(
                      ADMIN_UX_LATENCY_ALERTS_ENABLED_KEY,
                      checked,
                    )
                }
              />
            </Space>
            <Select
              options={WINDOW_OPTIONS}
              value={windowMinutes}
              onChange={setWindowMinutes}
              style={{ minWidth: 150 }}
            />
          </Space>
        }
      >
        {error ? (
          <Alert
            type="error"
            showIcon
            message="Unable to load UX latency"
            description={error}
          />
        ) : null}
        <Spin spinning={loading && !summary}>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={8}>
              <Statistic
                title={`Lifecycle running P50 (${activeWindowLabel})`}
                value={summaryValue(summary, "project_start_running", "p50_ms")}
              />
            </Col>
            <Col xs={24} md={8}>
              <Statistic
                title={`File visible P95 (${activeWindowLabel})`}
                value={summaryValue(summary, "file_open_visible", "p95_ms")}
              />
            </Col>
            <Col xs={24} md={8}>
              <Statistic
                title={`File sync-ready P95 (${activeWindowLabel})`}
                value={summaryValue(summary, "file_open_sync_ready", "p95_ms")}
              />
            </Col>
          </Row>
        </Spin>
      </Card>

      <Card title="Latency Metrics">
        <Table<UxLatencyMetricSummary>
          columns={metricColumns}
          dataSource={metricRows}
          rowKey={(row) => `${row.metric}:${row.segment ?? "all"}`}
          pagination={false}
          size="small"
        />
      </Card>

      <Card title="Latency By Segment">
        <Table<UxLatencyMetricSummary>
          columns={metricColumns}
          dataSource={segmentRows}
          rowKey={(row) => `${row.metric}:${row.segment ?? "all"}`}
          pagination={{ pageSize: 20 }}
          size="small"
        />
      </Card>

      <Card title="Slowest Recent Events">
        <Table<UxLatencyRecentEvent>
          columns={recentColumns}
          dataSource={recentRows}
          rowKey={(row, index) =>
            `${row.received_at}:${row.metric}:${row.duration_ms}:${index}`
          }
          pagination={{ pageSize: 10 }}
          size="small"
        />
      </Card>
    </Space>
  );
};
