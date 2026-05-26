import { Button, Card, Space, Tag, Typography } from "antd";
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
import { useHostPricingSettings } from "../hooks/use-host-pricing-settings";
import type { HostLroState } from "../hooks/use-host-ops";
import { describeBlockedHostActions } from "./host-op-progress";
import { COLORS } from "@cocalc/util/theme";
import { HostCurrentMetrics } from "./host-current-metrics";
import {
  currentProjectHostRolloutPhase,
  shouldSuppressProjectHostFailedOp,
} from "@cocalc/conat/project-host/rollout";
import { HostPricingSummary } from "./host-pricing-summary";
import { HostStatusSummary } from "./host-status-summary";
import { HostActionsPanel } from "./host-actions-panel";
import { HostConfigurationCell } from "./host-configuration-cell";
import { HostAccessPolicySummary } from "./host-access-policy";

type HostCardProps = {
  host: Host;
  hostOp?: HostLroState;
  onStart: (id: string) => void;
  onStop: (id: string, opts?: HostStopOptions) => void;
  onRestart: (id: string, mode: "reboot" | "hard") => void;
  onDrain: (id: string, opts?: HostDrainOptions) => void;
  onBackup: (id: string) => void;
  onDelete: (id: string, opts?: HostDeleteOptions) => void;
  onCancelOp?: (op_id: string) => void;
  onRefreshCloudStatus?: (host: Host) => void;
  onDetails: (host: Host, tab?: string) => void;
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
  onBackup,
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
  const projectHostObservation = host.observed_host_agent?.project_host;
  const displayHostOp = shouldSuppressProjectHostFailedOp({
    op: hostOp,
    currentVersion: host.version,
    observation: projectHostObservation,
  })
    ? undefined
    : hostOp;
  const projectHostRolloutPhase = currentProjectHostRolloutPhase({
    op: displayHostOp,
    currentVersion: host.version,
    observation: projectHostObservation,
  });
  const blockedActionsReason = describeBlockedHostActions(displayHostOp, {
    displayPhaseLabel: projectHostRolloutPhase?.label,
  });

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
          fullWidth
        />
        <HostConfigurationCell host={host} maxWidth="100%" />
        <HostAccessPolicySummary host={host} compact />
        <HostPricingSummary
          host={host}
          catalog={pricingCatalogs ?? catalog}
          pricingSettings={pricingSettings}
        />
        <HostCurrentMetrics host={host} compact />
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
        <HostActionsPanel
          host={host}
          hostOp={displayHostOp}
          providerCapabilities={providerCapabilities}
          blockedActionsReason={blockedActionsReason}
          mode="card"
          selfHost={selfHost}
          onStart={() => onStart(host.id)}
          onStop={(opts) => onStop(host.id, opts)}
          onRestart={() => onRestart(host.id, "reboot")}
          onDrain={(opts) => onDrain(host.id, opts)}
          onBackup={() => onBackup(host.id)}
          onDelete={(opts) => onDelete(host.id, opts)}
          onCancelOp={onCancelOp}
          onEdit={() => onEdit(host)}
          onDetails={() => onDetails(host)}
          onRefreshCloudStatus={
            onRefreshCloudStatus ? () => onRefreshCloudStatus(host) : undefined
          }
        />
      </Space>
    </Card>
  );
};
