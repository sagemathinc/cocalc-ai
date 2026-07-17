/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import {
  Alert,
  Card,
  Col,
  Input,
  Popover,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from "antd";
import { Icon } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  AcpAdmissionDenialReport,
  AcpAdmissionDenialSummary,
  LaunchHealthCheck,
  LaunchHealthLevel,
  LaunchHealthStatus,
  ServiceAdmissionDenialReport,
  ServiceAdmissionDenialSummary,
  UxLatencyMetricSummary,
  UxLatencyRecentEvent,
  UxLatencySummary,
} from "@cocalc/conat/hub/api/system";

const { Text } = Typography;

const WINDOW_OPTIONS = [
  { label: "Last 15 minutes", value: 15 },
  { label: "Last hour", value: 60 },
  { label: "Last 6 hours", value: 6 * 60 },
  { label: "Last 24 hours", value: 24 * 60 },
  { label: "Last 7 days", value: 7 * 24 * 60 },
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

function formatCount(value?: number | null): string {
  return value == null ? "n/a" : `${value}`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function formatSpan(first: string, last: string): string {
  const duration = Math.max(0, Date.parse(last) - Date.parse(first));
  if (duration < 1000) return `${duration} ms`;
  if (duration < 60_000) return `${(duration / 1000).toFixed(1)} s`;
  return `${(duration / 60_000).toFixed(1)} min`;
}

function matchesSearch(row: object, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return Object.values(row).some((value) =>
    `${value ?? ""}`.toLowerCase().includes(query),
  );
}

function sumCounts(rows: Array<{ count: number }>): number {
  return rows.reduce((total, row) => total + row.count, 0);
}

function distinctCount(
  rows: Array<{ account_id: string | null; project_id: string | null }>,
  key: "account_id" | "project_id",
): number {
  return new Set(rows.map((row) => row[key]).filter(Boolean)).size;
}

function Scope({
  account_id,
  project_id,
  host_id,
}: {
  account_id: string | null;
  project_id: string | null;
  host_id?: string | null;
}): React.JSX.Element {
  const values = [
    account_id ? `account ${account_id}` : undefined,
    project_id ? `project ${project_id}` : undefined,
    host_id ? `host ${host_id}` : undefined,
  ].filter((value): value is string => value != null);
  return values.length ? (
    <Space direction="vertical" size={0}>
      {values.map((value) => (
        <Text key={value} code copyable={{ text: value.split(" ")[1] }}>
          {value}
        </Text>
      ))}
    </Space>
  ) : (
    <Text type="secondary">global</Text>
  );
}

function healthColor(level: LaunchHealthLevel): string {
  switch (level) {
    case "healthy":
      return "green";
    case "warning":
      return "orange";
    case "critical":
      return "red";
    default:
      return "default";
  }
}

function metricLabel(metric: string): string {
  switch (metric) {
    case "project_start_running":
      return "Project lifecycle to running";
    case "project_start_running_stuck":
      return "Project start appears stuck";
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

function metricHelp(metric: string, segment?: string): string {
  if (segment === "project_restore") {
    return "Observed in the user's browser. This segment starts from a project that is archived or not provisioned, so it can include backup restore, rootfs restore, or other storage preparation and can legitimately be much slower than a normal start.";
  }
  if (segment === "warm_provisioned") {
    return "Observed in the user's browser. This segment is for a project that already has an assigned host and provisioned project storage/rootfs, so it is the quick-start path admins should watch closely.";
  }
  if (segment === "host_start_or_unknown") {
    return "Observed in the user's browser. This segment is for starts where the frontend could not classify the project as already provisioned on a host; it may include placement, host startup, or stale frontend state.";
  }
  if (segment === "restore_autostart") {
    return "Observed in the user's browser. This readiness action began while the project was archived or not provisioned, so the duration can include dearchive, project storage restore, rootfs restore, and then the terminal/Jupyter/exec readiness work.";
  }
  if (segment === "autostart") {
    return "Observed in the user's browser. This readiness action began while the project was stopped and includes automatic project start plus the terminal/Jupyter/exec readiness work.";
  }
  if (segment === "already_starting") {
    return "Observed in the user's browser. This readiness action began while the project was already starting, so the duration includes the remaining start time plus the terminal/Jupyter/exec readiness work.";
  }
  if (segment === "warm") {
    return "Observed in the user's browser. This readiness action began while the project was already running, so it should not include project lifecycle start time.";
  }
  if (segment === "unknown") {
    return "Observed in the user's browser. The frontend could not classify the project state when the action began, so treat this row as diagnostic rather than a clean warm or cold-start measurement.";
  }
  if (metric === "project_jupyter_ready") {
    if (segment === "warm") {
      return "Observed in the user's browser from Run Cell until the Jupyter run request is accepted, with the project already running at the start of the action.";
    }
    if (segment === "already_starting") {
      return "Observed in the user's browser from Run Cell until the Jupyter run request is accepted, with the project already starting at the start of the action.";
    }
    if (segment === "autostart") {
      return "Observed in the user's browser from Run Cell until the Jupyter run request is accepted, including automatic project start because the project was stopped.";
    }
  }

  switch (metric) {
    case "project_start_running":
      return "Observed in the user's browser from pressing Start, or an automatic start request, until the project lifecycle state is running. This means the container/lifecycle is running; terminal, Jupyter, and exec readiness are measured separately. The aggregate row includes restore/dearchive cases; use the segment rows to separate them.";
    case "project_start_running_stuck":
      return "Observed in the user's browser when a project start request has not reached lifecycle state running after the user-visible stuck threshold. This is meant to catch starts that look stuck to users before the hard monitoring timeout.";
    case "project_start_running_timeout":
      return "Observed in the user's browser when a project start request did not reach lifecycle state running before the monitoring timeout.";
    case "project_start_request_failed":
      return "Observed in the user's browser when the project start request itself failed before the project could begin starting.";
    case "file_open_visible":
      return "Observed in the user's browser from initiating a file open until the file is visibly rendered in the editor.";
    case "file_open_sync_ready":
      return "Observed in the user's browser from initiating a file open until the file sync session is connected and ready.";
    case "project_exec_ready":
      return "Observed in the user's browser from an action that runs code in the project, such as LaTeX compilation or exec, until the project exec request is accepted by the running project. If the project was stopped, this includes automatic start time.";
    case "project_jupyter_ready":
      return "Observed in the user's browser from Run Cell until the Jupyter run request is accepted by the project. If the project was stopped, the autostart segment includes project start and Jupyter client/kernel setup time.";
    case "project_terminal_ready":
      return "Observed in the user's browser from connecting to a terminal until the terminal session is spawned and ready for input. If the project was stopped, this includes automatic start time.";
    default:
      return "Observed in the user's browser as user-visible latency for this action.";
  }
}

function LabelWithHelp({
  label,
  help,
}: {
  label: string;
  help: string;
}): React.JSX.Element {
  return (
    <Space size={4}>
      <span>{label}</span>
      <Popover content={<div style={{ maxWidth: 360 }}>{help}</div>}>
        <Text type="secondary" style={{ cursor: "help" }}>
          <Icon name="question-circle" />
        </Text>
      </Popover>
    </Space>
  );
}

function summaryValue(
  summary: UxLatencySummary | undefined,
  metric: string,
  field: keyof Pick<UxLatencyMetricSummary, "p50_ms" | "p95_ms" | "p99_ms">,
  segment?: string,
): string {
  const rows = segment ? summary?.segments : summary?.metrics;
  const row = rows?.find(
    (x) => x.metric === metric && (segment == null || x.segment === segment),
  );
  return row ? formatMs(row[field]) : "n/a";
}

export const UsageStatistics: React.FC = () => {
  const [windowMinutes, setWindowMinutes] = useState(24 * 60);
  const [summary, setSummary] = useState<UxLatencySummary>();
  const [launchHealth, setLaunchHealth] = useState<LaunchHealthStatus>();
  const [serviceDenials, setServiceDenials] =
    useState<ServiceAdmissionDenialReport>();
  const [acpDenials, setAcpDenials] = useState<AcpAdmissionDenialReport>();
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let canceled = false;
    const load = async () => {
      setLoading(true);
      setError(undefined);
      try {
        const [nextSummary, nextHealth, nextServiceDenials, nextAcpDenials] =
          await Promise.all([
            webapp_client.conat_client.hub.system.getUxLatencySummary({
              window_minutes: windowMinutes,
            }),
            webapp_client.conat_client.hub.system.getLaunchHealth({
              window_minutes: windowMinutes,
            }),
            webapp_client.conat_client.hub.system.getServiceAdmissionDenialReport(
              {
                window_minutes: windowMinutes,
                limit: 500,
              },
            ),
            webapp_client.conat_client.hub.system.getAcpAdmissionDenialReport({
              window_minutes: windowMinutes,
              limit: 500,
            }),
          ]);
        if (!canceled) {
          setSummary(nextSummary);
          setLaunchHealth(nextHealth);
          setServiceDenials(nextServiceDenials);
          setAcpDenials(nextAcpDenials);
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

  const healthColumns = [
    {
      title: "Level",
      dataIndex: "level",
      key: "level",
      render: (level: LaunchHealthLevel) => (
        <Tag color={healthColor(level)}>{level}</Tag>
      ),
    },
    {
      title: "Check",
      dataIndex: "label",
      key: "label",
    },
    {
      title: "Summary",
      dataIndex: "summary",
      key: "summary",
      render: (summary: string, row: LaunchHealthCheck) => (
        <div>
          <div>{summary}</div>
          {row.details?.length ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {row.details.slice(0, 3).join(" | ")}
              {row.details.length > 3 ? " | ..." : ""}
            </Text>
          ) : null}
        </div>
      ),
    },
  ];

  const metricColumns = [
    {
      title: "Metric",
      dataIndex: "metric",
      key: "metric",
      render: (metric: string, row: UxLatencyMetricSummary) => (
        <div>
          <div>
            <LabelWithHelp
              label={metricLabel(metric)}
              help={metricHelp(metric, row.segment)}
            />
          </div>
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
      render: (metric: string, row: UxLatencyRecentEvent) => (
        <LabelWithHelp
          label={metricLabel(metric)}
          help={metricHelp(metric, row.segment)}
        />
      ),
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

  const serviceDenialColumns = [
    {
      title: "Last seen",
      dataIndex: "last_time",
      key: "last_time",
      render: (value: string, row: ServiceAdmissionDenialSummary) => (
        <div>
          <div>{formatDate(value)}</div>
          <Text type="secondary">span {formatSpan(row.first_time, value)}</Text>
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
      title: "Surface",
      dataIndex: "surface",
      key: "surface",
      render: (value: string, row: ServiceAdmissionDenialSummary) => (
        <div>
          <Tag>{value}</Tag>
          <div>
            <Text type="secondary">{row.source}</Text>
          </div>
        </div>
      ),
    },
    {
      title: "Limit",
      dataIndex: "limit",
      key: "limit",
      render: (value: string, row: ServiceAdmissionDenialSummary) => (
        <div>
          <Text code>{value}</Text>
          <div>
            <Text type="secondary">
              max {row.max_current}/{row.max_maximum}
            </Text>
          </div>
        </div>
      ),
    },
    {
      title: "Scope",
      key: "scope",
      render: (_: unknown, row: ServiceAdmissionDenialSummary) => (
        <Scope
          account_id={row.account_id}
          project_id={row.project_id}
          host_id={row.host_id}
        />
      ),
    },
    {
      title: "Operation",
      key: "operation",
      render: (_: unknown, row: ServiceAdmissionDenialSummary) => (
        <div>
          <div>
            {row.sample_key || row.sample_subject || row.sample_path || "-"}
          </div>
          {row.sample_reason ? (
            <Text type="secondary">{row.sample_reason}</Text>
          ) : null}
        </div>
      ),
    },
    {
      title: "Bay",
      dataIndex: "bay_id",
      key: "bay_id",
      render: (value?: string) => value || "-",
    },
  ];

  const acpDenialColumns = [
    {
      title: "Last seen",
      dataIndex: "last_time",
      key: "last_time",
      render: (value: string, row: AcpAdmissionDenialSummary) => (
        <div>
          <div>{formatDate(value)}</div>
          <Text type="secondary">span {formatSpan(row.first_time, value)}</Text>
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
      title: "Limit",
      dataIndex: "limit",
      key: "limit",
      render: (value: string, row: AcpAdmissionDenialSummary) => (
        <div>
          <Text code>{value}</Text>
          <div>
            <Text type="secondary">
              max {row.max_current}/{row.max_maximum}
            </Text>
          </div>
        </div>
      ),
    },
    {
      title: "Source",
      dataIndex: "source",
      key: "source",
    },
    {
      title: "Scope",
      key: "scope",
      render: (_: unknown, row: AcpAdmissionDenialSummary) => (
        <Scope account_id={row.account_id} project_id={row.project_id} />
      ),
    },
    {
      title: "Sample",
      key: "sample",
      render: (_: unknown, row: AcpAdmissionDenialSummary) =>
        row.sample_path || row.sample_thread_id || "-",
    },
    {
      title: "Bay",
      dataIndex: "bay_id",
      key: "bay_id",
      render: (value?: string) => value || "-",
    },
  ];

  const metricRows = summary?.metrics ?? [];
  const segmentRows = summary?.segments ?? [];
  const recentRows = summary?.recent_slow_events ?? [];
  const allServiceDenialRows = serviceDenials?.groups ?? [];
  const allAcpDenialRows = acpDenials?.groups ?? [];
  const serviceDenialRows = allServiceDenialRows.filter((row) =>
    matchesSearch(row, search),
  );
  const acpDenialRows = allAcpDenialRows.filter((row) =>
    matchesSearch(row, search),
  );
  const containmentRows = [...allServiceDenialRows, ...allAcpDenialRows];
  const unavailableBays = [
    ...(serviceDenials?.bays ?? []),
    ...(acpDenials?.bays ?? []),
  ].filter((bay, index, rows) => {
    if (bay.ok) return false;
    return (
      rows.findIndex((candidate) => candidate.bay_id === bay.bay_id) === index
    );
  });
  const activeWindowLabel = windowLabel(windowMinutes).toLowerCase();

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title="Operations Monitor"
        extra={
          <Select
            options={WINDOW_OPTIONS}
            value={windowMinutes}
            onChange={setWindowMinutes}
            style={{ minWidth: 150 }}
          />
        }
      >
        {error ? (
          <Alert
            type="error"
            showIcon
            message="Unable to refresh all operations data"
            description={error}
            style={{ marginBottom: 16 }}
          />
        ) : null}
        <Alert
          type="info"
          showIcon
          message="Contained events are monitoring state, not admin alerts"
          description="Admission controls rejected these requests to protect shared services. They remain searchable here for investigation; admin alerts are reserved for conditions that require immediate attention."
          style={{ marginBottom: 16 }}
        />
        {unavailableBays.length ? (
          <Alert
            type="warning"
            showIcon
            message="Some bay telemetry is unavailable"
            description={unavailableBays
              .map((bay) => `${bay.bay_id}: ${bay.error || "unknown error"}`)
              .join(" | ")}
            style={{ marginBottom: 16 }}
          />
        ) : null}
        <Spin spinning={loading && !serviceDenials && !acpDenials}>
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            <Col xs={12} md={6}>
              <Statistic
                title="Service requests contained"
                value={sumCounts(allServiceDenialRows)}
              />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title="ACP requests contained"
                value={sumCounts(allAcpDenialRows)}
              />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title="Affected accounts"
                value={distinctCount(containmentRows, "account_id")}
              />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title="Affected projects"
                value={distinctCount(containmentRows, "project_id")}
              />
            </Col>
          </Row>
          <Input
            allowClear
            prefix={<Icon name="search" />}
            placeholder="Search account, project, host, bay, method, surface, limit, source, or reason"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Spin>
      </Card>

      <Card
        title={
          <Space>
            <span>Launch Health</span>
            {launchHealth ? (
              <Tag color={healthColor(launchHealth.overall)}>
                {launchHealth.overall}
              </Tag>
            ) : null}
          </Space>
        }
        extra={
          launchHealth ? (
            <Text type="secondary">
              {launchHealth.bay_id} checked{" "}
              {new Date(launchHealth.checked_at).toLocaleString()}
            </Text>
          ) : null
        }
      >
        <Spin spinning={loading && !launchHealth}>
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            <Col xs={12} md={6}>
              <Statistic
                title="Project hosts"
                value={formatCount(launchHealth?.counts.project_hosts_total)}
              />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title="Queued ops"
                value={formatCount(launchHealth?.counts.parallel_ops_queued)}
              />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title="Projection backlog"
                value={formatCount(
                  launchHealth?.counts.projection_unpublished_events,
                )}
              />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title="Active switches"
                value={launchHealth?.kill_switches.active.length ?? "n/a"}
              />
            </Col>
          </Row>
          <Table<LaunchHealthCheck>
            columns={healthColumns}
            dataSource={launchHealth?.checks ?? []}
            rowKey="id"
            pagination={false}
            size="small"
          />
        </Spin>
      </Card>

      <Card title="User Latency">
        <Spin spinning={loading && !summary}>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={8}>
              <Statistic
                title={
                  <LabelWithHelp
                    label={`Provisioned lifecycle P50 (${activeWindowLabel})`}
                    help={metricHelp(
                      "project_start_running",
                      "warm_provisioned",
                    )}
                  />
                }
                value={summaryValue(
                  summary,
                  "project_start_running",
                  "p50_ms",
                  "warm_provisioned",
                )}
              />
            </Col>
            <Col xs={24} md={8}>
              <Statistic
                title={
                  <LabelWithHelp
                    label={`File visible P95 (${activeWindowLabel})`}
                    help={metricHelp("file_open_visible")}
                  />
                }
                value={summaryValue(summary, "file_open_visible", "p95_ms")}
              />
            </Col>
            <Col xs={24} md={8}>
              <Statistic
                title={
                  <LabelWithHelp
                    label={`File sync-ready P95 (${activeWindowLabel})`}
                    help={metricHelp("file_open_sync_ready")}
                  />
                }
                value={summaryValue(summary, "file_open_sync_ready", "p95_ms")}
              />
            </Col>
          </Row>
        </Spin>
      </Card>

      <Card
        title="Service Admission Containment"
        extra={
          <Text type="secondary">
            {serviceDenialRows.length} of {allServiceDenialRows.length} groups
          </Text>
        }
      >
        <Table<ServiceAdmissionDenialSummary>
          columns={serviceDenialColumns}
          dataSource={serviceDenialRows}
          rowKey={(row, index) =>
            `${row.bay_id}:${row.surface}:${row.limit}:${row.account_id}:${row.project_id}:${index}`
          }
          pagination={{ pageSize: 20 }}
          scroll={{ x: 1100 }}
          size="small"
        />
      </Card>

      <Card
        title="ACP Admission Containment"
        extra={
          <Text type="secondary">
            {acpDenialRows.length} of {allAcpDenialRows.length} groups
          </Text>
        }
      >
        <Table<AcpAdmissionDenialSummary>
          columns={acpDenialColumns}
          dataSource={acpDenialRows}
          rowKey={(row, index) =>
            `${row.bay_id}:${row.limit}:${row.account_id}:${row.project_id}:${index}`
          }
          pagination={{ pageSize: 20 }}
          scroll={{ x: 1000 }}
          size="small"
        />
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
