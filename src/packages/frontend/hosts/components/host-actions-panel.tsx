import {
  CloudUploadOutlined,
  CloudSyncOutlined,
  DeleteOutlined,
  EditOutlined,
  InfoCircleOutlined,
  MoreOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  StopOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { Button, Popconfirm, Popover, Space, Tag, Typography } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import { Tooltip } from "@cocalc/frontend/components";
import type { Host, HostCatalog } from "@cocalc/conat/hub/api/hosts";
import type {
  HostDeleteOptions,
  HostDrainOptions,
  HostProvider,
  HostStopOptions,
} from "../types";
import { canManageHostLifecycle } from "../utils/access";
import { isHostOpActive, type HostLroState } from "../hooks/use-host-ops";
import { getHostOpPhase } from "./host-op-progress";
import {
  confirmHostDeprovision,
  confirmHostDrain,
  confirmHostStop,
} from "./host-confirm";
import { hostBillingEnforcementBlocksStart } from "./host-billing-enforcement";

type HostActionsPanelProps = {
  host: Host;
  hostOp?: HostLroState;
  providerCapabilities?: HostCatalog["provider_capabilities"];
  blockedActionsReason?: string;
  mode?: "table" | "card";
  selfHost?: {
    isConnectorOnline: (connectorId?: string) => boolean;
    onSetup: (host: Host) => void;
  };
  onStart: () => void;
  onStop: (opts?: HostStopOptions) => void;
  onRestart: () => void;
  onDrain: (opts?: HostDrainOptions) => void;
  onBackup: () => void;
  onDelete: (opts?: HostDeleteOptions) => void;
  onCancelOp?: (op_id: string) => void;
  onEdit: () => void;
  onDetails?: () => void;
  onRefreshCloudStatus?: () => void;
};

function SectionTitle({ children }: { children: string }) {
  return (
    <Typography.Text
      type="secondary"
      style={{
        display: "block",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        margin: "2px 0 4px",
      }}
    >
      {children}
    </Typography.Text>
  );
}

const START_LIKE_HOST_OP_KINDS = new Set(["host-start", "host-restart"]);
const STOPPABLE_HOST_STATUSES = new Set([
  "running",
  "starting",
  "restarting",
  "error",
]);

function hostCanBeDeletedWithoutDeprovision(host: Host): boolean {
  const provider = host.machine?.cloud;
  const managedCloud =
    provider && provider !== "self-host" && provider !== "local";
  return (
    host.status === "deprovisioned" ||
    (!!managedCloud && !host.provider_instance_id)
  );
}

export function HostActionsPanel({
  host,
  hostOp,
  providerCapabilities,
  blockedActionsReason,
  mode = "table",
  selfHost,
  onStart,
  onStop,
  onRestart,
  onDrain,
  onBackup,
  onDelete,
  onCancelOp,
  onEdit,
  onDetails,
  onRefreshCloudStatus,
}: HostActionsPanelProps) {
  const [moreOpen, setMoreOpen] = React.useState(false);
  const closeMore = () => setMoreOpen(false);
  const isDeleted = !!host.deleted;
  const hostOpActive = isHostOpActive(hostOp);
  const isSelfHost = host.machine?.cloud === "self-host";
  const hasSshTarget = !!String(
    host.machine?.metadata?.self_host_ssh_target ?? "",
  ).trim();
  const autoSetup = isSelfHost && hasSshTarget;
  const connectorOnline =
    !isSelfHost ||
    !selfHost?.isConnectorOnline ||
    selfHost.isConnectorOnline(host.region);
  const showConnectorSetup = isSelfHost && selfHost && !isDeleted;
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
  const providerId = host.machine?.cloud;
  const caps = providerId
    ? providerCapabilities?.[providerId as HostProvider]
    : undefined;
  const hostOpKind = hostOp?.kind ?? hostOp?.summary?.kind;
  const activeStartLikeOperation =
    hostOpActive &&
    (START_LIKE_HOST_OP_KINDS.has(String(hostOpKind ?? "")) ||
      host.status === "starting" ||
      host.status === "restarting");
  const allowEmergencyStop =
    activeStartLikeOperation &&
    STOPPABLE_HOST_STATUSES.has(String(host.status)) &&
    caps?.supportsStop !== false &&
    host.machine?.storage_mode !== "ephemeral";
  const stopLabel =
    host.status === "stopping"
      ? "Stopping"
      : allowEmergencyStop
        ? "Emergency stop"
        : "Stop";
  const allowStop =
    !isDeleted &&
    host.can_start &&
    STOPPABLE_HOST_STATUSES.has(String(host.status)) &&
    caps?.supportsStop !== false &&
    host.machine?.storage_mode !== "ephemeral" &&
    (!hostOpActive || allowEmergencyStop);
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
  const deleteWithoutDeprovision = hostCanBeDeletedWithoutDeprovision(host);
  const deleteLabel = isDeleted
    ? "Deleted"
    : deleteWithoutDeprovision
      ? "Delete"
      : "Deprovision";
  const deleteTitle = deleteWithoutDeprovision
    ? "Delete this host?"
    : "Deprovision this host?";
  const deleteOkText = deleteWithoutDeprovision ? "Delete" : "Deprovision";
  const opPhase = getHostOpPhase(hostOp);
  const canCancelBackups =
    !!hostOp?.op_id && hostOpActive && opPhase === "backups" && !!onCancelOp;
  const canRefreshCloudStatus =
    !isDeleted &&
    !!onRefreshCloudStatus &&
    !!host.machine?.cloud &&
    host.machine.cloud !== "self-host" &&
    host.machine.cloud !== "local" &&
    !hostOpActive;
  const canBackupProjects =
    !isDeleted &&
    !hostOpActive &&
    (host.status === "running" || host.status === "error");
  const actionButtonStyle = {
    justifyContent: "flex-start",
    height: 30,
    paddingInline: 8,
  } as const;
  const runStop = () => {
    if (allowEmergencyStop) {
      onStop({ skip_backups: true });
      return;
    }
    confirmHostStop({
      host,
      onConfirm: onStop,
    });
  };
  const primaryAction =
    !startDisabled || !allowStop
      ? {
          label: startLabel,
          icon: <PlayCircleOutlined />,
          disabled: startDisabled,
          type: "primary" as const,
          onClick: onStart,
        }
      : allowStop
        ? {
            label: stopLabel,
            icon: <PoweroffOutlined />,
            disabled: false,
            type: "default" as const,
            onClick: runStop,
          }
        : {
            label: "Restart",
            icon: <ReloadOutlined />,
            disabled: !allowRestart,
            type: "default" as const,
            onClick: onRestart,
          };
  const lifecycleActions = (
    <Space direction="vertical" size={2} style={{ width: "100%" }}>
      <SectionTitle>Lifecycle</SectionTitle>
      <Button
        block
        type="text"
        disabled={startDisabled}
        icon={<PlayCircleOutlined />}
        style={actionButtonStyle}
        onClick={() => {
          closeMore();
          onStart();
        }}
      >
        {startLabel}
      </Button>
      <Button
        block
        type="text"
        disabled={!allowStop}
        icon={<PoweroffOutlined />}
        style={actionButtonStyle}
        onClick={() => {
          closeMore();
          runStop();
        }}
      >
        {stopLabel}
      </Button>
      <Button
        block
        type="text"
        disabled={!allowRestart}
        icon={<ReloadOutlined />}
        style={actionButtonStyle}
        onClick={() => {
          closeMore();
          onRestart();
        }}
      >
        Restart
      </Button>
      {showConnectorSetup && selfHost ? (
        <Button
          block
          type="text"
          disabled={hostOpActive}
          icon={<ToolOutlined />}
          style={actionButtonStyle}
          onClick={() => {
            closeMore();
            selfHost.onSetup(host);
          }}
        >
          Setup / reconnect
        </Button>
      ) : null}
    </Space>
  );
  const operationActions = (
    <Space direction="vertical" size={2} style={{ width: "100%" }}>
      <SectionTitle>Operations</SectionTitle>
      {onDetails ? (
        <Button
          block
          type="text"
          icon={<InfoCircleOutlined />}
          style={actionButtonStyle}
          onClick={() => {
            closeMore();
            onDetails();
          }}
        >
          Details
        </Button>
      ) : null}
      <Button
        block
        type="text"
        icon={<EditOutlined />}
        disabled={!canManageLifecycle || isDeleted}
        style={actionButtonStyle}
        onClick={() => {
          closeMore();
          onEdit();
        }}
      >
        Edit settings
      </Button>
      {canRefreshCloudStatus ? (
        <Popconfirm
          title="Refresh cloud/provider status for this host?"
          description="This forces an immediate cloud reconcile for this host's provider and updates the host row if reality drifted."
          okText="Refresh"
          cancelText="Cancel"
          onConfirm={() => {
            closeMore();
            onRefreshCloudStatus();
          }}
        >
          <Button
            block
            type="text"
            icon={<CloudSyncOutlined />}
            style={actionButtonStyle}
          >
            Refresh cloud status
          </Button>
        </Popconfirm>
      ) : null}
    </Space>
  );
  const maintenanceActions = canManageLifecycle ? (
    <Space direction="vertical" size={2} style={{ width: "100%" }}>
      <SectionTitle>Maintenance</SectionTitle>
      <Popconfirm
        title="Backup all projects on this host?"
        description="This creates backups for provisioned or running projects assigned to this host. Stopped unprovisioned projects are skipped."
        okText="Backup projects"
        cancelText="Cancel"
        disabled={!canBackupProjects}
        onConfirm={() => {
          closeMore();
          onBackup();
        }}
      >
        <Button
          block
          type="text"
          disabled={!canBackupProjects}
          icon={<CloudUploadOutlined />}
          style={actionButtonStyle}
        >
          Backup projects
        </Button>
      </Popconfirm>
      <Button
        block
        type="text"
        disabled={isDeleted || hostOpActive}
        icon={<StopOutlined />}
        style={actionButtonStyle}
        onClick={() => {
          closeMore();
          confirmHostDrain({
            host,
            onConfirm: onDrain,
          });
        }}
      >
        Drain
      </Button>
      {canCancelBackups && hostOp ? (
        <Popconfirm
          title="Cancel backups for this host?"
          okText="Cancel backups"
          cancelText="Keep running"
          onConfirm={() => {
            closeMore();
            onCancelOp?.(hostOp.op_id);
          }}
        >
          <Button
            block
            type="text"
            icon={<StopOutlined />}
            style={actionButtonStyle}
          >
            Cancel backups
          </Button>
        </Popconfirm>
      ) : null}
    </Space>
  ) : null;
  const dangerActions = canManageLifecycle ? (
    <Space direction="vertical" size={2} style={{ width: "100%" }}>
      <SectionTitle>Danger</SectionTitle>
      {deleteWithoutDeprovision ? (
        <Popconfirm
          title={deleteTitle}
          okText={deleteOkText}
          cancelText="Cancel"
          okButtonProps={{ danger: true }}
          onConfirm={() => {
            closeMore();
            onDelete();
          }}
          disabled={isDeleted || hostOpActive}
        >
          <Button
            block
            type="text"
            danger
            disabled={isDeleted || hostOpActive}
            icon={<DeleteOutlined />}
            style={actionButtonStyle}
          >
            {deleteLabel}
          </Button>
        </Popconfirm>
      ) : (
        <Button
          block
          type="text"
          danger
          disabled={isDeleted || hostOpActive}
          icon={<DeleteOutlined />}
          style={actionButtonStyle}
          onClick={() => {
            closeMore();
            confirmHostDeprovision({
              host,
              onConfirm: onDelete,
            });
          }}
        >
          {deleteLabel}
        </Button>
      )}
    </Space>
  ) : null;
  const moreActions = (
    <div style={{ width: 220 }}>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        {lifecycleActions}
        {operationActions}
        {maintenanceActions}
        {dangerActions}
      </Space>
    </div>
  );
  const primaryMinWidth = mode === "card" ? 118 : 94;
  return (
    <Space
      direction="vertical"
      size={6}
      style={{ maxWidth: mode === "card" ? undefined : 260, width: "100%" }}
    >
      <Space
        size={6}
        wrap={mode === "card"}
        style={{
          width: "100%",
          flexWrap: mode === "card" ? undefined : "nowrap",
        }}
      >
        <Button
          size="small"
          type={primaryAction.type}
          disabled={primaryAction.disabled}
          icon={primaryAction.icon}
          onClick={primaryAction.onClick}
          style={{ minWidth: primaryMinWidth }}
        >
          {primaryAction.label}
        </Button>
        <Tooltip title="Restart">
          <Button
            size="small"
            disabled={!allowRestart}
            icon={<ReloadOutlined />}
            onClick={onRestart}
          />
        </Tooltip>
        {canManageLifecycle ? (
          <Tooltip title="Edit settings">
            <Button
              size="small"
              disabled={isDeleted}
              icon={<EditOutlined />}
              onClick={onEdit}
            />
          </Tooltip>
        ) : null}
        <Popover
          trigger="click"
          placement="bottomRight"
          open={moreOpen}
          onOpenChange={setMoreOpen}
          content={moreActions}
          overlayInnerStyle={{ padding: 10 }}
        >
          <Button size="small" icon={<MoreOutlined />} />
        </Popover>
      </Space>
      {blockedActionsReason ? (
        <Typography.Text
          type="secondary"
          style={{ fontSize: 12, lineHeight: 1.3 }}
        >
          {blockedActionsReason}
          {allowEmergencyStop ? " Emergency stop is still available." : ""}
        </Typography.Text>
      ) : null}
      {mode === "card" && hostOpActive ? (
        <Tag color="blue" style={{ alignSelf: "flex-start" }}>
          Operation in progress
        </Tag>
      ) : null}
    </Space>
  );
}
