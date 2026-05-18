/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { SyncOutlined } from "@ant-design/icons";
import { Space, Tag, Typography } from "antd";
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
  STATUS_COLOR,
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
import { HostOpProgress } from "./host-op-progress";
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
  borderRadius: 10,
  padding: 8,
  background: `linear-gradient(180deg, white 0%, ${COLORS.GRAY_LLL} 100%)`,
  boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)",
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const DETAIL_STYLE: CSSProperties = {
  borderTop: `1px solid ${COLORS.GRAY_LL}`,
  paddingTop: 6,
  marginTop: 4,
};

const COMPACT_TAG_STYLE: CSSProperties = {
  marginInlineEnd: 0,
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

function StatusTag({ host }: { host: Host }) {
  const label = statusLabel(host);
  const showSpinner = isHostTransitioning(host.status);
  return (
    <Tooltip
      title={getHostStatusTooltip(
        host.status,
        Boolean(host.deleted),
        host.provider_observed_at,
      )}
      placement="top"
    >
      <Tag
        color={host.deleted ? "default" : STATUS_COLOR[host.status]}
        style={{
          ...COMPACT_TAG_STYLE,
          fontWeight: 600,
          textTransform: "capitalize",
        }}
      >
        {showSpinner ? (
          <Space size={4}>
            <SyncOutlined spin />
            <span>{label}</span>
          </Space>
        ) : (
          label
        )}
      </Tag>
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

  return (
    <div style={CARD_STYLE}>
      <div style={HEADER_STYLE}>
        <StatusTag host={host} />
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
        <HostPlacementSummary
          host={host}
          compact
          detailMode="popover"
          showNormal
        />
      </Space>
      <div style={DETAIL_STYLE}>
        <Space orientation="vertical" size={4} style={{ width: "100%" }}>
          <HostOpProgress
            op={displayOp}
            compact
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
          <HostBootstrapProgress host={host} compact />
          <HostBootstrapLifecycle host={host} compact />
          <HostProjectStatus host={host} compact />
          <HostBackupStatus host={host} compact />
          <HostDaemonHealthSummary host={host} compact />
        </Space>
      </div>
    </div>
  );
}
