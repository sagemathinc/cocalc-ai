/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card, Progress, Space, Typography } from "antd";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { Icon, ProjectState, TimeAgo } from "@cocalc/frontend/components";
import {
  redux,
  useProjectMapField,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import type { SnapshotUsage } from "@cocalc/conat/files/file-server";
import type { ProjectInfo } from "@cocalc/conat/project/project-info";
import CopyButton from "@cocalc/frontend/components/copy-button";
import DiskUsage from "@cocalc/frontend/project/disk-usage/disk-usage";
import { linearList } from "@cocalc/frontend/project/info/utils";
import useDiskUsage from "@cocalc/frontend/project/disk-usage/use-disk-usage";
import useProjectInfo from "@cocalc/frontend/project/info/use-project-info";
import { useProjectRunQuota } from "@cocalc/frontend/project/use-project-run-quota";
import {
  ManagedEgressHistoryButton,
  ManagedEgressSparkline,
} from "@cocalc/frontend/purchases/managed-egress-history";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import { normalizeProjectStateForDisplay } from "@cocalc/frontend/projects/host-operational";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { BACKUPS } from "@cocalc/util/consts/backups";
import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";
import { Project } from "./types";
import { human_readable_size } from "@cocalc/util/misc";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import MoveProject from "./move-project";
import type { IconName } from "@cocalc/frontend/components/icon";
import { StartButton } from "@cocalc/frontend/project/start-button";
import { StopProject } from "./stop-project";

const { Text } = Typography;
const SMALL_ACTION_STYLE = { minWidth: 64 } as const;

function shortProjectId(project_id: string): string {
  return `${project_id.slice(0, 8)}...${project_id.slice(-4)}`;
}

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
  iconColor = UI_COLORS.secondary,
}: {
  icon: IconName;
  label: string;
  children: ReactNode;
  action?: ReactNode;
  iconColor?: string;
}) {
  return (
    <div
      style={{
        borderTop: `1px solid ${UI_COLORS.border}`,
        display: "grid",
        gap: 8,
        gridTemplateColumns: "22px minmax(0, 1fr) auto",
        alignItems: "center",
        lineHeight: 1.35,
        minWidth: 0,
        paddingTop: 6,
      }}
    >
      <Icon name={icon} style={{ color: iconColor }} />
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
  const projectLastBackup = useProjectMapField(project_id, "last_backup");
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
  const rawProjectState = `${(project as any).getIn(["state", "state"]) ?? ""}`;
  const lastBackup = projectLastBackup ?? (project as any).get("last_backup");
  const startTs = projectStatus?.get("start_ts");
  const userCount = (project as any).get("users")?.size;
  const projectInfo = useProjectInfo({
    project_id,
    intervalVisible: 10000,
    intervalHidden: 60000,
  });

  return (
    <Card
      style={{
        position: "sticky",
        top: 16,
        border: `1px solid ${UI_COLORS.border}`,
        boxShadow: "0 8px 28px rgba(15, 23, 42, 0.05)",
      }}
      styles={{ body: { padding: 12 } }}
    >
      <div
        style={{
          alignItems: "center",
          background: UI_COLORS.infoBg,
          border: `1px solid ${UI_COLORS.border}`,
          borderRadius: 10,
          display: "flex",
          gap: 8,
          justifyContent: "space-between",
          marginBottom: 10,
          padding: "8px 10px",
        }}
      >
        <Text strong>
          <Icon name="dashboard" /> Health
        </Text>
      </div>
      <Space vertical style={{ width: "100%" }} size={6}>
        <RuntimeHealthBlock
          displayProjectState={displayProjectState}
          displayStateValue={displayStateValue}
          project_id={project_id}
          rawProjectState={rawProjectState}
          startTs={startTs}
        />
        <RailRow
          icon="copy"
          label="Project ID"
          action={<CopyButton value={project_id} size="small" noText />}
        >
          <Text code style={{ fontSize: 12 }}>
            {shortProjectId(project_id)}
          </Text>
        </RailRow>
        <RecoveryHealthRow project_id={project_id} lastBackup={lastBackup} />
        <StorageHealthRow project_id={project_id} />
        <MemoryHealthRow
          info={projectInfo.info}
          project_id={project_id}
          running={rawProjectState === "running"}
        />
        <ProcessHealthRow
          disconnected={projectInfo.disconnected}
          info={projectInfo.info}
          project_id={project_id}
        />
        <NetworkHealthRow project_id={project_id} />
        {typeof userCount === "number" && (
          <RailRow
            icon="users"
            iconColor={UI_COLORS.secondary}
            label="People"
            action={
              <Button size="small" href="#people" style={SMALL_ACTION_STYLE}>
                Open
              </Button>
            }
          >
            <Text>
              {userCount} collaborator{userCount === 1 ? "" : "s"}
            </Text>
          </RailRow>
        )}
        {showNoInternetWarning && (
          <Alert
            type="warning"
            showIcon
            title="No internet access"
            description="This project currently has no internet access."
          />
        )}
      </Space>
    </Card>
  );
}

function RuntimeHealthBlock({
  displayProjectState,
  displayStateValue,
  project_id,
  rawProjectState,
  startTs,
}: {
  displayProjectState: any;
  displayStateValue?: string;
  project_id: string;
  rawProjectState: string;
  startTs?: number;
}) {
  return (
    <div
      style={{
        borderTop: `1px solid ${UI_COLORS.border}`,
        background: UI_COLORS.successBg,
        borderRadius: 10,
        display: "grid",
        gap: 8,
        gridTemplateColumns: "22px minmax(0, 1fr) auto",
        alignItems: "center",
        lineHeight: 1.35,
        minWidth: 0,
        padding: "8px 8px 7px",
      }}
    >
      <Icon name="server" style={{ color: UI_COLORS.success }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {displayProjectState ? (
            <ProjectState show_desc={false} state={displayProjectState} />
          ) : (
            <Text type="secondary">Unknown</Text>
          )}
          {typeof startTs === "number" && displayStateValue === "running" && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              <TimeAgo date={new Date(startTs)} />
            </Text>
          )}
        </div>
        <div style={{ marginTop: 4 }}>
          <MoveProject project_id={project_id} size="small" />
        </div>
      </div>
      <div style={{ justifySelf: "end" }}>
        {rawProjectState === "running" ? (
          <StopProject
            project_id={project_id}
            size="small"
            compact
            style={SMALL_ACTION_STYLE}
          />
        ) : (
          <StartButton
            project_id={project_id}
            size="small"
            minimal
            style={SMALL_ACTION_STYLE}
          />
        )}
      </div>
    </div>
  );
}

function openDirectory(project_id: string, path: string) {
  void redux.getProjectActions(project_id).open_directory(path, true, true);
}

function RecoveryHealthRow({
  project_id,
  lastBackup,
}: {
  project_id: string;
  lastBackup: unknown;
}) {
  const { loading, snapshot } = useLatestSnapshot(project_id);
  return (
    <RailRow icon="life-ring" iconColor={UI_COLORS.warning} label="Recovery">
      <Space vertical size={2} style={{ width: "100%" }}>
        <RecoveryLine
          action="Backup"
          onOpen={() => openDirectory(project_id, BACKUPS)}
          value={
            lastBackup ? (
              <TimeAgo date={lastBackup as any} />
            ) : (
              <Text type="secondary">none</Text>
            )
          }
        />
        <RecoveryLine
          action="Snap"
          onOpen={() => openDirectory(project_id, SNAPSHOTS)}
          value={
            snapshot ? (
              <TimeAgo date={snapshot.name as any} />
            ) : loading ? (
              <Text type="secondary">...</Text>
            ) : (
              <Text type="secondary">none</Text>
            )
          }
        />
      </Space>
    </RailRow>
  );
}

function RecoveryLine({
  action,
  onOpen,
  value,
}: {
  action: string;
  onOpen: () => void;
  value: ReactNode;
}) {
  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        gap: 6,
        justifyContent: "space-between",
      }}
    >
      <Text>{value}</Text>
      <Button size="small" onClick={onOpen} style={SMALL_ACTION_STYLE}>
        {action}
      </Button>
    </div>
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

function useLatestSnapshot(project_id: string): {
  loading: boolean;
  snapshot: SnapshotUsage | undefined;
} {
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

  return { loading, snapshot };
}

function ProcessHealthRow({
  disconnected,
  info,
  project_id,
}: {
  disconnected: boolean;
  info: ProjectInfo | null;
  project_id: string;
}) {
  const rows = info?.processes == null ? undefined : linearList(info.processes);

  if (disconnected && rows == null) {
    return (
      <RailRow
        icon="info-circle"
        iconColor={UI_COLORS.info}
        label="Processes"
        action={
          <Button
            size="small"
            onClick={() => openInfoPage(project_id)}
            style={SMALL_ACTION_STYLE}
          >
            Monitor
          </Button>
        }
      >
        <Text type="secondary">Unavailable</Text>
      </RailRow>
    );
  }

  const cpuPct =
    rows == null
      ? undefined
      : rows.reduce((total, process) => total + process.cpu_pct, 0);
  const memoryMiB =
    rows == null
      ? undefined
      : rows.reduce((total, process) => total + process.mem, 0);

  return (
    <RailRow
      icon="info-circle"
      iconColor={UI_COLORS.info}
      label="Processes"
      action={
        <Button
          size="small"
          onClick={() => openInfoPage(project_id)}
          style={SMALL_ACTION_STYLE}
        >
          Monitor
        </Button>
      }
    >
      <Space vertical size={0}>
        {cpuPct != null && memoryMiB != null && (
          <Text style={{ fontSize: 12, whiteSpace: "nowrap" }}>
            CPU {cpuPct.toFixed(1)}% · RAM {memoryMiB.toFixed(0)} MiB
          </Text>
        )}
      </Space>
    </RailRow>
  );
}

function formatMemoryMiB(value: number): string {
  if (value >= 1024) {
    return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)} GiB`;
  }
  return `${Math.round(value)} MiB`;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function MemoryHealthRow({
  info,
  project_id,
  running,
}: {
  info: ProjectInfo | null;
  project_id: string;
  running: boolean;
}) {
  const { runQuota } = useProjectRunQuota(project_id);
  const rows = info?.processes == null ? undefined : linearList(info.processes);
  const processMemoryMiB =
    rows == null
      ? undefined
      : rows.reduce((total, process) => total + process.mem, 0);
  const cgroupMemoryMiB = nonNegativeNumber(info?.cgroup?.mem_stat.total_rss);
  const tmpMemoryMiB = nonNegativeNumber(info?.disk_usage?.tmp?.usage) ?? 0;
  const usedMiB =
    cgroupMemoryMiB == null ? processMemoryMiB : cgroupMemoryMiB + tmpMemoryMiB;
  const configuredLimitMiB = positiveNumber(runQuota?.memory_limit);
  const runtimeLimitMiB = positiveNumber(
    info?.cgroup?.mem_stat.hierarchical_memory_limit,
  );
  const limitMiB = running
    ? (runtimeLimitMiB ?? configuredLimitMiB)
    : (configuredLimitMiB ?? runtimeLimitMiB);
  const percent =
    usedMiB != null && limitMiB != null
      ? Math.round((100 * usedMiB) / limitMiB)
      : undefined;

  return (
    <RailRow
      icon="microchip"
      iconColor={UI_COLORS.success}
      label="Memory"
      action={
        <Button
          size="small"
          onClick={() => openInfoPage(project_id)}
          style={SMALL_ACTION_STYLE}
        >
          Monitor
        </Button>
      }
    >
      {!running ? (
        <Text type="secondary">
          {limitMiB == null
            ? "Start project to monitor"
            : `${formatMemoryMiB(limitMiB)} limit`}
        </Text>
      ) : percent == null || usedMiB == null || limitMiB == null ? (
        <Text type="secondary">Loading...</Text>
      ) : (
        <Space vertical size={3} style={{ width: "100%" }}>
          <Text style={{ fontSize: 12, whiteSpace: "nowrap" }}>
            {percent}% used · {formatMemoryMiB(usedMiB)} /{" "}
            {formatMemoryMiB(limitMiB)}
          </Text>
          <Progress
            aria-label="Project memory usage"
            percent={Math.min(100, percent)}
            showInfo={false}
            size="small"
            status={percent > 90 ? "exception" : "normal"}
          />
        </Space>
      )}
    </RailRow>
  );
}

function StorageHealthRow({ project_id }: { project_id: string }) {
  const { quotas, loading } = useDiskUsage({ project_id });
  const quota = quotas[0];
  const percent =
    quota == null || quota.size <= 0
      ? undefined
      : Math.min(100, Math.round((100 * quota.used) / quota.size));
  const quotaLabel =
    quota == null || quota.size <= 0
      ? undefined
      : `${percent}% used · ${human_readable_size(quota.used)} / ${human_readable_size(quota.size)}`;

  return (
    <RailRow
      icon="disk-round"
      iconColor={UI_COLORS.info}
      label="Storage"
      action={
        <DiskUsage
          project_id={project_id}
          compact
          buttonText="Details"
          buttonSize="small"
          style={SMALL_ACTION_STYLE}
        />
      }
    >
      <Space vertical size={3} style={{ width: "100%" }}>
        {quotaLabel ? (
          <>
            <Text>{quotaLabel}</Text>
            <Progress
              aria-label="Project storage usage"
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
      </Space>
    </RailRow>
  );
}

function openInfoPage(project_id: string) {
  redux.getProjectActions(project_id).set_active_tab("info");
}

function NetworkHealthRow({ project_id }: { project_id: string }) {
  return (
    <RailRow
      icon="network"
      iconColor={UI_COLORS.info}
      label="Network"
      action={
        <ManagedEgressHistoryButton
          project_id={project_id}
          buttonText="Egress"
          size="small"
          style={SMALL_ACTION_STYLE}
        />
      }
    >
      <ManagedEgressSparkline project_id={project_id} height={20} />
    </RailRow>
  );
}
