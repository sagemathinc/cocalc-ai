import {
  Alert,
  Button,
  Card,
  Divider,
  Drawer,
  Popover,
  Popconfirm,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  CodeOutlined,
  QuestionCircleOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import { React, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Tooltip } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import type {
  Host,
  HostRootfsGcResult,
  HostRootfsImage,
  HostSoftwareArtifact,
  HostSoftwareAvailableVersion,
} from "@cocalc/conat/hub/api/hosts";
import type { ParallelOpsWorkerStatus } from "@cocalc/conat/hub/api/system";
import type { HostLogEntry } from "../hooks/use-host-log";
import { isHostOpActive, type HostLroState } from "../hooks/use-host-ops";
import {
  mapCloudRegionToR2Region,
  R2_REGION_LABELS,
} from "@cocalc/util/consts";
import {
  STATUS_COLOR,
  getHostOnlineTooltip,
  getHostStatusTooltip,
  isHostOnline,
  isHostTransitioning,
} from "../constants";
import { getProviderDescriptor, isKnownProvider } from "../providers/registry";
import { getHostOpPhase, HostOpProgress } from "./host-op-progress";
import { UpgradeConfirmContent } from "./upgrade-confirmation";
import { HostBootstrapProgress } from "./host-bootstrap-progress";
import { HostBootstrapLifecycle } from "./host-bootstrap-lifecycle";
import { HostParallelOpsPanel } from "./host-parallel-ops-panel";
import { HostProjectStatus } from "./host-project-status";
import { HostProjectsBrowser } from "./host-projects-browser";
import { HostRootfsCachePanel } from "./host-rootfs-cache-panel";
import { HostCurrentMetrics } from "./host-current-metrics";
import {
  formatBinaryBytes,
  getHostCpuCount,
  getHostRamGiB,
  getHostSizeDisplay,
} from "../utils/format";

type HostDrawerViewModel = {
  open: boolean;
  host?: Host;
  hostOps?: Record<string, HostLroState>;
  onClose: () => void;
  onEdit: (host: Host) => void;
  onUpgrade?: (host: Host) => void;
  onReconcile?: (host: Host) => void;
  onUpgradeFromHub?: (host: Host) => void;
  onUpgradeArtifact?: (opts: {
    host: Host;
    artifact: HostSoftwareArtifact;
    useHubSource?: boolean;
  }) => void | Promise<void>;
  canUpgrade?: boolean;
  onCancelOp?: (op_id: string) => void;
  hostLog: HostLogEntry[];
  loadingLog: boolean;
  softwareVersions?: {
    loading: boolean;
    configured: Partial<
      Record<HostSoftwareArtifact, HostSoftwareAvailableVersion>
    >;
    configuredError?: string;
    hub: Partial<Record<HostSoftwareArtifact, HostSoftwareAvailableVersion>>;
    hubError?: string;
    refresh: () => Promise<void>;
    hubSourceBaseUrl?: string;
  };
  rootfsInventory?: {
    entries: HostRootfsImage[];
    loading: boolean;
    error?: string;
    refreshing: boolean;
    actionKey?: string;
    refresh: () => Promise<void>;
    pull: (image: string) => Promise<void>;
    remove: (image: string) => Promise<void>;
    gcDeleted: () => Promise<HostRootfsGcResult | undefined>;
  };
  canManageRootfs?: boolean;
  selfHost?: {
    connectorMap: Map<
      string,
      { id: string; name?: string; last_seen?: string }
    >;
    isConnectorOnline: (connectorId?: string) => boolean;
    onSetup: (host: Host) => void;
    onRemove: (host: Host) => void;
    onForceDeprovision: (host: Host) => void;
  };
  parallelOps?: {
    status: ParallelOpsWorkerStatus[];
    loading?: boolean;
    savingKey?: string;
    setLimit: (opts: {
      worker_kind: string;
      scope_type?: "global" | "provider" | "project_host";
      scope_id?: string;
      limit_value: number;
    }) => void | Promise<void>;
    clearLimit: (opts: {
      worker_kind: string;
      scope_type?: "global" | "provider" | "project_host";
      scope_id?: string;
    }) => void | Promise<void>;
  };
};

type HostConfigSpec = {
  cloud?: string | null;
  name?: string | null;
  region?: string | null;
  zone?: string | null;
  machine_type?: string | null;
  gpu_type?: string | null;
  gpu_count?: number | null;
  cpu?: number | null;
  ram_gb?: number | null;
  disk_gb?: number | null;
  disk_type?: string | null;
  storage_mode?: string | null;
};

type HostConfigSpecEnvelope = {
  before?: HostConfigSpec;
  after?: HostConfigSpec;
};

const SPEC_LABELS: Record<keyof HostConfigSpec, string> = {
  cloud: "Provider",
  name: "Name",
  region: "Region",
  zone: "Zone",
  machine_type: "Machine",
  gpu_type: "GPU",
  gpu_count: "GPU count",
  cpu: "CPU",
  ram_gb: "RAM",
  disk_gb: "Disk",
  disk_type: "Disk type",
  storage_mode: "Storage",
};

const DRAWER_SIZE_STORAGE_KEY = "cocalc:hosts:drawerWidth";
const MIN_DRAWER_WIDTH = 360;
const MAX_DRAWER_WIDTH = 960;
const SOFTWARE_ARTIFACTS: Array<{
  artifact: HostSoftwareArtifact;
  label: string;
  runningLabel: string;
}> = [
  {
    artifact: "project-host",
    label: "Project host",
    runningLabel: "Host runtime",
  },
  {
    artifact: "project",
    label: "Project bundle",
    runningLabel: "New projects",
  },
  {
    artifact: "tools",
    label: "Tools",
    runningLabel: "Tool archive",
  },
];

function clampDrawerWidth(width: number): number {
  return Math.min(MAX_DRAWER_WIDTH, Math.max(MIN_DRAWER_WIDTH, width));
}

function readDrawerWidth(): number | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const raw = window.localStorage.getItem(DRAWER_SIZE_STORAGE_KEY);
  if (raw == null) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return clampDrawerWidth(parsed);
}

function persistDrawerWidth(width: number) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(
    DRAWER_SIZE_STORAGE_KEY,
    String(clampDrawerWidth(width)),
  );
}

function runningVersion(
  host: Host,
  artifact: HostSoftwareArtifact,
): string | undefined {
  if (artifact === "project-host") return host.version;
  if (artifact === "project") return host.project_bundle_version;
  return host.tools_version;
}

function runningBuildId(
  host: Host,
  artifact: HostSoftwareArtifact,
): string | undefined {
  if (artifact === "project-host") return host.project_host_build_id;
  if (artifact === "project") return host.project_bundle_build_id;
  return undefined;
}

function artifactStatusTag({
  running,
  latest,
  error,
}: {
  running?: string;
  latest?: string;
  error?: string;
}) {
  if (error) {
    return <Tag color="red">source error</Tag>;
  }
  if (!latest) {
    return <Tag>unknown</Tag>;
  }
  if (!running) {
    return <Tag color="default">not reported</Tag>;
  }
  if (running === latest) {
    return <Tag color="green">up to date</Tag>;
  }
  return <Tag color="orange">update available</Tag>;
}

function upgradeTitle({ label, source }: { label: string; source: string }) {
  return (
    <div>
      <div>
        Upgrade {label.toLowerCase()} from {source}?
      </div>
      <UpgradeConfirmContent />
    </div>
  );
}

function cliCommandsForArtifact({
  host,
  artifact,
}: {
  host: Host;
  artifact: HostSoftwareArtifact;
}): string[] {
  return [
    `cocalc host versions --artifact ${artifact}`,
    `cocalc host versions --artifact ${artifact} --hub-source`,
    `cocalc host upgrade ${host.id} --artifact ${artifact} --channel latest`,
    `cocalc host upgrade ${host.id} --artifact ${artifact} --channel latest --hub-source`,
  ];
}

const normalizeSpecValue = (
  key: keyof HostConfigSpec,
  value: HostConfigSpec[keyof HostConfigSpec],
): string => {
  if (value == null || value === "") return "none";
  if (key === "ram_gb" || key === "disk_gb") return `${value} GB`;
  if (key === "cpu") return `${value} vCPU`;
  return String(value);
};

const extractSpecEnvelope = (
  spec: HostLogEntry["spec"],
): HostConfigSpecEnvelope | null => {
  if (!spec || typeof spec !== "object") return null;
  const envelope = spec as HostConfigSpecEnvelope;
  if (!envelope.before && !envelope.after) return null;
  return envelope;
};

const describeSpecChange = (
  spec: HostLogEntry["spec"],
): { summary?: string; details?: string } => {
  const envelope = extractSpecEnvelope(spec);
  if (!envelope?.before || !envelope?.after) return {};
  const changes: string[] = [];
  for (const key of Object.keys(SPEC_LABELS) as Array<keyof HostConfigSpec>) {
    const before = normalizeSpecValue(key, envelope.before[key]);
    const after = normalizeSpecValue(key, envelope.after[key]);
    if (before !== after) {
      changes.push(`${SPEC_LABELS[key]} ${before} → ${after}`);
    }
  }
  if (!changes.length) return {};
  const summary =
    changes.length > 3
      ? `${changes.slice(0, 3).join(", ")}, +${changes.length - 3} more`
      : changes.join(", ");
  const details = JSON.stringify(envelope, null, 2);
  return { summary, details };
};

export const HostDrawer: React.FC<{ vm: HostDrawerViewModel }> = ({ vm }) => {
  const [drawerWidth, setDrawerWidth] = React.useState<number | undefined>(
    readDrawerWidth,
  );
  const [showProjects, setShowProjects] = React.useState(false);
  const [expandedArtifacts, setExpandedArtifacts] = React.useState<
    Partial<Record<HostSoftwareArtifact, boolean>>
  >({});
  const handleResize = React.useCallback((next: number) => {
    const clamped = clampDrawerWidth(next);
    setDrawerWidth(clamped);
    try {
      persistDrawerWidth(clamped);
    } catch {}
  }, []);
  const {
    open,
    host,
    hostOps,
    onClose,
    onEdit,
    onUpgrade,
    onReconcile,
    onUpgradeFromHub,
    onUpgradeArtifact,
    canUpgrade,
    onCancelOp,
    hostLog,
    loadingLog,
    softwareVersions,
    rootfsInventory,
    canManageRootfs,
    selfHost,
    parallelOps,
  } = vm;
  const isSelfHost = host?.machine?.cloud === "self-host";
  const hostCpu = host ? getHostCpuCount(host) : undefined;
  const hostRam = host ? getHostRamGiB(host) : undefined;
  const hostDisk = formatBinaryBytes(
    host?.metrics?.current?.disk_device_total_bytes,
    {
      compact: true,
    },
  );
  const showHostResources = !!host && (hostCpu || hostRam || hostDisk);
  const size = host ? getHostSizeDisplay(host) : undefined;
  const connectorOnline =
    !isSelfHost ||
    !selfHost?.isConnectorOnline ||
    selfHost.isConnectorOnline(host?.region);
  const selfHostAlphaEnabled = !!useTypedRedux(
    "customize",
    "project_hosts_self_host_alpha_enabled",
  );
  const hasSshTarget = !!String(
    host?.machine?.metadata?.self_host_ssh_target ?? "",
  ).trim();
  const autoSetup = isSelfHost && hasSshTarget;
  const handleSetupClick = React.useCallback(() => {
    if (!host || !selfHost) return;
    onClose();
    selfHost.onSetup(host);
  }, [host, onClose, selfHost]);
  const showConnectorWarning =
    isSelfHost &&
    selfHostAlphaEnabled &&
    !!host &&
    !connectorOnline &&
    host.status === "off" &&
    !autoSetup;
  const connectorLabel = isSelfHost
    ? `Connector: ${host?.region ?? "n/a"}`
    : host?.region;
  const backupRegion =
    host?.region && host.machine?.cloud !== "self-host"
      ? mapCloudRegionToR2Region(host.region)
      : undefined;
  const backupRegionLabel = backupRegion
    ? (R2_REGION_LABELS[backupRegion] ?? backupRegion)
    : undefined;
  const connectorStatusTag = isSelfHost ? (
    <Tag color={connectorOnline ? "green" : "red"}>
      {connectorOnline ? "Connector online" : "Connector offline"}
    </Tag>
  ) : null;
  const hostOnline = !!host && isHostOnline(host.last_seen);
  const showOnlineTag = host?.status === "running" && hostOnline;
  const showStaleTag = host?.status === "running" && !hostOnline;
  const showSpinner = host ? isHostTransitioning(host.status) : false;
  const statusLabel = host ? (host.deleted ? "deleted" : host.status) : "";
  const activeOp = host ? hostOps?.[host.id] : undefined;
  const hostOpActive = host ? isHostOpActive(activeOp) : false;
  const opPhase = getHostOpPhase(activeOp);
  const canCancelBackups =
    !!activeOp?.op_id && hostOpActive && opPhase === "backups" && !!onCancelOp;
  const showUpgradeProgress =
    activeOp?.summary?.kind === "host-upgrade-software" ||
    activeOp?.kind === "host-upgrade-software" ||
    activeOp?.summary?.kind === "host-reconcile-software" ||
    activeOp?.kind === "host-reconcile-software";
  const upgradeConfirmContent = upgradeTitle({
    label: "all software",
    source: "the configured source",
  });
  const upgradeFromHubConfirmContent = upgradeTitle({
    label: "all software",
    source: "this hub source",
  });
  const softwareHelp = (
    <div style={{ maxWidth: 420 }}>
      <div style={{ marginBottom: 8 }}>
        This section compares the versions currently reported by the host with
        the newest versions available from the configured software source and
        from this site&apos;s <code>/software</code> endpoint.
      </div>
      <UpgradeConfirmContent />
    </div>
  );
  const onlineTag =
    host && !host.deleted ? (
      showOnlineTag ? (
        <Tooltip title={getHostOnlineTooltip(host.last_seen)}>
          <Tag color="green">online</Tag>
        </Tooltip>
      ) : showStaleTag ? (
        <Tooltip title={getHostOnlineTooltip(host.last_seen)}>
          <Tag color="default">offline</Tag>
        </Tooltip>
      ) : null
    ) : null;
  const canForceDeprovision =
    !!host && isSelfHost && !host.deleted && host.status !== "deprovisioned";
  const canReconcile =
    !!host &&
    !host.deleted &&
    host.status === "running" &&
    !!onReconcile &&
    !!host.machine?.cloud &&
    host.machine.cloud !== "self-host";
  const softwareSummary = React.useMemo(() => {
    if (!host) {
      return { upToDate: 0, updatesAvailable: 0, unknown: 0 };
    }
    let upToDate = 0;
    let updatesAvailable = 0;
    let unknown = 0;
    for (const { artifact } of SOFTWARE_ARTIFACTS) {
      const running = runningVersion(host, artifact);
      const latest = softwareVersions?.configured?.[artifact]?.version;
      const error = softwareVersions?.configured?.[artifact]?.error;
      if (!running || !latest || error) {
        unknown += 1;
      } else if (running === latest) {
        upToDate += 1;
      } else {
        updatesAvailable += 1;
      }
    }
    return { upToDate, updatesAvailable, unknown };
  }, [host, softwareVersions]);
  React.useEffect(() => {
    setShowProjects(false);
    setExpandedArtifacts({});
  }, [host?.id]);
  return (
    <Drawer
      size={drawerWidth}
      title={
        <Space>
          <Icon name="server" /> {host?.name ?? "Host details"}
          {host && (
            <Tooltip
              title={getHostStatusTooltip(
                host.status,
                Boolean(host.deleted),
                host.provider_observed_at,
              )}
            >
              <Tag color={host.deleted ? "default" : STATUS_COLOR[host.status]}>
                {showSpinner ? (
                  <Space size={4}>
                    <SyncOutlined spin />
                    <span>{statusLabel}</span>
                  </Space>
                ) : (
                  statusLabel
                )}
              </Tag>
            </Tooltip>
          )}
          {onlineTag}
          {host && (
            <Button
              type="link"
              size="small"
              disabled={!!host.deleted || hostOpActive}
              onClick={() => onEdit(host)}
            >
              Edit
            </Button>
          )}
        </Space>
      }
      onClose={onClose}
      resizable={{ onResize: handleResize }}
      open={open && !!host}
    >
      {host ? (
        <Space orientation="vertical" style={{ width: "100%" }} size="middle">
          <Space size="small">
            <Tag>
              {host.machine?.cloud
                ? isKnownProvider(host.machine.cloud)
                  ? getProviderDescriptor(host.machine.cloud).label
                  : host.machine.cloud
                : "provider: n/a"}
            </Tag>
            <Tag>{connectorLabel}</Tag>
            {backupRegionLabel && <Tag>Backup region: {backupRegionLabel}</Tag>}
            {connectorStatusTag}
            <Tag>{size?.primary ?? host.size}</Tag>
            {host.gpu && <Tag color="purple">GPU</Tag>}
            {host.reprovision_required && (
              <Tooltip title="Host config changed while stopped; will reprovision on next start.">
                <Tag color="orange">Reprovision on next start</Tag>
              </Tooltip>
            )}
          </Space>
          {!showUpgradeProgress && (
            <Space orientation="vertical" size="small">
              <HostOpProgress op={activeOp} />
              <HostBootstrapProgress host={host} />
              <HostBootstrapLifecycle host={host} detailed />
              {canCancelBackups && (
                <Popconfirm
                  title="Cancel backups for this host?"
                  okText="Cancel backups"
                  cancelText="Keep running"
                  onConfirm={() => onCancelOp?.(activeOp!.op_id)}
                >
                  <Button size="small" type="link">
                    Cancel backups
                  </Button>
                </Popconfirm>
              )}
            </Space>
          )}
          <Typography.Text copyable={{ text: host.id }}>
            Host ID: {host.id}
          </Typography.Text>
          {isSelfHost && host.region && (
            <Typography.Text copyable={{ text: host.region }}>
              Connector ID: {host.region}
            </Typography.Text>
          )}
          <Space orientation="vertical" size="small">
            {host.machine?.cloud && host.public_ip && (
              <Typography.Text copyable={{ text: host.public_ip }}>
                Public IP: {host.public_ip}
              </Typography.Text>
            )}
            {host.machine?.zone && (
              <Typography.Text>Zone: {host.machine.zone}</Typography.Text>
            )}
            {host.machine?.machine_type && (
              <Typography.Text>
                Machine type: {host.machine.machine_type}
              </Typography.Text>
            )}
            {host.machine?.gpu_type && (
              <Typography.Text>
                GPU type: {host.machine.gpu_type}
              </Typography.Text>
            )}
            {showHostResources && (
              <Typography.Text>
                Resources: {hostCpu ?? "?"} vCPU / {hostRam ?? "?"} GiB RAM /{" "}
                {hostDisk ?? "?"} disk
              </Typography.Text>
            )}
            {isSelfHost && host.machine?.metadata?.self_host_ssh_target && (
              <Typography.Text>
                SSH target: {host.machine.metadata.self_host_ssh_target}
              </Typography.Text>
            )}
          </Space>
          <Space orientation="vertical" size="small">
            <HostProjectStatus host={host} fontSize={14} />
            <Button size="small" onClick={() => setShowProjects(true)}>
              Browse projects
            </Button>
          </Space>
          <Card size="small" title="Current metrics">
            <HostCurrentMetrics host={host} />
          </Card>
          {parallelOps ? (
            <HostParallelOpsPanel
              host_id={host.id}
              status={parallelOps.status}
              loading={parallelOps.loading}
              savingKey={parallelOps.savingKey}
              onSetLimit={parallelOps.setLimit}
              onClearLimit={parallelOps.clearLimit}
            />
          ) : null}
          {(host.version ||
            host.project_bundle_version ||
            host.tools_version ||
            softwareVersions) && (
            <Space
              orientation="vertical"
              size="small"
              style={{ width: "100%" }}
            >
              <Space wrap align="center">
                <Typography.Text strong>Runtime software</Typography.Text>
                <Popover content={softwareHelp} trigger="click">
                  <Button
                    type="text"
                    size="small"
                    icon={<QuestionCircleOutlined />}
                  />
                </Popover>
                {softwareVersions && (
                  <Button
                    type="text"
                    size="small"
                    icon={<SyncOutlined spin={softwareVersions.loading} />}
                    onClick={() => {
                      softwareVersions.refresh().catch((err) => {
                        console.error(
                          "failed to refresh host software versions",
                          err,
                        );
                      });
                    }}
                  >
                    Refresh
                  </Button>
                )}
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Configured source: server default software base URL.
                {softwareVersions?.hubSourceBaseUrl
                  ? ` Hub source: ${softwareVersions.hubSourceBaseUrl}`
                  : " Hub source: this site's /software endpoint."}
              </Typography.Text>
              <Space wrap size={[8, 8]}>
                <Tag color="green">{softwareSummary.upToDate} up to date</Tag>
                <Tag color="orange">
                  {softwareSummary.updatesAvailable} updates available
                </Tag>
                {softwareSummary.unknown > 0 && (
                  <Tag>{softwareSummary.unknown} unknown</Tag>
                )}
              </Space>
              {softwareVersions?.configuredError && (
                <Alert
                  type="warning"
                  showIcon
                  title="Configured source lookup failed"
                  description={softwareVersions.configuredError}
                />
              )}
              {softwareVersions?.hubError && (
                <Alert
                  type="warning"
                  showIcon
                  title="Hub source lookup failed"
                  description={softwareVersions.hubError}
                />
              )}
              {showUpgradeProgress && <HostOpProgress op={activeOp} />}
              <Space
                orientation="vertical"
                size="small"
                style={{ width: "100%" }}
              >
                {SOFTWARE_ARTIFACTS.map(({ artifact, label, runningLabel }) => {
                  const running = runningVersion(host, artifact);
                  const buildId = runningBuildId(host, artifact);
                  const configured = softwareVersions?.configured?.[artifact];
                  const hubVersion = softwareVersions?.hub?.[artifact];
                  const commands = cliCommandsForArtifact({ host, artifact });
                  const expanded = !!expandedArtifacts[artifact];
                  return (
                    <Card
                      key={artifact}
                      size="small"
                      styles={{ body: { padding: "12px" } }}
                    >
                      <Space
                        orientation="vertical"
                        size="small"
                        style={{ width: "100%" }}
                      >
                        <Space wrap align="center">
                          <Typography.Text strong>{label}</Typography.Text>
                          {artifactStatusTag({
                            running,
                            latest: configured?.version,
                            error: configured?.error,
                          })}
                          <Typography.Text
                            type="secondary"
                            style={{ fontSize: 12 }}
                          >
                            {runningLabel}
                          </Typography.Text>
                        </Space>
                        <Space
                          wrap
                          align="center"
                          style={{
                            justifyContent: "space-between",
                            width: "100%",
                          }}
                        >
                          <Typography.Text type="secondary">
                            running <code>{running ?? "n/a"}</code> | latest
                            available{" "}
                            <code>{configured?.version ?? "unknown"}</code>
                          </Typography.Text>
                          <Space wrap>
                            {canUpgrade &&
                              !host.deleted &&
                              onUpgradeArtifact && (
                                <Popconfirm
                                  title={upgradeTitle({
                                    label,
                                    source: "the configured source",
                                  })}
                                  okText="Upgrade"
                                  cancelText="Cancel"
                                  onConfirm={() =>
                                    onUpgradeArtifact({
                                      host,
                                      artifact,
                                    })
                                  }
                                  disabled={
                                    hostOpActive || host.status !== "running"
                                  }
                                >
                                  <Button
                                    size="small"
                                    disabled={
                                      hostOpActive || host.status !== "running"
                                    }
                                  >
                                    Upgrade
                                  </Button>
                                </Popconfirm>
                              )}
                            <Button
                              size="small"
                              type="link"
                              onClick={() =>
                                setExpandedArtifacts((prev) => ({
                                  ...prev,
                                  [artifact]: !prev[artifact],
                                }))
                              }
                            >
                              {expanded ? "Hide details" : "Details"}
                            </Button>
                          </Space>
                        </Space>
                        {expanded && (
                          <Space
                            orientation="vertical"
                            size="small"
                            style={{ width: "100%" }}
                          >
                            {buildId && (
                              <Typography.Text copyable={{ text: buildId }}>
                                Build ID: <code>{buildId}</code>
                              </Typography.Text>
                            )}
                            <Typography.Text>
                              Latest hub source:{" "}
                              <code>{hubVersion?.version ?? "unknown"}</code>{" "}
                              {artifactStatusTag({
                                running,
                                latest: hubVersion?.version,
                                error: hubVersion?.error,
                              })}
                            </Typography.Text>
                            <Space wrap>
                              {canUpgrade &&
                                !host.deleted &&
                                onUpgradeArtifact && (
                                  <Popconfirm
                                    title={upgradeTitle({
                                      label,
                                      source: "this hub source",
                                    })}
                                    okText="Upgrade"
                                    cancelText="Cancel"
                                    onConfirm={() =>
                                      onUpgradeArtifact({
                                        host,
                                        artifact,
                                        useHubSource: true,
                                      })
                                    }
                                    disabled={
                                      hostOpActive || host.status !== "running"
                                    }
                                  >
                                    <Button
                                      size="small"
                                      disabled={
                                        hostOpActive ||
                                        host.status !== "running"
                                      }
                                    >
                                      Upgrade from hub
                                    </Button>
                                  </Popconfirm>
                                )}
                              <Popover
                                trigger="click"
                                title={`${label} CLI`}
                                content={
                                  <div style={{ maxWidth: 520 }}>
                                    {commands.map((command) => (
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
                                <Button
                                  size="small"
                                  type="text"
                                  icon={<CodeOutlined />}
                                >
                                  CLI
                                </Button>
                              </Popover>
                            </Space>
                          </Space>
                        )}
                      </Space>
                    </Card>
                  );
                })}
              </Space>
              <Space wrap>
                {canReconcile && host && onReconcile && (
                  <Popconfirm
                    title="Run bootstrap/software reconcile on this host?"
                    okText="Reconcile"
                    cancelText="Cancel"
                    onConfirm={() => onReconcile(host)}
                    disabled={hostOpActive}
                  >
                    <Button size="small" disabled={hostOpActive}>
                      Reconcile
                    </Button>
                  </Popconfirm>
                )}
                {canUpgrade && host && !host.deleted && onUpgrade && (
                  <Popconfirm
                    title={upgradeConfirmContent}
                    okText="Upgrade"
                    cancelText="Cancel"
                    onConfirm={() => onUpgrade(host)}
                    disabled={hostOpActive || host.status !== "running"}
                  >
                    <Button
                      size="small"
                      disabled={hostOpActive || host.status !== "running"}
                    >
                      Upgrade all
                    </Button>
                  </Popconfirm>
                )}
                {canUpgrade && host && !host.deleted && onUpgradeFromHub && (
                  <Popconfirm
                    title={upgradeFromHubConfirmContent}
                    okText="Upgrade"
                    cancelText="Cancel"
                    onConfirm={() => onUpgradeFromHub(host)}
                    disabled={hostOpActive || host.status !== "running"}
                  >
                    <Button
                      size="small"
                      disabled={hostOpActive || host.status !== "running"}
                    >
                      Upgrade all from hub
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            </Space>
          )}
          <HostRootfsCachePanel
            host={host}
            canManage={!!canManageRootfs}
            inventory={rootfsInventory}
          />
          {showConnectorWarning && selfHost && (
            <Alert
              type="warning"
              showIcon
              title="Connector offline"
              description={
                <Button size="small" onClick={handleSetupClick}>
                  Set up connector
                </Button>
              }
            />
          )}
          {isSelfHost && selfHost && !host.deleted && (
            <Space orientation="vertical" size="small">
              <Typography.Text strong>Connector actions</Typography.Text>
              <Space wrap>
                <Button
                  size="small"
                  disabled={hostOpActive}
                  onClick={handleSetupClick}
                >
                  Setup or reconnect
                </Button>
                <Button
                  size="small"
                  danger
                  disabled={hostOpActive}
                  onClick={() => selfHost.onRemove(host)}
                >
                  Remove connector
                </Button>
                {canForceDeprovision && (
                  <Popconfirm
                    title="Force deprovision this host without contacting your machine?"
                    okText="Force deprovision"
                    cancelText="Cancel"
                    onConfirm={() => selfHost.onForceDeprovision(host)}
                    okButtonProps={{ danger: true }}
                  >
                    <Button size="small" disabled={hostOpActive}>
                      Force deprovision
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            </Space>
          )}
          <Typography.Text type="secondary">
            Last seen:{" "}
            {host.last_seen ? new Date(host.last_seen).toLocaleString() : "n/a"}
          </Typography.Text>
          {host.status === "error" && host.last_error && (
            <Alert
              type="error"
              showIcon
              title="Provisioning error"
              description={host.last_error}
            />
          )}
          <Divider />
          <Typography.Title level={5}>Recent actions</Typography.Title>
          {loadingLog ? (
            <Typography.Text type="secondary">Loading…</Typography.Text>
          ) : hostLog.length === 0 ? (
            <Typography.Text type="secondary">No actions yet.</Typography.Text>
          ) : (
            <Space
              orientation="vertical"
              style={{ width: "100%" }}
              size="small"
            >
              {hostLog.map((entry) => (
                <Card
                  key={entry.id}
                  size="small"
                  styles={{ body: { padding: "10px 12px" } }}
                >
                  {(() => {
                    const change = describeSpecChange(entry.spec);
                    const showDetails = !!change.details;
                    const detailLink = showDetails ? (
                      <Popover
                        title="Config changes"
                        content={
                          <pre style={{ margin: 0, fontSize: 11 }}>
                            {change.details}
                          </pre>
                        }
                      >
                        <a style={{ marginLeft: 8 }}>Details</a>
                      </Popover>
                    ) : null;
                    return (
                      <>
                        {change.summary && (
                          <div style={{ fontSize: 12, marginBottom: 6 }}>
                            Config updated: {change.summary}
                            {detailLink}
                          </div>
                        )}
                      </>
                    );
                  })()}
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <div style={{ fontWeight: 600 }}>
                      {entry.action} — {entry.status}
                    </div>
                    {entry.provider && (
                      <div style={{ color: "#666", fontSize: 12 }}>
                        Provider: {entry.provider}
                      </div>
                    )}
                    <div style={{ color: "#888", fontSize: 12 }}>
                      {entry.ts
                        ? new Date(entry.ts).toLocaleString()
                        : "unknown time"}
                    </div>
                    {entry.error && (
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
                        {entry.error}
                      </div>
                    )}
                  </div>
                </Card>
              ))}
            </Space>
          )}
          <HostProjectsBrowser
            host={host}
            open={showProjects}
            onClose={() => setShowProjects(false)}
          />
          <Divider />
          <Typography.Title level={5}>Activity</Typography.Title>
        </Space>
      ) : (
        <Typography.Text type="secondary">
          Select a host to see details.
        </Typography.Text>
      )}
    </Drawer>
  );
};
