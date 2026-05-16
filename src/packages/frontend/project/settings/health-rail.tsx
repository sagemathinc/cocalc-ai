/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card, Modal, Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import {
  CopyToClipBoard,
  Icon,
  ProjectState,
  TimeAgo,
} from "@cocalc/frontend/components";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import type { SnapshotUsage } from "@cocalc/conat/files/file-server";
import DiskUsage from "@cocalc/frontend/project/disk-usage/disk-usage";
import { linearList } from "@cocalc/frontend/project/info/utils";
import useDiskUsage from "@cocalc/frontend/project/disk-usage/use-disk-usage";
import useProjectInfo from "@cocalc/frontend/project/info/use-project-info";
import { ManagedEgressRateSummary } from "@cocalc/frontend/purchases/managed-egress-history";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import {
  hostLabel,
  normalizeProjectStateForDisplay,
} from "@cocalc/frontend/projects/host-operational";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { BACKUPS } from "@cocalc/util/consts/backups";
import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";
import { Project } from "./types";
import { human_readable_size } from "@cocalc/util/misc";
import { useRunQuota } from "./run-quota/hooks";

const { Text, Title } = Typography;

interface Props {
  project_id: string;
  project: Project;
  showNoInternetWarning?: boolean;
  showNonMemberWarning?: boolean;
}

function HealthRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gap: 4,
        gridTemplateColumns: "96px minmax(0, 1fr)",
        lineHeight: 1.35,
      }}
    >
      <Text type="secondary">{label}</Text>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

export function ProjectSettingsHealthRail({
  project_id,
  project,
  showNoInternetWarning,
  showNonMemberWarning,
}: Props) {
  const projectStatus = useTypedRedux({ project_id }, "status");
  const projectMap = useTypedRedux("projects", "project_map");
  const hostId = (project as any).get("host_id") as string | undefined;
  const hostInfo = useHostInfo(hostId);
  const displayStateValue = normalizeProjectStateForDisplay({
    projectState: (project as any).getIn(["state", "state"]),
    hostId,
    hostInfo,
  });
  const displayProjectState = (() => {
    const rawState = (project as any).get("state");
    if (!rawState) return rawState;
    if (rawState.get("state") !== "running") return rawState;
    if (displayStateValue !== "opened") return rawState;
    return rawState.set("state", "opened");
  })();
  const runQuota = useRunQuota(project_id, null);
  const lastBackup =
    projectMap?.getIn([project_id, "last_backup"]) ??
    (project as any).get("last_backup");
  const startTs = projectStatus?.get("start_ts");
  const userCount = (project as any).get("users")?.size;

  return (
    <Card
      style={{
        position: "sticky",
        top: 16,
        border: "1px solid #d9e2ec",
        boxShadow: "0 8px 28px rgba(15, 23, 42, 0.05)",
      }}
      styles={{ body: { padding: 16 } }}
    >
      <Title
        level={4}
        style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 0 }}
      >
        <Icon name="dashboard" /> Project Health
      </Title>
      <Space direction="vertical" style={{ width: "100%" }} size={12}>
        <HealthRow label="State">
          {displayProjectState ? (
            <ProjectState show_desc={false} state={displayProjectState} />
          ) : (
            <Text type="secondary">Unknown</Text>
          )}
        </HealthRow>
        <HealthRow label="Host">
          <Text>{hostLabel(hostInfo, hostId) ?? "Unassigned"}</Text>
        </HealthRow>
        {typeof startTs === "number" && displayStateValue === "running" && (
          <HealthRow label="Uptime">
            <TimeAgo date={new Date(startTs)} />
          </HealthRow>
        )}
        <HealthRow label="Project ID">
          <CopyToClipBoard
            value={project_id}
            display={`${project_id.slice(0, 8)}...`}
            size="small"
            inputWidth="90px"
            style={{ display: "inline-block" }}
          />
        </HealthRow>
        {typeof userCount === "number" && (
          <HealthRow label="People">
            <Tag>
              {userCount} collaborator{userCount === 1 ? "" : "s"}
            </Tag>
          </HealthRow>
        )}
        <BackupHealthRow project_id={project_id} lastBackup={lastBackup} />
        <SnapshotHealthRow project_id={project_id} />
        <StorageHealthRow project_id={project_id} />
        <ProcessHealthRow project_id={project_id} />
        <HealthRow label="Network">
          <Space direction="vertical" size={2}>
            <ManagedEgressRateSummary project_id={project_id} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              Internet:{" "}
              {runQuota.network == null
                ? "Unknown"
                : runQuota.network
                  ? "Enabled"
                  : "Disabled"}
            </Text>
          </Space>
        </HealthRow>
        {runQuota.member_host != null && (
          <HealthRow label="Member host">
            <Tag color={runQuota.member_host ? "green" : "warning"}>
              {runQuota.member_host ? "Yes" : "No"}
            </Tag>
          </HealthRow>
        )}
        {(showNoInternetWarning || showNonMemberWarning) && (
          <Alert
            type="warning"
            showIcon
            message="Attention needed"
            description={
              showNoInternetWarning
                ? "This project currently has no internet access."
                : "This project is not running on a member host."
            }
          />
        )}
      </Space>
    </Card>
  );
}

function openDirectory(project_id: string, path: string) {
  void redux.getProjectActions(project_id).open_directory(path, true, true);
}

function BackupHealthRow({
  project_id,
  lastBackup,
}: {
  project_id: string;
  lastBackup: unknown;
}) {
  return (
    <HealthRow label="Backups">
      <Space direction="vertical" size={2}>
        {lastBackup ? (
          <Text>
            Last backup <TimeAgo date={lastBackup as any} />
          </Text>
        ) : (
          <Text type="secondary">No backup recorded</Text>
        )}
        <Button size="small" onClick={() => openDirectory(project_id, BACKUPS)}>
          Open backups
        </Button>
      </Space>
    </HealthRow>
  );
}

function newestSnapshot(snapshots: SnapshotUsage[]): SnapshotUsage | undefined {
  return snapshots.reduce<SnapshotUsage | undefined>((newest, snapshot) => {
    const snapshotTime = new Date(snapshot.name).getTime();
    if (!Number.isFinite(snapshotTime)) return newest;
    if (newest == null) return snapshot;
    const newestTime = new Date(newest.name).getTime();
    return snapshotTime > newestTime ? snapshot : newest;
  }, undefined);
}

function SnapshotHealthRow({ project_id }: { project_id: string }) {
  const [loading, setLoading] = useState<boolean>(true);
  const [snapshot, setSnapshot] = useState<SnapshotUsage | undefined>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSnapshot(undefined);
    (async () => {
      try {
        const usage =
          await webapp_client.conat_client.hub.projects.allSnapshotUsage({
            project_id,
          });
        if (!cancelled) {
          setSnapshot(newestSnapshot(usage));
        }
      } catch (_) {
        if (!cancelled) {
          setSnapshot(undefined);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project_id]);

  return (
    <HealthRow label="Snapshots">
      <Space direction="vertical" size={2}>
        {snapshot ? (
          <Text>
            Last snapshot <TimeAgo date={snapshot.name as any} />
          </Text>
        ) : loading ? (
          <Text type="secondary">Loading...</Text>
        ) : (
          <Text type="secondary">No snapshots found</Text>
        )}
        <Button
          size="small"
          onClick={() => openDirectory(project_id, SNAPSHOTS)}
        >
          Open snapshots
        </Button>
      </Space>
    </HealthRow>
  );
}

function ProcessHealthRow({ project_id }: { project_id: string }) {
  const { info, disconnected } = useProjectInfo({
    project_id,
    intervalVisible: 10000,
    intervalHidden: 60000,
  });
  const rows = info?.processes == null ? undefined : linearList(info.processes);

  if (disconnected && rows == null) {
    return (
      <HealthRow label="Processes">
        <Space direction="vertical" size={2}>
          <Text type="secondary">Unavailable</Text>
          <Button size="small" href="#runtime">
            Open runtime
          </Button>
        </Space>
      </HealthRow>
    );
  }

  const processCount = rows?.length ?? 0;
  const cpuPct =
    rows == null
      ? undefined
      : rows.reduce((total, process) => total + process.cpu_pct, 0);
  const memoryBytes =
    rows == null
      ? undefined
      : rows.reduce((total, process) => total + process.mem, 0);

  return (
    <HealthRow label="Processes">
      <Space direction="vertical" size={2}>
        <Text>
          {processCount} process{processCount === 1 ? "" : "es"}
        </Text>
        {cpuPct != null && memoryBytes != null && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            CPU {cpuPct.toFixed(1)}% · Memory {human_readable_size(memoryBytes)}
          </Text>
        )}
        <Button size="small" href="#runtime">
          Open runtime
        </Button>
      </Space>
    </HealthRow>
  );
}

function StorageHealthRow({ project_id }: { project_id: string }) {
  const [open, setOpen] = useState<boolean>(false);
  const { quotas, live, retained, loading } = useDiskUsage({ project_id });
  const quota = quotas[0];
  const quotaLabel =
    quota == null || quota.size <= 0
      ? undefined
      : `${human_readable_size(quota.used)} / ${human_readable_size(quota.size)}`;
  const liveLabel = live ? human_readable_size(live.bytes) : undefined;
  const retainedLabel = retained
    ? human_readable_size(retained.bytes)
    : undefined;

  return (
    <>
      <HealthRow label="Storage">
        <Space direction="vertical" size={2} style={{ width: "100%" }}>
          {quotaLabel ? (
            <Text>{quotaLabel}</Text>
          ) : loading ? (
            <Text type="secondary">Loading...</Text>
          ) : (
            <Text type="secondary">Unknown</Text>
          )}
          {(liveLabel || retainedLabel) && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {liveLabel ? `Live ${liveLabel}` : ""}
              {liveLabel && retainedLabel ? " · " : ""}
              {retainedLabel ? `Retained ${retainedLabel}` : ""}
            </Text>
          )}
          <Button size="small" onClick={() => setOpen(true)}>
            Disk usage
          </Button>
        </Space>
      </HealthRow>
      <Modal
        open={open}
        title="Disk Usage"
        width={760}
        footer={null}
        onCancel={() => setOpen(false)}
        destroyOnHidden
      >
        <DiskUsage project_id={project_id} compact />
      </Modal>
    </>
  );
}
