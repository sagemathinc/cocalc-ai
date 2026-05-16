/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card, Progress, Space, Typography } from "antd";
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
import { ManagedEgressHistoryButton } from "@cocalc/frontend/purchases/managed-egress-history";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import { normalizeProjectStateForDisplay } from "@cocalc/frontend/projects/host-operational";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { BACKUPS } from "@cocalc/util/consts/backups";
import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";
import { Project } from "./types";
import { human_readable_size } from "@cocalc/util/misc";
import { useRunQuota } from "./run-quota/hooks";
import MoveProject from "./move-project";
import type { IconName } from "@cocalc/frontend/components/icon";

const { Text } = Typography;

interface Props {
  project_id: string;
  project: Project;
  showNoInternetWarning?: boolean;
  showNonMemberWarning?: boolean;
}

function RailRow({
  icon,
  label,
  children,
  action,
}: {
  icon: IconName;
  label: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        borderTop: "1px solid #edf2f7",
        display: "grid",
        gap: 8,
        gridTemplateColumns: "22px minmax(0, 1fr) auto",
        alignItems: "center",
        lineHeight: 1.35,
        minWidth: 0,
        paddingTop: 8,
      }}
    >
      <Icon name={icon} style={{ color: "#6b7280" }} />
      <div style={{ minWidth: 0 }}>
        <div>
          <Text type="secondary" style={{ fontSize: 12, fontWeight: 600 }}>
            {label}
          </Text>
        </div>
        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
      {action ? <div style={{ justifySelf: "end" }}>{action}</div> : null}
    </div>
  );
}

export function ProjectSettingsHealthRail({
  project_id,
  project,
  showNoInternetWarning,
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
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <Icon name="dashboard" />
        <Text strong style={{ fontSize: 16 }}>
          Project Health
        </Text>
      </div>
      <Space direction="vertical" style={{ width: "100%" }} size={10}>
        <RailRow icon="heart" label="State">
          {displayProjectState ? (
            <>
              <ProjectState show_desc={false} state={displayProjectState} />
              {typeof startTs === "number" &&
                displayStateValue === "running" && (
                  <Text
                    type="secondary"
                    style={{ fontSize: 12, marginLeft: 8 }}
                  >
                    <TimeAgo date={new Date(startTs)} />
                  </Text>
                )}
            </>
          ) : (
            <Text type="secondary">Unknown</Text>
          )}
        </RailRow>
        <RailRow
          icon="server"
          label="Host"
          action={<MoveProject project_id={project_id} size="small" />}
        >
          <Text type="secondary" style={{ fontSize: 12 }}>
            Details and move
          </Text>
        </RailRow>
        <RailRow icon="copy" label="Project ID">
          <CopyToClipBoard
            value={project_id}
            display={project_id}
            size="small"
            inputWidth="100%"
            style={{ display: "block", width: "100%" }}
          />
        </RailRow>
        {typeof userCount === "number" && (
          <RailRow
            icon="users"
            label="People"
            action={
              <Button size="small" type="link" href="#people">
                Open
              </Button>
            }
          >
            <Text>
              {userCount} collaborator{userCount === 1 ? "" : "s"}
            </Text>
          </RailRow>
        )}
        <BackupHealthRow project_id={project_id} lastBackup={lastBackup} />
        <SnapshotHealthRow project_id={project_id} />
        <StorageHealthRow project_id={project_id} />
        <ProcessHealthRow project_id={project_id} />
        <NetworkHealthRow
          project_id={project_id}
          networkEnabled={
            runQuota.network == null ? undefined : !!runQuota.network
          }
        />
        {showNoInternetWarning && (
          <Alert
            type="warning"
            showIcon
            message="No internet access"
            description="This project currently has no internet access."
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
    <RailRow
      icon="cloud-upload"
      label="Backup"
      action={
        <Button size="small" onClick={() => openDirectory(project_id, BACKUPS)}>
          Open
        </Button>
      }
    >
      {lastBackup ? (
        <TimeAgo date={lastBackup as any} />
      ) : (
        <Text type="secondary">None recorded</Text>
      )}
    </RailRow>
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
    <RailRow
      icon="disk-snapshot"
      label="Snapshot"
      action={
        <Button
          size="small"
          onClick={() => openDirectory(project_id, SNAPSHOTS)}
        >
          Open
        </Button>
      }
    >
      {snapshot ? (
        <TimeAgo date={snapshot.name as any} />
      ) : loading ? (
        <Text type="secondary">Loading...</Text>
      ) : (
        <Text type="secondary">None found</Text>
      )}
    </RailRow>
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
      <RailRow
        icon="info-circle"
        label="Processes"
        action={
          <Button size="small" onClick={() => openInfoPage(project_id)}>
            Monitor
          </Button>
        }
      >
        <Text type="secondary">Unavailable</Text>
      </RailRow>
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
    <RailRow
      icon="info-circle"
      label="Processes"
      action={
        <Button size="small" onClick={() => openInfoPage(project_id)}>
          Monitor
        </Button>
      }
    >
      <Space direction="vertical" size={0}>
        <Text>
          {processCount} process{processCount === 1 ? "" : "es"}
        </Text>
        {cpuPct != null && memoryBytes != null && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            CPU {cpuPct.toFixed(1)}% · Memory {human_readable_size(memoryBytes)}
          </Text>
        )}
      </Space>
    </RailRow>
  );
}

function StorageHealthRow({ project_id }: { project_id: string }) {
  const { quotas, live, retained, loading } = useDiskUsage({ project_id });
  const quota = quotas[0];
  const percent =
    quota == null || quota.size <= 0
      ? undefined
      : Math.min(100, Math.round((100 * quota.used) / quota.size));
  const quotaLabel =
    quota == null || quota.size <= 0
      ? undefined
      : `${human_readable_size(quota.used)} / ${human_readable_size(quota.size)}`;
  const liveLabel = live ? human_readable_size(live.bytes) : undefined;
  const retainedLabel = retained
    ? human_readable_size(retained.bytes)
    : undefined;

  return (
    <RailRow
      icon="disk-round"
      label="Storage"
      action={
        <DiskUsage
          project_id={project_id}
          compact
          buttonText="Details"
          buttonSize="small"
        />
      }
    >
      <Space direction="vertical" size={3} style={{ width: "100%" }}>
        {quotaLabel ? (
          <>
            <Text>{quotaLabel}</Text>
            <Progress
              percent={percent}
              showInfo={false}
              size="small"
              status={percent != null && percent > 90 ? "exception" : "normal"}
            />
          </>
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
      </Space>
    </RailRow>
  );
}

function openInfoPage(project_id: string) {
  redux.getProjectActions(project_id).set_active_tab("info");
}

function NetworkHealthRow({
  project_id,
  networkEnabled,
}: {
  project_id: string;
  networkEnabled: boolean | null | undefined;
}) {
  const activityBars = [30, 58, 38, 72, 46, 88, 54];
  return (
    <RailRow
      icon="network"
      label="Network"
      action={
        <ManagedEgressHistoryButton
          project_id={project_id}
          buttonText="Egress"
          size="small"
        />
      }
    >
      <Space direction="vertical" size={3} style={{ width: "100%" }}>
        <div style={{ display: "flex", alignItems: "end", gap: 3, height: 22 }}>
          {activityBars.map((height, i) => (
            <div
              key={i}
              style={{
                background: networkEnabled === false ? "#d9d9d9" : "#1677ff",
                borderRadius: 2,
                height: `${height}%`,
                opacity: 0.35 + i * 0.07,
                width: 8,
              }}
            />
          ))}
        </div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {networkEnabled == null
            ? "Internet unknown"
            : networkEnabled
              ? "Internet enabled"
              : "Internet disabled"}
        </Text>
      </Space>
    </RailRow>
  );
}
