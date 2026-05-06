/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Space, Spin, Table, Tag, Typography } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  ProjectBackupShardAdminRegionInfo,
  ProjectBackupShardAdminRepoInfo,
  ProjectBackupShardAdminStatus,
} from "@cocalc/conat/hub/api/system";
import { TimeAgo } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const REFRESH_MS = 60 * 1000;

function statusTag(status: string | null) {
  const normalized = `${status ?? "active"}`.trim() || "active";
  switch (normalized) {
    case "active":
      return <Tag color="green">active</Tag>;
    case "sealed":
      return <Tag color="orange">sealed</Tag>;
    case "draining":
      return <Tag color="blue">draining</Tag>;
    case "disabled":
      return <Tag color="red">disabled</Tag>;
    default:
      return <Tag>{normalized}</Tag>;
  }
}

function count(value: number): string {
  return Math.max(0, Number(value) || 0).toLocaleString();
}

export function ProjectBackupShardsAdmin() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState<ProjectBackupShardAdminStatus | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next =
        await webapp_client.conat_client.hub.system.getProjectBackupShards({});
      setData(next as ProjectBackupShardAdminStatus);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  const regionRows = useMemo<ProjectBackupShardAdminRegionInfo[]>(
    () => data?.regions ?? [],
    [data],
  );
  const repoRows = useMemo<ProjectBackupShardAdminRepoInfo[]>(
    () => data?.repos ?? [],
    [data],
  );

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Paragraph style={{ marginBottom: 0 }}>
        Seed-backed view of project-backup rustic shards. This is the
        authoritative allocator state in multi-bay mode and the main operator
        surface for shard growth, sealing, and load skew.
      </Typography.Paragraph>
      <Space wrap>
        <Tag>authoritative bay {data?.authoritative_bay_id ?? "…"}</Tag>
        <Tag>active shards/region {data?.active_shards_per_region ?? "…"}</Tag>
        <Tag>projects/shard {data?.projects_per_shard ?? "…"}</Tag>
        <Button onClick={() => void load()}>Refresh</Button>
        {data?.checked_at ? (
          <Typography.Text type="secondary">
            Updated <TimeAgo date={data.checked_at} />
          </Typography.Text>
        ) : null}
      </Space>
      {error ? (
        <Alert
          type="error"
          showIcon
          message="Failed to load backup shards"
          description={error}
        />
      ) : null}
      {loading ? <Spin /> : null}
      <Table<ProjectBackupShardAdminRegionInfo>
        rowKey={(row) => row.region}
        dataSource={regionRows}
        pagination={false}
        size="small"
        title={() => "Regions"}
      >
        <Table.Column<ProjectBackupShardAdminRegionInfo>
          title="Region"
          dataIndex="region"
        />
        <Table.Column<ProjectBackupShardAdminRegionInfo>
          title="Repos"
          render={(_, row) =>
            `${count(row.active_repos)} active / ${count(row.total_repos)} total`
          }
        />
        <Table.Column<ProjectBackupShardAdminRegionInfo>
          title="Statuses"
          render={(_, row) => (
            <Space wrap size={[4, 4]}>
              <Tag>sealed {count(row.sealed_repos)}</Tag>
              <Tag>draining {count(row.draining_repos)}</Tag>
              <Tag>disabled {count(row.disabled_repos)}</Tag>
            </Space>
          )}
        />
        <Table.Column<ProjectBackupShardAdminRegionInfo>
          title="Assigned Projects"
          render={(_, row) => count(row.assigned_projects)}
        />
        <Table.Column<ProjectBackupShardAdminRegionInfo>
          title="Active Capacity"
          render={(_, row) =>
            `${count(row.active_available_project_slots)} free / ${count(row.active_capacity_projects)} total`
          }
        />
      </Table>
      <Table<ProjectBackupShardAdminRepoInfo>
        rowKey={(row) => row.id}
        dataSource={repoRows}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        size="small"
        title={() => "Shard Repos"}
      >
        <Table.Column<ProjectBackupShardAdminRepoInfo>
          title="Region"
          dataIndex="region"
        />
        <Table.Column<ProjectBackupShardAdminRepoInfo>
          title="Root"
          dataIndex="root"
          render={(root) => (
            <Typography.Text code>{root ?? ""}</Typography.Text>
          )}
        />
        <Table.Column<ProjectBackupShardAdminRepoInfo>
          title="Bucket"
          dataIndex="bucket_name"
        />
        <Table.Column<ProjectBackupShardAdminRepoInfo>
          title="Status"
          render={(_, row) => statusTag(row.status)}
        />
        <Table.Column<ProjectBackupShardAdminRepoInfo>
          title="Assigned"
          render={(_, row) => count(row.assigned_project_count)}
        />
        <Table.Column<ProjectBackupShardAdminRepoInfo>
          title="Capacity"
          render={(_, row) =>
            `${count(row.available_project_slots)} free / ${count(row.project_cap)}`
          }
        />
        <Table.Column<ProjectBackupShardAdminRepoInfo>
          title="Updated"
          render={(_, row) =>
            row.updated ? <TimeAgo date={row.updated} /> : <span>-</span>
          }
        />
      </Table>
    </Space>
  );
}
