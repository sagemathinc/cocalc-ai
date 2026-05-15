/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Card, Progress, Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";

import {
  CopyToClipBoard,
  Icon,
  ProjectState,
  TimeAgo,
} from "@cocalc/frontend/components";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import {
  hostLabel,
  normalizeProjectStateForDisplay,
} from "@cocalc/frontend/projects/host-operational";
import { COLORS } from "@cocalc/util/theme";
import { Project } from "./types";
import { useCurrentUsage, useRunQuota } from "./run-quota/hooks";

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

function usagePercent(display?: string): number | undefined {
  const match = `${display ?? ""}`.match(/\((?:>|~)?([0-9.]+)%\)/);
  if (!match?.[1]) return;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
}

function UsageLine({ label, usage }: { label: string; usage?: any }) {
  if (!usage?.display) return null;
  const percent = usagePercent(usage.display);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <Text type="secondary">{label}</Text>
        <Text style={{ fontSize: 12 }}>{usage.display}</Text>
      </div>
      {percent != null && (
        <Progress
          percent={percent}
          showInfo={false}
          size="small"
          strokeColor={percent > 90 ? COLORS.BS_RED : COLORS.BS_GREEN_D}
        />
      )}
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
  const currentUsage = useCurrentUsage({ project_id, shortStr: true });
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
        {lastBackup && (
          <HealthRow label="Last backup">
            <TimeAgo date={lastBackup as any} />
          </HealthRow>
        )}
        <div>
          <UsageLine label="CPU" usage={(currentUsage as any).cores} />
          <UsageLine label="Memory" usage={(currentUsage as any).memory} />
          <UsageLine label="Disk" usage={(currentUsage as any).disk_quota} />
        </div>
        <HealthRow label="Network">
          {runQuota.network == null ? (
            <Tag>Unknown</Tag>
          ) : (
            <Tag color={runQuota.network ? "green" : "warning"}>
              {runQuota.network ? "Enabled" : "Disabled"}
            </Tag>
          )}
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
