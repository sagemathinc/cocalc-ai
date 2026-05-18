/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  CheckCircleFilled,
  CloudOutlined,
  DatabaseOutlined,
  DownOutlined,
  ExclamationCircleFilled,
  SettingOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import { Button, Popover, Progress, Space, Tag, Typography } from "antd";
import type { CSSProperties } from "react";
import type { Host } from "@cocalc/conat/hub/api/hosts";
import {
  currentProjectHostAutomaticRollback,
  currentProjectHostRolloutPhase,
  projectHostRollbackReasonLabel,
  shouldSuppressProjectHostFailedOp,
} from "@cocalc/conat/project-host/rollout";
import { Tooltip } from "@cocalc/frontend/components";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { React } from "@cocalc/frontend/app-framework";
import { COLORS } from "@cocalc/util/theme";
import {
  getHostOnlineTooltip,
  getHostStatusTooltip,
  isHostOnline,
  isHostTransitioning,
} from "../constants";
import { HostPlacementSummary } from "../pressure-ui";
import { isSpotStandardFallbackHost } from "../spot-ui";
import type { HostLroState } from "../hooks/use-host-ops";
import { HostBackupStatus } from "./host-backup-status";
import { HostBillingEnforcementStatus } from "./host-billing-enforcement";
import { HostBootstrapLifecycle } from "./host-bootstrap-lifecycle";
import { HostBootstrapProgress } from "./host-bootstrap-progress";
import { HostDaemonHealthSummary } from "./host-daemon-health-summary";
import {
  getHostOpLabel,
  getHostOpPhase,
  HostOpProgress,
} from "./host-op-progress";
import { HostProjectStatus } from "./host-project-status";
import {
  currentHostRuntimeExceptionSummary,
  hostRuntimeExceptionDescription,
  hostRuntimeExceptionLabel,
} from "../utils/runtime-exceptions";

const CARD_STYLE: CSSProperties = {
  minWidth: 280,
  maxWidth: 360,
  border: `1px solid ${COLORS.GRAY_LL}`,
  borderRadius: 12,
  padding: 10,
  background: "white",
  boxShadow: "0 1px 4px rgba(0, 0, 0, 0.05)",
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const COMPACT_TAG_STYLE: CSSProperties = {
  marginInlineEnd: 0,
};

type Tone = "green" | "blue" | "orange" | "red" | "gray";

const TONE_COLORS: Record<
  Tone,
  { text: string; background: string; border: string }
> = {
  green: {
    text: COLORS.ANTD_GREEN_D,
    background: COLORS.BS_GREEN_LL,
    border: COLORS.ANTD_GREEN,
  },
  blue: {
    text: COLORS.ANTD_LINK_BLUE,
    background: COLORS.BLUE_LLLL,
    border: COLORS.BLUE_LLL,
  },
  orange: {
    text: COLORS.YELL_D,
    background: COLORS.YELL_LLL,
    border: COLORS.YELL_LL,
  },
  red: {
    text: COLORS.FG_RED,
    background: COLORS.ANTD_BG_RED_L,
    border: COLORS.ANTD_BG_RED_M,
  },
  gray: {
    text: COLORS.GRAY_M,
    background: COLORS.GRAY_LLL,
    border: COLORS.GRAY_L0,
  },
};

function statusLabel(host: Host): string {
  if (host.deleted) return "deleted";
  return host.status ?? "unknown";
}

function connectionLabel(host: Host): React.ReactNode {
  if (host.status !== "running") {
    if (!host.provider_observed_at) return null;
    return (
      <>
        cloud <TimeAgo date={host.provider_observed_at} />
      </>
    );
  }
  if (!host.last_seen) return "no heartbeat";
  return (
    <>
      seen <TimeAgo date={host.last_seen} />
    </>
  );
}

function ConnectionTag({ host }: { host: Host }) {
  if (host.status !== "running") return null;
  const online = isHostOnline(host.last_seen);
  return (
    <Tooltip title={getHostOnlineTooltip(host.last_seen)}>
      <Tag color={online ? "green" : "orange"} style={COMPACT_TAG_STYLE}>
        {online ? "online" : "offline"}
      </Tag>
    </Tooltip>
  );
}

function statusTone(host: Host): Tone {
  if (host.deleted) return "gray";
  if (host.status === "running") return "green";
  if (host.status === "error") return "red";
  if (isHostTransitioning(host.status)) return "blue";
  if (host.status === "draining") return "orange";
  return "gray";
}

function statusIcon(host: Host): React.ReactNode {
  if (host.status === "error") return <ExclamationCircleFilled />;
  if (isHostTransitioning(host.status)) return <SyncOutlined spin />;
  if (host.status === "running") return <CheckCircleFilled />;
  return <CloudOutlined />;
}

function StatusHero({ host }: { host: Host }) {
  const label = statusLabel(host);
  const tone = statusTone(host);
  const colors = TONE_COLORS[tone];
  return (
    <Tooltip
      title={getHostStatusTooltip(
        host.status,
        Boolean(host.deleted),
        host.provider_observed_at,
      )}
      placement="top"
    >
      <Space
        size={8}
        style={{
          minWidth: 0,
        }}
      >
        <span
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: colors.text,
            background: colors.background,
            border: `1px solid ${colors.border}`,
            flex: "0 0 auto",
          }}
        >
          {statusIcon(host)}
        </span>
        <Typography.Text
          strong
          style={{
            color: colors.text,
            fontSize: 15,
            textTransform: "capitalize",
          }}
        >
          {label}
        </Typography.Text>
      </Space>
    </Tooltip>
  );
}

function RuntimeExceptionTag({ host }: { host: Host }) {
  const summary = currentHostRuntimeExceptionSummary(host);
  if (!summary) return null;
  return (
    <Tooltip title={hostRuntimeExceptionDescription(summary)}>
      <Tag color="blue" style={COMPACT_TAG_STYLE}>
        {hostRuntimeExceptionLabel(summary)}
      </Tag>
    </Tooltip>
  );
}

function SpotFallbackTag({ host }: { host: Host }) {
  if (!isSpotStandardFallbackHost(host)) return null;
  return (
    <Tooltip title="This host wants spot pricing but is temporarily running as a standard VM under its spot recovery policy.">
      <Tag color="orange" style={COMPACT_TAG_STYLE}>
        standard fallback
      </Tag>
    </Tooltip>
  );
}

function placementSummary(host: Host): { value: string; tone: Tone } {
  if (host.can_place === false) return { value: "Blocked", tone: "red" };
  const zone = host.pressure?.zone;
  if (zone === "emergency") return { value: "Emergency", tone: "red" };
  if (zone === "pressure") return { value: "Pressure", tone: "orange" };
  if (zone === "observe") return { value: "Observe", tone: "orange" };
  return { value: "Normal", tone: "green" };
}

function softwareSummary(host: Host): { value: string; tone: Tone } {
  const lifecycle = host.bootstrap_lifecycle;
  if (!lifecycle) return { value: "Unknown", tone: "gray" };
  switch (lifecycle.summary_status) {
    case "in_sync":
      return { value: "Up to date", tone: "green" };
    case "reconciling":
      return { value: "Reconciling", tone: "blue" };
    case "drifted":
      return {
        value: lifecycle.drift_count
          ? `${lifecycle.drift_count} drift`
          : "Drift",
        tone: "orange",
      };
    case "error":
      return { value: "Error", tone: "red" };
    default:
      return { value: "Unknown", tone: "gray" };
  }
}

function backupSummary(host: Host): { value: string; tone: Tone } {
  const status = host.backup_status;
  if (!status || !status.total) return { value: "No projects", tone: "gray" };
  const provisioned = status.provisioned ?? 0;
  const upToDate = status.provisioned_up_to_date ?? 0;
  const needs = (status.provisioned_needs_backup ?? 0) + (status.running ?? 0);
  if (!provisioned) return { value: `${status.total} assigned`, tone: "gray" };
  return {
    value: `${upToDate}/${provisioned}`,
    tone: needs > 0 ? "orange" : upToDate >= provisioned ? "green" : "gray",
  };
}

function daemonSummary(host: Host): { value: string; tone: Tone } {
  const components = host.observed_components ?? [];
  if (!components.length) return { value: "Unknown", tone: "gray" };
  const hasRuntimeIssue = components.some(
    (entry) =>
      entry.runtime_state !== "running" && entry.runtime_state !== "disabled",
  );
  if (hasRuntimeIssue) return { value: "Issue", tone: "red" };
  const hasDrift = components.some(
    (entry) =>
      entry.version_state === "drifted" || entry.version_state === "mixed",
  );
  if (hasDrift) return { value: "Drift", tone: "orange" };
  return { value: "OK", tone: "green" };
}

function SummaryRow({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: Tone;
}) {
  const colors = TONE_COLORS[tone];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "18px 1fr auto 8px",
        gap: 8,
        alignItems: "center",
        minHeight: 24,
      }}
    >
      <span style={{ color: COLORS.ANTD_LINK_BLUE, fontSize: 16 }}>{icon}</span>
      <Typography.Text style={{ fontSize: 12 }}>{label}</Typography.Text>
      <Typography.Text
        type="secondary"
        style={{
          fontSize: 12,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </Typography.Text>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 7,
          background: colors.text,
        }}
      />
    </div>
  );
}

function activeOpPercent(op: HostLroState): number | undefined {
  const progress = op.last_progress?.progress;
  if (progress == null) return undefined;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

function ActiveOperation({
  op,
  displayPhaseLabel,
}: {
  op?: HostLroState;
  displayPhaseLabel?: string;
  displayPhaseOwner?: string;
  displayDeadlineAt?: string;
}) {
  if (!op) return null;
  const status = op.summary?.status ?? "queued";
  if (status !== "failed" && status !== "queued" && status !== "running") {
    return null;
  }
  const failed = status === "failed";
  const percent = activeOpPercent(op);
  const label = getHostOpLabel(op);
  const phase = displayPhaseLabel ?? getHostOpPhase(op);
  const tone = failed ? TONE_COLORS.red : TONE_COLORS.blue;
  return (
    <div
      style={{
        border: `1px solid ${tone.border}`,
        background: tone.background,
        borderRadius: 8,
        padding: "7px 8px",
        marginTop: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          alignItems: "center",
          marginBottom: failed ? 0 : 4,
        }}
      >
        <Space size={6}>
          {failed ? <ExclamationCircleFilled /> : <SyncOutlined spin />}
          <Typography.Text strong style={{ color: tone.text, fontSize: 12 }}>
            {label}
            {phase ? `: ${phase}` : ""}
          </Typography.Text>
        </Space>
        {percent != null && !failed ? (
          <Typography.Text style={{ color: tone.text, fontSize: 12 }}>
            {percent}%
          </Typography.Text>
        ) : null}
      </div>
      {!failed ? (
        <Progress
          percent={percent ?? 30}
          showInfo={false}
          size="small"
          status={percent == null ? "active" : "normal"}
        />
      ) : null}
    </div>
  );
}

function DetailsPopover({
  host,
  op,
  displayPhaseLabel,
  displayPhaseOwner,
  displayDeadlineAt,
}: {
  host: Host;
  op?: HostLroState;
  displayPhaseLabel?: string;
  displayPhaseOwner?: string;
  displayDeadlineAt?: string;
}) {
  return (
    <Popover
      trigger="click"
      title="Host status details"
      content={
        <Space
          orientation="vertical"
          size={8}
          style={{ width: 520, maxWidth: "70vw" }}
        >
          <HostPlacementSummary
            host={host}
            compact
            detailMode="popover"
            showNormal
          />
          <HostOpProgress
            op={op}
            compact
            displayPhaseLabel={displayPhaseLabel}
            displayPhaseOwner={displayPhaseOwner}
            displayDeadlineAt={displayDeadlineAt}
          />
          <HostBillingEnforcementStatus host={host} compact />
          <HostBootstrapProgress host={host} compact />
          <HostBootstrapLifecycle host={host} compact detailed />
          <HostProjectStatus host={host} compact fontSize={12} />
          <HostBackupStatus host={host} />
          <HostDaemonHealthSummary host={host} compact />
        </Space>
      }
    >
      <Button size="small" type="link" style={{ padding: 0, height: "auto" }}>
        Details <DownOutlined />
      </Button>
    </Popover>
  );
}

export function HostStatusSummary({
  host,
  op,
}: {
  host: Host;
  op?: HostLroState;
}) {
  const displayOp = shouldSuppressProjectHostFailedOp({
    op,
    currentVersion: host.version,
    observation: host.observed_host_agent?.project_host,
  })
    ? undefined
    : op;
  const projectHostRolloutPhase = currentProjectHostRolloutPhase({
    op: displayOp,
    currentVersion: host.version,
    observation: host.observed_host_agent?.project_host,
  });
  const projectHostRollback = currentProjectHostAutomaticRollback({
    observation: host.observed_host_agent?.project_host,
    currentVersion: host.version,
  });
  const connection = connectionLabel(host);
  const placement = placementSummary(host);
  const software = softwareSummary(host);
  const backups = backupSummary(host);
  const daemons = daemonSummary(host);

  return (
    <div style={CARD_STYLE}>
      <div style={HEADER_STYLE}>
        <StatusHero host={host} />
        {connection ? (
          <Typography.Text
            type="secondary"
            style={{
              fontSize: 11,
              whiteSpace: "nowrap",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {connection}
          </Typography.Text>
        ) : null}
      </div>
      <Space
        size={[4, 4]}
        wrap
        style={{ width: "100%", marginTop: 6, alignItems: "center" }}
      >
        <ConnectionTag host={host} />
        <SpotFallbackTag host={host} />
        <RuntimeExceptionTag host={host} />
      </Space>
      <ActiveOperation
        op={displayOp}
        displayPhaseLabel={projectHostRolloutPhase?.label}
        displayPhaseOwner={projectHostRolloutPhase?.owner}
        displayDeadlineAt={projectHostRolloutPhase?.deadlineAt}
      />
      <HostBillingEnforcementStatus host={host} compact />
      {projectHostRollback && (
        <Tooltip
          title={`Project-host rollout to ${
            projectHostRollback.target_version
          } was rolled back to ${projectHostRollback.rollback_version}${
            projectHostRollback.finished_at
              ? ` on ${new Date(projectHostRollback.finished_at).toLocaleString()}`
              : ""
          } because ${projectHostRollbackReasonLabel(
            projectHostRollback.reason,
          )}.`}
        >
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            Project-host auto-rolled back to{" "}
            <code>{projectHostRollback.rollback_version}</code>
          </Typography.Text>
        </Tooltip>
      )}
      <Space
        orientation="vertical"
        size={3}
        style={{
          width: "100%",
          borderTop: `1px solid ${COLORS.GRAY_LL}`,
          marginTop: 8,
          paddingTop: 8,
        }}
      >
        <SummaryRow
          icon={<CloudOutlined />}
          label="Placement"
          value={placement.value}
          tone={placement.tone}
        />
        <SummaryRow
          icon={<SettingOutlined />}
          label="Software"
          value={software.value}
          tone={software.tone}
        />
        <SummaryRow
          icon={<DatabaseOutlined />}
          label="Backups"
          value={backups.value}
          tone={backups.tone}
        />
        <SummaryRow
          icon={<SettingOutlined />}
          label="Daemons"
          value={daemons.value}
          tone={daemons.tone}
        />
      </Space>
      <div
        style={{
          borderTop: `1px solid ${COLORS.GRAY_LL}`,
          marginTop: 8,
          paddingTop: 5,
          textAlign: "center",
        }}
      >
        <DetailsPopover
          host={host}
          op={displayOp}
          displayPhaseLabel={projectHostRolloutPhase?.label}
          displayPhaseOwner={projectHostRolloutPhase?.owner}
          displayDeadlineAt={projectHostRolloutPhase?.deadlineAt}
        />
      </div>
    </div>
  );
}
