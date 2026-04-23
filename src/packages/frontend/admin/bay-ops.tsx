/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card, Space, Table, Tag, Typography } from "antd";

import { React } from "@cocalc/frontend/app-framework";
import { ErrorDisplay, Loading, TimeAgo } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  BayLoadProjectionStatus,
  BayOpsDetail,
  BayOpsOverview,
  BayOpsOverviewBay,
  BayOpsRehomeCounts,
} from "@cocalc/conat/hub/api/system";

const STALE_AFTER_MS = 5 * 60 * 1000;
const VERY_STALE_AFTER_MS = 15 * 60 * 1000;

function count(value: number): string {
  return value.toLocaleString();
}

function ageMs(timestamp: string | null): number | null {
  if (!timestamp) return null;
  const t = new Date(timestamp).valueOf();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Date.now() - t);
}

function heartbeatTag(bay: BayOpsOverviewBay): React.ReactNode {
  const age = ageMs(bay.last_seen);
  if (age == null) return <Tag>not registered</Tag>;
  if (age >= VERY_STALE_AFTER_MS) return <Tag color="red">stale</Tag>;
  if (age >= STALE_AFTER_MS) return <Tag color="orange">late</Tag>;
  return <Tag color="green">fresh</Tag>;
}

function rehomeTotals(counts: BayOpsRehomeCounts): {
  running: number;
  failed: number;
  recent_success: number;
} {
  return {
    running: counts.outbound.running + counts.inbound.running,
    failed: counts.outbound.failed + counts.inbound.failed,
    recent_success:
      counts.outbound.recent_success + counts.inbound.recent_success,
  };
}

function RehomeTags({ bay }: { bay: BayOpsOverviewBay }) {
  const project = rehomeTotals(bay.rehome.project);
  const account = rehomeTotals(bay.rehome.account);
  const host = rehomeTotals(bay.rehome.project_host);
  const failed = project.failed + account.failed + host.failed;
  const running = project.running + account.running + host.running;
  const recent =
    project.recent_success + account.recent_success + host.recent_success;
  return (
    <Space wrap size={[0, 4]}>
      <Tag color={running ? "blue" : undefined}>running {running}</Tag>
      <Tag color={failed ? "red" : undefined}>failed {failed}</Tag>
      <Tag color={recent ? "green" : undefined}>24h success {recent}</Tag>
    </Space>
  );
}

function commandList(bay: BayOpsOverviewBay): string[] {
  const id = bay.bay_id;
  return [
    `cocalc bay show ${id}`,
    `cocalc bay load ${id}`,
    `cocalc bay backups ${id}`,
    `cocalc bay restore-test ${id} --remote-only`,
    `cocalc bay project-ownership-admission ${id} --accepts no --note "maintenance drain"`,
    `cocalc project rehome-drain --source-bay ${id} --dest-bay <dest-bay> --limit 25 --reason maintenance`,
    `cocalc account rehome-drain --source-bay ${id} --dest-bay <dest-bay> --limit 25 --reason maintenance`,
  ];
}

function formatAgeMs(value: number | null): string {
  if (value == null) return "none";
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`;
  return `${Math.round(value / 3_600_000)}h`;
}

function ProjectionStatus({
  name,
  status,
}: {
  name: string;
  status: BayLoadProjectionStatus;
}) {
  const hasBacklog = status.unpublished_events > 0;
  return (
    <Space direction="vertical" size={0}>
      <Typography.Text strong>{name}</Typography.Text>
      <Space wrap size={[4, 4]}>
        <Tag color={hasBacklog ? "orange" : "green"}>
          backlog {count(status.unpublished_events)}
        </Tag>
        <Tag color={status.maintenance_running ? "blue" : undefined}>
          maintenance {status.maintenance_running ? "running" : "idle"}
        </Tag>
        <Tag>oldest {formatAgeMs(status.oldest_unpublished_event_age_ms)}</Tag>
      </Space>
      {status.last_success_at ? (
        <Typography.Text type="secondary">
          Last success <TimeAgo date={status.last_success_at} />
        </Typography.Text>
      ) : null}
    </Space>
  );
}

function BackupHealth({ detail }: { detail: BayOpsDetail }) {
  const backups = detail.backups;
  if (detail.backups_error) {
    return <Alert type="warning" showIcon message={detail.backups_error} />;
  }
  if (!backups) {
    return (
      <Typography.Text type="secondary">No backup snapshot.</Typography.Text>
    );
  }
  const backup = backups.bay_backup;
  const readiness = backups.restore_readiness;
  return (
    <Space direction="vertical" size={8}>
      <Space wrap>
        <Tag color={backup.enabled ? "green" : "orange"}>
          backups {backup.enabled ? "enabled" : "disabled"}
        </Tag>
        <Tag color={backup.last_error ? "red" : "green"}>
          last error {backup.last_error ? "yes" : "none"}
        </Tag>
        <Tag color={readiness.gold_star ? "green" : "orange"}>
          restore readiness {readiness.gold_star ? "gold" : "check"}
        </Tag>
        <Tag>backend {backup.current_storage_backend}</Tag>
        <Tag>R2 {backups.r2.configured ? "configured" : "not configured"}</Tag>
      </Space>
      <Space wrap>
        <Typography.Text>
          Latest backup:{" "}
          {backup.last_successful_backup_at ? (
            <TimeAgo date={backup.last_successful_backup_at} />
          ) : (
            "never"
          )}
        </Typography.Text>
        <Typography.Text>
          Remote backup:{" "}
          {backup.last_successful_remote_backup_at ? (
            <TimeAgo date={backup.last_successful_remote_backup_at} />
          ) : (
            "never"
          )}
        </Typography.Text>
        <Typography.Text>
          Restore test: {readiness.latest_backup_restore_test_status}
        </Typography.Text>
        <Typography.Text>
          PITR: {readiness.latest_backup_pitr_test_status}
        </Typography.Text>
      </Space>
      {backup.last_error ? (
        <Typography.Text type="danger">{backup.last_error}</Typography.Text>
      ) : null}
      <Typography.Text type="secondary">{readiness.summary}</Typography.Text>
    </Space>
  );
}

function LoadHealth({ detail }: { detail: BayOpsDetail }) {
  const load = detail.load;
  if (detail.load_error) {
    return <Alert type="warning" showIcon message={detail.load_error} />;
  }
  if (!load) {
    return (
      <Typography.Text type="secondary">No load snapshot.</Typography.Text>
    );
  }
  return (
    <Space direction="vertical" size="middle">
      <Space wrap>
        <Tag>accounts {count(load.browser_control.active_accounts)}</Tag>
        <Tag>browsers {count(load.browser_control.active_browsers)}</Tag>
        <Tag>connections {count(load.browser_control.active_connections)}</Tag>
        <Tag>hosts {count(load.hosts.total_hosts)}</Tag>
        <Tag color={load.parallel_ops.queued_total ? "orange" : "green"}>
          queued ops {count(load.parallel_ops.queued_total)}
        </Tag>
        <Tag color={load.parallel_ops.stale_running_total ? "red" : undefined}>
          stale ops {count(load.parallel_ops.stale_running_total)}
        </Tag>
      </Space>
      <Space wrap align="start">
        <ProjectionStatus
          name="account-project"
          status={load.projections.account_project_index}
        />
        <ProjectionStatus
          name="collaborator"
          status={load.projections.account_collaborator_index}
        />
        <ProjectionStatus
          name="notification"
          status={load.projections.account_notification_index}
        />
      </Space>
      {load.parallel_ops.hotspots.length ? (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>Parallel-op hotspots</Typography.Text>
          {load.parallel_ops.hotspots.map((hotspot) => (
            <Typography.Text key={hotspot.worker_kind} type="secondary">
              {hotspot.worker_kind}: queued={count(hotspot.queued_count)}{" "}
              running={count(hotspot.running_count)} stale=
              {count(hotspot.stale_running_count ?? 0)}
            </Typography.Text>
          ))}
        </Space>
      ) : null}
    </Space>
  );
}

function BayHealth({ bay }: { bay: BayOpsOverviewBay }) {
  const hub = webapp_client.conat_client.hub;
  const [detail, setDetail] = React.useState<BayOpsDetail>();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      setDetail(await hub.system.getBayOpsDetail({ bay_id: bay.bay_id }));
      setError("");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }, [bay.bay_id, hub]);

  React.useEffect(() => {
    load();
  }, [load]);

  return (
    <Card
      size="small"
      title="Drain-readiness health"
      extra={
        <Button size="small" loading={loading} onClick={load}>
          Refresh health
        </Button>
      }
    >
      {error ? <ErrorDisplay error={error} /> : null}
      {loading && !detail ? <Loading /> : null}
      {detail ? (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            Health snapshot from <TimeAgo date={detail.checked_at} />
            {detail.routed ? " via inter-bay RPC" : ""}
          </Typography.Text>
          <Card size="small" title="Load and projections">
            <LoadHealth detail={detail} />
          </Card>
          <Card size="small" title="Backup and restore readiness">
            <BackupHealth detail={detail} />
          </Card>
        </Space>
      ) : null}
    </Card>
  );
}

function Detail({ bay }: { bay: BayOpsOverviewBay }) {
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <Typography.Text>
          Public origin:{" "}
          <Typography.Text code copyable={{ text: bay.public_origin ?? "" }}>
            {bay.public_origin ?? "none"}
          </Typography.Text>
        </Typography.Text>
        <Typography.Text>
          Public target:{" "}
          <Typography.Text code copyable={{ text: bay.public_target ?? "" }}>
            {bay.public_target ?? "none"}
          </Typography.Text>
        </Typography.Text>
        <Typography.Text>
          DNS hostname:{" "}
          <Typography.Text code copyable={{ text: bay.dns_hostname ?? "" }}>
            {bay.dns_hostname ?? "none"}
          </Typography.Text>
        </Typography.Text>
      </Space>
      <Card size="small" title="Copy/paste operator commands">
        {commandList(bay).map((command) => (
          <Typography.Paragraph
            key={command}
            copyable={{ text: command }}
            style={{ marginBottom: 6 }}
          >
            <Typography.Text code>{command}</Typography.Text>
          </Typography.Paragraph>
        ))}
      </Card>
      <BayHealth bay={bay} />
    </Space>
  );
}

export function BayOpsAdmin() {
  const hub = webapp_client.conat_client.hub;
  const [overview, setOverview] = React.useState<BayOpsOverview>();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      setOverview(await hub.system.getBayOpsOverview({}));
      setError("");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }, [hub]);

  React.useEffect(() => {
    load();
  }, [load]);

  const rows = overview?.bays ?? [];

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Alert
        showIcon
        type="info"
        message="Read-only bay operations overview"
        description="Use this page to inspect bay ownership distribution, heartbeat freshness, and recent rehome health. Actions are intentionally copy/paste CLI commands for this first slice."
      />
      <Space wrap>
        <Button onClick={load} loading={loading}>
          Refresh
        </Button>
        {overview ? (
          <Typography.Text type="secondary">
            Snapshot from <TimeAgo date={overview.checked_at} /> on{" "}
            <Typography.Text code>{overview.current_bay_id}</Typography.Text>
          </Typography.Text>
        ) : null}
      </Space>
      {error ? <ErrorDisplay error={error} /> : null}
      {loading && !overview ? <Loading /> : null}
      <Table
        rowKey="bay_id"
        dataSource={rows}
        pagination={false}
        expandable={{ expandedRowRender: (bay) => <Detail bay={bay} /> }}
        columns={[
          {
            title: "Bay",
            dataIndex: "bay_id",
            render: (_value, bay) => (
              <Space orientation="vertical" size={0}>
                <Space wrap size={[4, 4]}>
                  <Typography.Text strong copyable={{ text: bay.bay_id }}>
                    {bay.label}
                  </Typography.Text>
                  {bay.is_default ? <Tag color="blue">current</Tag> : null}
                  <Tag>{bay.role}</Tag>
                  <Tag>{bay.deployment_mode}</Tag>
                </Space>
                <Typography.Text type="secondary" code>
                  {bay.bay_id}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: "Heartbeat",
            dataIndex: "last_seen",
            render: (_value, bay) => (
              <Space orientation="vertical" size={0}>
                {heartbeatTag(bay)}
                {bay.last_seen ? (
                  <Typography.Text type="secondary">
                    <TimeAgo date={bay.last_seen} />
                  </Typography.Text>
                ) : null}
              </Space>
            ),
          },
          {
            title: "Admission",
            dataIndex: "accepts_project_ownership",
            render: (_value, bay) => (
              <Space orientation="vertical" size={0}>
                {bay.accepts_project_ownership === false ? (
                  <Tag color="orange">closed</Tag>
                ) : (
                  <Tag color="green">accepting projects</Tag>
                )}
                {bay.project_ownership_note ? (
                  <Typography.Text type="secondary">
                    {bay.project_ownership_note}
                  </Typography.Text>
                ) : null}
              </Space>
            ),
          },
          {
            title: "Ownership",
            dataIndex: "ownership",
            render: (_value, bay) => (
              <Space orientation="vertical" size={0}>
                <Typography.Text>
                  Accounts: {count(bay.ownership.accounts)}
                </Typography.Text>
                <Typography.Text>
                  Projects: {count(bay.ownership.projects)}
                </Typography.Text>
                <Typography.Text>
                  Hosts: {count(bay.ownership.project_hosts)}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: "Rehome Ops",
            dataIndex: "rehome",
            render: (_value, bay) => <RehomeTags bay={bay} />,
          },
          {
            title: "Region",
            dataIndex: "region",
            render: (region) => region ?? "unknown",
          },
        ]}
      />
    </Space>
  );
}
