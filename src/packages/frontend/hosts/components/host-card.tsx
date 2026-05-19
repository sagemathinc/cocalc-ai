import {
  Button,
  Card,
  Divider,
  Popconfirm,
  Space,
  Tag,
  Typography,
} from "antd";
import { React } from "@cocalc/frontend/app-framework";
import { Tooltip } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import type { Host, HostCatalog } from "@cocalc/conat/hub/api/hosts";
import type {
  HostDeleteOptions,
  HostDrainOptions,
  HostProvider,
  HostStopOptions,
} from "../types";
import { getProviderDescriptor, isKnownProvider } from "../providers/registry";
import { useHostPricingSettings } from "../hooks/use-host-pricing-settings";
import { isHostOpActive, type HostLroState } from "../hooks/use-host-ops";
import { describeBlockedHostActions, getHostOpPhase } from "./host-op-progress";
import {
  confirmHostDeprovision,
  confirmHostDrain,
  confirmHostStop,
} from "./host-confirm";
import { COLORS } from "@cocalc/util/theme";
import { getHostSizeDisplay } from "../utils/format";
import { canManageHostLifecycle } from "../utils/access";
import { HostCurrentMetrics } from "./host-current-metrics";
import { hostBillingEnforcementBlocksStart } from "./host-billing-enforcement";
import {
  currentProjectHostRolloutPhase,
  shouldSuppressProjectHostFailedOp,
} from "@cocalc/conat/project-host/rollout";
import { isSpotHost, SpotHostTag } from "../spot-ui";
import { HostPricingSummary } from "./host-pricing-summary";
import { HostStatusSummary } from "./host-status-summary";

type HostCardProps = {
  host: Host;
  hostOp?: HostLroState;
  onStart: (id: string) => void;
  onStop: (id: string, opts?: HostStopOptions) => void;
  onRestart: (id: string, mode: "reboot" | "hard") => void;
  onDrain: (id: string, opts?: HostDrainOptions) => void;
  onDelete: (id: string, opts?: HostDeleteOptions) => void;
  onCancelOp?: (op_id: string) => void;
  onRefreshCloudStatus?: (host: Host) => void;
  onDetails: (host: Host) => void;
  onEdit: (host: Host) => void;
  onToggleStar?: (host: Host) => void;
  catalog?: HostCatalog;
  pricingCatalogs?: Partial<Record<HostProvider, HostCatalog | undefined>>;
  providerCapabilities?: HostCatalog["provider_capabilities"];
  selfHost?: {
    isConnectorOnline: (connectorId?: string) => boolean;
    onSetup: (host: Host) => void;
  };
};

export const HostCard: React.FC<HostCardProps> = ({
  host,
  hostOp,
  onStart,
  onStop,
  onRestart,
  onDrain,
  onDelete,
  onCancelOp,
  onRefreshCloudStatus,
  onDetails,
  onEdit,
  onToggleStar,
  catalog,
  pricingCatalogs,
  providerCapabilities,
  selfHost,
}) => {
  const pricingSettings = useHostPricingSettings();
  const isDeleted = !!host.deleted;
  const isSelfHost = host.machine?.cloud === "self-host";
  const hasSshTarget = !!String(
    host.machine?.metadata?.self_host_ssh_target ?? "",
  ).trim();
  const autoSetup = isSelfHost && hasSshTarget;
  const connectorOnline =
    !isSelfHost ||
    !selfHost?.isConnectorOnline ||
    selfHost.isConnectorOnline(host.region);
  const showConnectorSetup = isSelfHost && !isDeleted;
  const size = getHostSizeDisplay(host);
  const projectHostObservation = host.observed_host_agent?.project_host;
  const displayHostOp = shouldSuppressProjectHostFailedOp({
    op: hostOp,
    currentVersion: host.version,
    observation: projectHostObservation,
  })
    ? undefined
    : hostOp;
  const hostOpActive = isHostOpActive(displayHostOp);
  const projectHostRolloutPhase = currentProjectHostRolloutPhase({
    op: displayHostOp,
    currentVersion: host.version,
    observation: projectHostObservation,
  });
  const startDisabled =
    isDeleted ||
    !host.can_start ||
    host.status === "running" ||
    host.status === "starting" ||
    host.status === "restarting" ||
    hostBillingEnforcementBlocksStart(host) ||
    (!connectorOnline && !autoSetup) ||
    hostOpActive;
  const startLabel =
    host.status === "starting"
      ? "Starting"
      : host.status === "restarting"
        ? "Restarting"
        : "Start";
  const stopLabel = host.status === "stopping" ? "Stopping" : "Stop";
  const providerId = host.machine?.cloud;
  const caps = providerId ? providerCapabilities?.[providerId] : undefined;
  const allowStop =
    !isDeleted &&
    host.can_start &&
    (host.status === "running" || host.status === "error") &&
    caps?.supportsStop !== false &&
    host.machine?.storage_mode !== "ephemeral" &&
    !hostOpActive;
  const supportsRestart = caps?.supportsRestart ?? true;
  const supportsHardRestart = caps?.supportsHardRestart ?? false;
  const allowRestart =
    !isDeleted &&
    host.can_start &&
    connectorOnline &&
    (host.status === "running" || host.status === "error") &&
    (supportsRestart || supportsHardRestart) &&
    !hostOpActive;
  const canManageLifecycle = canManageHostLifecycle(host);
  const deleteLabel = isDeleted
    ? "Deleted"
    : host.status === "deprovisioned"
      ? "Delete"
      : "Deprovision";
  const deleteTitle =
    host.status === "deprovisioned"
      ? "Delete this host?"
      : "Deprovision this host?";
  const deleteOkText =
    host.status === "deprovisioned" ? "Delete" : "Deprovision";
  const isDeprovisioned = host.status === "deprovisioned";
  const canRefreshCloudStatus =
    !isDeleted &&
    !!onRefreshCloudStatus &&
    !!host.machine?.cloud &&
    host.machine.cloud !== "self-host" &&
    host.machine.cloud !== "local" &&
    !hostOpActive;
  const opPhase = getHostOpPhase(displayHostOp);
  const canCancelBackups =
    !!displayHostOp?.op_id &&
    hostOpActive &&
    opPhase === "backups" &&
    !!onCancelOp;
  const blockedActionsReason = describeBlockedHostActions(displayHostOp, {
    displayPhaseLabel: projectHostRolloutPhase?.label,
  });
  const actions = [
    <Button
      key="start"
      type="link"
      disabled={startDisabled}
      onClick={() => onStart(host.id)}
    >
      {startLabel}
    </Button>,
    showConnectorSetup && selfHost ? (
      <Button
        key="setup"
        type="link"
        disabled={hostOpActive}
        onClick={() => selfHost.onSetup(host)}
      >
        Setup / reconnect
      </Button>
    ) : null,
    allowStop ? (
      <Button
        key="stop"
        type="link"
        onClick={() =>
          confirmHostStop({
            host,
            onConfirm: (opts) => onStop(host.id, opts),
          })
        }
      >
        {stopLabel}
      </Button>
    ) : (
      <Button key="stop" type="link" disabled>
        {stopLabel}
      </Button>
    ),
    allowRestart ? (
      <Button
        key="restart"
        type="link"
        onClick={() => onRestart(host.id, "reboot")}
      >
        Restart
      </Button>
    ) : (
      <Button key="restart" type="link" disabled>
        Restart
      </Button>
    ),
    canManageLifecycle ? (
      <Button
        key="drain"
        type="link"
        disabled={isDeleted || hostOpActive}
        onClick={() =>
          confirmHostDrain({
            host,
            onConfirm: (opts) => onDrain(host.id, opts),
          })
        }
      >
        Drain
      </Button>
    ) : null,
    canCancelBackups && displayHostOp ? (
      <Popconfirm
        key="cancel"
        title="Cancel backups for this host?"
        okText="Cancel backups"
        cancelText="Keep running"
        onConfirm={() => onCancelOp?.(displayHostOp.op_id)}
      >
        <Button type="link">Cancel</Button>
      </Popconfirm>
    ) : null,
    canManageLifecycle ? (
      <Button
        key="edit"
        type="link"
        disabled={isDeleted}
        onClick={() => onEdit(host)}
      >
        Edit
      </Button>
    ) : null,
    canRefreshCloudStatus ? (
      <Popconfirm
        key="refresh-cloud"
        title="Refresh cloud/provider status for this host?"
        description="This forces an immediate cloud reconcile for this host's provider and updates the host row if reality drifted."
        okText="Refresh"
        cancelText="Cancel"
        onConfirm={() => onRefreshCloudStatus?.(host)}
      >
        <Button type="link">Refresh cloud status</Button>
      </Popconfirm>
    ) : null,
    <Button key="details" type="link" onClick={() => onDetails(host)}>
      Details
    </Button>,
    canManageLifecycle && isDeprovisioned ? (
      <Popconfirm
        key="delete"
        title={deleteTitle}
        okText={deleteOkText}
        cancelText="Cancel"
        okButtonProps={{ danger: true }}
        onConfirm={() => onDelete(host.id)}
        disabled={isDeleted || hostOpActive}
      >
        <Button type="link" danger disabled={isDeleted || hostOpActive}>
          {deleteLabel}
        </Button>
      </Popconfirm>
    ) : canManageLifecycle ? (
      <Button
        key="delete"
        type="link"
        danger
        disabled={isDeleted || hostOpActive}
        onClick={() =>
          confirmHostDeprovision({
            host,
            onConfirm: (opts) => onDelete(host.id, opts),
          })
        }
      >
        {deleteLabel}
      </Button>
    ) : null,
  ];
  const visibleActions = actions.filter(Boolean) as React.ReactNode[];

  return (
    <Card
      title={
        <Space size="small" wrap>
          <Button
            type="link"
            onClick={() => onDetails(host)}
            style={{ padding: 0, height: "auto" }}
          >
            {host.name}
          </Button>
          {isSpotHost(host) && (
            <SpotHostTag
              host={host}
              catalog={pricingCatalogs ?? catalog}
              pricingSettings={pricingSettings}
            />
          )}
        </Space>
      }
      extra={
        <Space size="small">
          <Tooltip title={host.starred ? "Starred" : "Star host"}>
            <span
              onClick={(event) => {
                event.stopPropagation();
                onToggleStar?.(host);
              }}
              style={{
                cursor: onToggleStar ? "pointer" : "default",
                fontSize: 18,
                color: host.starred ? COLORS.STAR : COLORS.GRAY_L,
              }}
            >
              <Icon name={host.starred ? "star-filled" : "star"} />
            </span>
          </Tooltip>
        </Space>
      }
    >
      <Space orientation="vertical" size="small" style={{ width: "100%" }}>
        {host.reprovision_required && (
          <Tooltip title="Host config changed while stopped; will reprovision on next start.">
            <Tag color="orange">Reprovision on next start</Tag>
          </Tooltip>
        )}
        <HostStatusSummary
          host={host}
          op={displayHostOp}
          onDetails={onDetails}
        />
        <Typography.Text>
          Provider:{" "}
          {host.machine?.cloud
            ? isKnownProvider(host.machine.cloud)
              ? getProviderDescriptor(host.machine.cloud).label
              : host.machine.cloud
            : "n/a"}
        </Typography.Text>
        <Typography.Text>
          {isSelfHost ? "Connector" : "Region"}: {host.region}
        </Typography.Text>
        <Typography.Text>
          Size: {size.primary}
          {size.secondary ? ` · ${size.secondary}` : ""}
        </Typography.Text>
        <HostPricingSummary
          host={host}
          catalog={pricingCatalogs ?? catalog}
          pricingSettings={pricingSettings}
        />
        <HostCurrentMetrics host={host} compact />
        <Typography.Text>GPU: {host.gpu ? "Yes" : "No"}</Typography.Text>
        {host.last_action && (
          <Typography.Text type="secondary">
            Last action: {host.last_action}
            {host.last_action_status ? ` (${host.last_action_status})` : ""}
            {host.last_action_at
              ? ` · ${new Date(host.last_action_at).toLocaleString()}`
              : ""}
          </Typography.Text>
        )}
        {host.status === "error" && host.last_error && (
          <div
            style={{
              maxHeight: "4.8em",
              overflowY: "auto",
              color: "#c00",
              fontSize: 12,
              lineHeight: 1.2,
              whiteSpace: "pre-wrap",
              paddingRight: 4,
            }}
          >
            {host.last_error}
          </div>
        )}
        <Divider style={{ margin: "4px 0" }} />
        <Space
          size={[0, 4]}
          wrap
          style={{ width: "100%" }}
          styles={{ item: { marginInlineEnd: 0 } }}
        >
          {visibleActions}
        </Space>
        {blockedActionsReason ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {blockedActionsReason}
          </Typography.Text>
        ) : null}
      </Space>
    </Card>
  );
};
