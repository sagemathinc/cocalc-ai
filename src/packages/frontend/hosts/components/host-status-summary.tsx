/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloudOutlined,
  CodeOutlined,
  DatabaseOutlined,
  DownOutlined,
  ExclamationCircleFilled,
  FolderOutlined,
  InfoCircleOutlined,
  SettingOutlined,
  SyncOutlined,
  WifiOutlined,
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
import { COCALC_CLI_DOWNLOAD_URL } from "@cocalc/util/consts/ui";
import { COLORS } from "@cocalc/util/theme";
import {
  getHostOnlineTooltip,
  getHostStatusTooltip,
  isHostOnline,
  isHostTransitioning,
} from "../constants";
import { isSpotStandardFallbackHost } from "../spot-ui";
import type { HostLroState } from "../hooks/use-host-ops";
import { HostBillingEnforcementStatus } from "./host-billing-enforcement";
import { HostBootstrapProgress } from "./host-bootstrap-progress";
import {
  getHostOpLabel,
  getHostOpPhase,
  HostOpProgress,
} from "./host-op-progress";
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
  if (host.status === "off" && !host.provider_instance_id) {
    return "not provisioned";
  }
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

function formatPlacementZone(zone?: string): string {
  switch (zone) {
    case "emergency":
      return "Emergency";
    case "pressure":
      return "Pressure";
    case "observe":
      return "Observe";
    case "normal":
    case undefined:
      return "Normal";
    default:
      return humanizeReason(zone);
  }
}

function humanizeReason(reason?: string | null): string {
  if (!reason) return "Normal placement candidate";
  const normalized = reason.trim().toLowerCase();
  switch (normalized) {
    case "memory_ok":
      return "Memory is within placement limits";
    case "cpu_ok":
      return "CPU is within placement limits";
    case "disk_ok":
      return "Disk is within placement limits";
    case "pressure_ok":
      return "Placement pressure is normal";
    default:
      return reason
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map((part) =>
          part.toLowerCase() === "ok"
            ? "OK"
            : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
        )
        .join(" ");
  }
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

function TimeAgoOrNA({ date }: { date?: string }) {
  if (!date) return <>n/a</>;
  const ts = Date.parse(date);
  if (Number.isNaN(ts)) return <>invalid</>;
  return <TimeAgo date={date} />;
}

function detailValueColor(tone?: Tone): string | undefined {
  return tone ? TONE_COLORS[tone].text : undefined;
}

function StatusDot({ tone }: { tone: Tone }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: 8,
        background: TONE_COLORS[tone].text,
        display: "inline-block",
      }}
    />
  );
}

function DetailRow({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "18px minmax(120px, 1fr) minmax(120px, auto) 10px",
        gap: 8,
        alignItems: "center",
        minHeight: 27,
      }}
    >
      <span style={{ color: COLORS.ANTD_LINK_BLUE, fontSize: 15 }}>{icon}</span>
      <Typography.Text style={{ fontSize: 13 }}>{label}</Typography.Text>
      <Typography.Text
        style={{
          color: detailValueColor(tone),
          fontSize: 13,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </Typography.Text>
      {tone ? <StatusDot tone={tone} /> : <span />}
    </div>
  );
}

function DetailSection({
  title,
  description,
  icon,
  children,
  footer,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: 10,
        background: "white",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "12px 14px 8px" }}>
        <Space size={7} align="start">
          <span style={{ color: COLORS.ANTD_LINK_BLUE, marginTop: 2 }}>
            {icon}
          </span>
          <span>
            <Typography.Text strong style={{ fontSize: 15 }}>
              {title}
            </Typography.Text>
            <Typography.Paragraph
              type="secondary"
              style={{ margin: 0, fontSize: 12 }}
            >
              {description}
            </Typography.Paragraph>
          </span>
        </Space>
        <div style={{ marginTop: 8 }}>{children}</div>
      </div>
      {footer ? (
        <div
          style={{
            borderTop: `1px solid ${COLORS.GRAY_LL}`,
            background: COLORS.GRAY_LLL,
            padding: "6px 14px",
            textAlign: "center",
          }}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}

function detailsGridStyle(): CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: 12,
  };
}

function operationStatus(op?: HostLroState): {
  active: boolean;
  failed: boolean;
  percent?: number;
  label: string;
  phase?: string;
  tone: Tone;
} {
  if (!op) {
    return {
      active: false,
      failed: false,
      label: "No active operations",
      tone: "green",
    };
  }
  const status = op.summary?.status ?? "queued";
  const failed = status === "failed";
  const active = status === "queued" || status === "running";
  if (!active && !failed) {
    return {
      active: false,
      failed: false,
      label: "No active operations",
      tone: "green",
    };
  }
  return {
    active,
    failed,
    percent: activeOpPercent(op),
    label: getHostOpLabel(op),
    phase: getHostOpPhase(op),
    tone: failed ? "red" : "blue",
  };
}

function shouldDisplayHostOperation(op?: HostLroState): boolean {
  if (!op) return false;
  const status = op.summary?.status;
  if (status === "queued" || status === "running" || status === "failed") {
    return true;
  }
  if (status) {
    return false;
  }
  const phase = getHostOpPhase(op)?.trim().toLowerCase();
  if (phase?.includes("done") || phase?.includes("complete")) {
    return false;
  }
  return true;
}

function projectCounts(host: Host): {
  assigned: number;
  provisioned: number;
  running: number;
} {
  const status = host.backup_status;
  return {
    assigned: status?.total ?? host.projects ?? 0,
    provisioned: status?.provisioned ?? 0,
    running: status?.running ?? 0,
  };
}

type ObservedComponent = NonNullable<Host["observed_components"]>[number];

function componentTone(component: ObservedComponent): Tone {
  if (
    component.runtime_state !== "running" &&
    component.runtime_state !== "disabled"
  ) {
    return "red";
  }
  if (
    component.version_state === "drifted" ||
    component.version_state === "mixed"
  ) {
    return "orange";
  }
  if (component.runtime_state === "disabled") return "gray";
  return "green";
}

function componentLabel(component: string): string {
  switch (component) {
    case "project-host":
      return "host";
    case "conat-router":
      return "router";
    case "conat-persist":
      return "persist";
    case "acp-worker":
      return "acp";
    default:
      return component;
  }
}

function daemonTags(host: Host) {
  const components = host.observed_components ?? [];
  if (!components.length) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        No host-reported daemon status yet.
      </Typography.Text>
    );
  }
  return (
    <Space size={[6, 6]} wrap>
      {components.map((component) => {
        const tone = componentTone(component);
        return (
          <Tooltip
            key={component.component}
            title={`${component.component}: ${component.runtime_state}, ${component.version_state}`}
          >
            <Tag
              style={{
                marginInlineEnd: 0,
                borderColor: TONE_COLORS[tone].border,
                background: TONE_COLORS[tone].background,
                color: TONE_COLORS[tone].text,
              }}
            >
              <StatusDot tone={tone} /> {componentLabel(component.component)}
            </Tag>
          </Tooltip>
        );
      })}
    </Space>
  );
}

function SoftwareLifecycleDetails({ host }: { host: Host }) {
  const lifecycle = host.bootstrap_lifecycle;
  if (!lifecycle) {
    return (
      <Typography.Text type="secondary">
        No software lifecycle report yet.
      </Typography.Text>
    );
  }
  const interestingItems = lifecycle.items.filter(
    (item) => item.status === "drift" || item.status === "missing",
  );
  const items = interestingItems.length
    ? interestingItems
    : lifecycle.items.slice(0, 6);
  return (
    <Space orientation="vertical" size={8} style={{ width: "100%" }}>
      <Typography.Text type="secondary">
        {lifecycle.summary_message ||
          "Software lifecycle state reported by the host."}
      </Typography.Text>
      {items.map((item) => {
        const tone: Tone =
          item.status === "drift"
            ? "orange"
            : item.status === "missing"
              ? "red"
              : "green";
        return (
          <div
            key={item.key}
            style={{
              border: `1px solid ${TONE_COLORS[tone].border}`,
              background: TONE_COLORS[tone].background,
              borderRadius: 8,
              padding: 8,
            }}
          >
            <Space orientation="vertical" size={2} style={{ width: "100%" }}>
              <Space size={8} wrap>
                <StatusDot tone={tone} />
                <Typography.Text strong>{item.label}</Typography.Text>
                <Typography.Text type="secondary">
                  {humanizeReason(item.status)}
                </Typography.Text>
              </Space>
              <Typography.Text style={{ fontSize: 12 }}>
                Desired <code>{String(item.desired ?? "n/a")}</code> · installed{" "}
                <code>{String(item.installed ?? "n/a")}</code>
              </Typography.Text>
              {item.message ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {item.message}
                </Typography.Text>
              ) : null}
            </Space>
          </div>
        );
      })}
      {!interestingItems.length && lifecycle.items.length > items.length ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Showing the first {items.length} lifecycle checks.
        </Typography.Text>
      ) : null}
    </Space>
  );
}

function cliCommands(host: Host): string[] {
  return [
    `cocalc host deploy status ${host.id}`,
    `cocalc host deploy status ${host.id} --component project-host --component conat-router --component conat-persist --component acp-worker`,
    `cocalc host logs ${host.id} --tail 200`,
  ];
}

function CliPopover({ host }: { host: Host }) {
  return (
    <Popover
      trigger="click"
      title="Host CLI diagnostics"
      content={
        <div style={{ maxWidth: 560 }}>
          <Typography.Paragraph style={{ marginBottom: 8 }}>
            Use these commands from a shell with the hub environment loaded.
            Install the{" "}
            <Typography.Link
              href={COCALC_CLI_DOWNLOAD_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              CoCalc CLI
            </Typography.Link>{" "}
            if the <code>cocalc</code> command is not available.
          </Typography.Paragraph>
          {cliCommands(host).map((command) => (
            <Typography.Paragraph
              key={command}
              copyable={{ text: command }}
              style={{ marginBottom: 8 }}
            >
              <code>{command}</code>
            </Typography.Paragraph>
          ))}
        </div>
      }
    >
      <Button size="small" icon={<CodeOutlined />}>
        CLI
      </Button>
    </Popover>
  );
}

function DetailsPopover({
  host,
  op,
  displayPhaseLabel,
  displayPhaseOwner,
  displayDeadlineAt,
  onDetails,
}: {
  host: Host;
  op?: HostLroState;
  displayPhaseLabel?: string;
  displayPhaseOwner?: string;
  displayDeadlineAt?: string;
  onDetails?: (host: Host) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const placement = placementSummary(host);
  const software = softwareSummary(host);
  const backups = backupSummary(host);
  const daemons = daemonSummary(host);
  const projects = projectCounts(host);
  const operation = operationStatus(op);
  const lifecycle = host.bootstrap_lifecycle;
  const backupStatus = host.backup_status;
  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      title={
        <Space size={8}>
          <SyncOutlined />
          <span>Host status details</span>
        </Space>
      }
      content={
        <div style={{ width: 760, maxWidth: "82vw" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 16,
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <Space size={[10, 6]} wrap>
              <StatusHero host={host} />
              <ConnectionTag host={host} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Last checked{" "}
                {host.provider_observed_at ? (
                  <TimeAgo date={host.provider_observed_at} />
                ) : (
                  "n/a"
                )}
              </Typography.Text>
            </Space>
            {onDetails ? (
              <Button
                size="small"
                type="primary"
                onClick={() => {
                  setOpen(false);
                  onDetails(host);
                }}
              >
                Open full host details
              </Button>
            ) : null}
          </div>
          <div style={detailsGridStyle()}>
            <DetailSection
              title="Overview"
              description="High-level state of this host."
              icon={<InfoCircleOutlined />}
            >
              <DetailRow
                icon={<SyncOutlined />}
                label="Lifecycle"
                value={statusLabel(host)}
                tone={statusTone(host)}
              />
              <DetailRow
                icon={<WifiOutlined />}
                label="Connectivity"
                value={isHostOnline(host.last_seen) ? "Online" : "Offline"}
                tone={isHostOnline(host.last_seen) ? "green" : "orange"}
              />
              <DetailRow
                icon={<ClockCircleOutlined />}
                label="Last heartbeat"
                value={<TimeAgoOrNA date={host.last_seen} />}
              />
              <DetailRow
                icon={<CloudOutlined />}
                label="Cloud check"
                value={<TimeAgoOrNA date={host.provider_observed_at} />}
              />
            </DetailSection>
            <DetailSection
              title="Current operation"
              description="Active actions on this host."
              icon={<SyncOutlined />}
              footer={
                op ? (
                  <HostOpProgress
                    op={op}
                    compact
                    displayPhaseLabel={displayPhaseLabel}
                    displayPhaseOwner={displayPhaseOwner}
                    displayDeadlineAt={displayDeadlineAt}
                  />
                ) : null
              }
            >
              <div
                style={{
                  border: `1px solid ${TONE_COLORS[operation.tone].border}`,
                  background: TONE_COLORS[operation.tone].background,
                  borderRadius: 8,
                  padding: 10,
                }}
              >
                <Space
                  orientation="vertical"
                  size={4}
                  style={{ width: "100%" }}
                >
                  <Space size={8}>
                    <StatusDot tone={operation.tone} />
                    <Typography.Text strong>
                      {operation.label}
                      {operation.phase ? `: ${operation.phase}` : ""}
                    </Typography.Text>
                  </Space>
                  {operation.active ? (
                    <Progress
                      percent={operation.percent ?? 30}
                      showInfo={operation.percent != null}
                      size="small"
                      status={operation.percent == null ? "active" : "normal"}
                    />
                  ) : (
                    <Typography.Text type="secondary">
                      All actions are complete.
                    </Typography.Text>
                  )}
                </Space>
              </div>
            </DetailSection>
            <DetailSection
              title="Placement"
              description="Where and whether this host can receive projects."
              icon={<CloudOutlined />}
            >
              <DetailRow
                icon={<CloudOutlined />}
                label="Placement"
                value={placement.value}
                tone={placement.tone}
              />
              <DetailRow
                icon={<CloudOutlined />}
                label="Pressure"
                value={formatPlacementZone(host.pressure?.zone)}
                tone={placement.tone}
              />
              <DetailRow
                icon={<InfoCircleOutlined />}
                label="Reason"
                value={
                  host.reason_unavailable
                    ? humanizeReason(host.reason_unavailable)
                    : humanizeReason(host.pressure?.reason)
                }
              />
            </DetailSection>
            <DetailSection
              title="Software lifecycle"
              description="System image and bootstrap reconciliation."
              icon={<SettingOutlined />}
              footer={
                lifecycle ? (
                  <Popover
                    title="Software lifecycle detail"
                    content={
                      <div style={{ maxWidth: 600 }}>
                        <SoftwareLifecycleDetails host={host} />
                      </div>
                    }
                    trigger="click"
                  >
                    <Button size="small" type="link">
                      Details <DownOutlined />
                    </Button>
                  </Popover>
                ) : null
              }
            >
              <DetailRow
                icon={<SettingOutlined />}
                label="Summary"
                value={software.value}
                tone={software.tone}
              />
              <DetailRow
                icon={<InfoCircleOutlined />}
                label="Drift items"
                value={lifecycle?.drift_count ?? 0}
                tone={lifecycle?.drift_count ? "orange" : "green"}
              />
              <DetailRow
                icon={<ClockCircleOutlined />}
                label="Last reconcile"
                value={
                  lifecycle?.last_reconcile_finished_at ? (
                    <TimeAgoOrNA date={lifecycle.last_reconcile_finished_at} />
                  ) : (
                    "n/a"
                  )
                }
              />
              <HostBootstrapProgress host={host} compact />
            </DetailSection>
            <DetailSection
              title="Projects & backups"
              description="Assigned projects and backup coverage."
              icon={<DatabaseOutlined />}
            >
              <DetailRow
                icon={<FolderOutlined />}
                label="Projects"
                value={`${projects.assigned} assigned · ${projects.provisioned} provisioned · ${projects.running} running`}
              />
              <DetailRow
                icon={<DatabaseOutlined />}
                label="Backups"
                value={backups.value}
                tone={backups.tone}
              />
              <DetailRow
                icon={<InfoCircleOutlined />}
                label="Needs final backup"
                value={
                  (backupStatus?.provisioned_needs_backup ?? 0) +
                  (backupStatus?.running ?? 0)
                }
                tone={
                  (backupStatus?.provisioned_needs_backup ?? 0) +
                    (backupStatus?.running ?? 0) >
                  0
                    ? "orange"
                    : "green"
                }
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Running projects count here until a final backup completes;
                unprovisioned stopped projects are not backup candidates.
              </Typography.Text>
            </DetailSection>
            <DetailSection
              title="Daemon health"
              description="Background services reported by the host."
              icon={<SettingOutlined />}
            >
              <DetailRow
                icon={<SettingOutlined />}
                label="Summary"
                value={daemons.value}
                tone={daemons.tone}
              />
              <div style={{ marginTop: 8 }}>{daemonTags(host)}</div>
            </DetailSection>
          </div>
          <div style={{ marginTop: 12 }}>
            <DetailSection
              title="Troubleshooting"
              description="Tools and diagnostics for support."
              icon={<CodeOutlined />}
            >
              <Space size={12} wrap>
                <CliPopover host={host} />
                <Button
                  size="small"
                  href={COCALC_CLI_DOWNLOAD_URL}
                  target="_blank"
                >
                  Install CoCalc CLI
                </Button>
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  Use the CLI for deeper daemon status, logs, and deployment
                  diagnostics.
                </Typography.Text>
              </Space>
              <div style={{ marginTop: 8 }}>
                <HostBillingEnforcementStatus host={host} compact />
              </div>
            </DetailSection>
          </div>
        </div>
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
  onDetails,
  fullWidth = false,
}: {
  host: Host;
  op?: HostLroState;
  onDetails?: (host: Host) => void;
  fullWidth?: boolean;
}) {
  const displayOp =
    shouldDisplayHostOperation(op) &&
    !shouldSuppressProjectHostFailedOp({
      op,
      currentVersion: host.version,
      observation: host.observed_host_agent?.project_host,
    })
      ? op
      : undefined;
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
    <div
      style={
        fullWidth
          ? { ...CARD_STYLE, width: "100%", maxWidth: "100%" }
          : CARD_STYLE
      }
    >
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
          onDetails={onDetails}
        />
      </div>
    </div>
  );
}
