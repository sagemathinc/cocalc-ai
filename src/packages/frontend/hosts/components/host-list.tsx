import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  Modal,
  Popconfirm,
  Popover,
  Radio,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { SyncOutlined } from "@ant-design/icons";
import { React } from "@cocalc/frontend/app-framework";
import { Tooltip } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import type {
  Host,
  HostCatalog,
  HostRuntimeDeploymentRecord,
  HostSoftwareAvailableVersion,
} from "@cocalc/conat/hub/api/hosts";
import type { ParallelOpsWorkerStatus } from "@cocalc/conat/hub/api/system";
import { HostCard } from "./host-card";
import {
  STATUS_COLOR,
  getHostOnlineTooltip,
  getHostStatusTooltip,
  isHostOnline,
  isHostTransitioning,
} from "../constants";
import type { ColumnsType } from "antd/es/table";
import { COLORS } from "@cocalc/util/theme";
import { getProviderDescriptor, isKnownProvider } from "../providers/registry";
import type { HostLroState } from "../hooks/use-host-ops";
import { getHostOpPhase, HostOpProgress } from "./host-op-progress";
import { HostBackupStatus } from "./host-backup-status";
import { HostBootstrapProgress } from "./host-bootstrap-progress";
import { HostBootstrapLifecycle } from "./host-bootstrap-lifecycle";
import { HostDaemonHealthSummary } from "./host-daemon-health-summary";
import { HostProjectStatus } from "./host-project-status";
import {
  confirmBulkHostDeprovision,
  confirmHostDeprovision,
  confirmHostDrain,
  confirmHostStop,
} from "./host-confirm";
import { isHostOpActive } from "../hooks/use-host-ops";
import { UpgradeConfirmContent } from "./upgrade-confirmation";
import { HostParallelOpsSummary } from "./host-parallel-ops-summary";
import { HostCurrentMetrics } from "./host-current-metrics";
import { HostRuntimeVersionsPanel } from "./host-runtime-versions-panel";
import { search_match, search_split } from "@cocalc/util/misc";
import type {
  HostListViewMode,
  HostSortDirection,
  HostSortField,
  HostStopOptions,
  HostDeleteOptions,
  HostDrainOptions,
} from "../types";
import { getHostSizeDisplay } from "../utils/format";
import {
  currentProjectHostAutomaticRollback,
  projectHostRollbackReasonLabel,
  shouldSuppressProjectHostFailedOp,
} from "../utils/project-host-rollout";
import {
  currentHostRuntimeExceptionSummary,
  hostRuntimeExceptionDescription,
  hostRuntimeExceptionLabel,
} from "../utils/runtime-exceptions";

const STATUS_ORDER = [
  "running",
  "starting",
  "restarting",
  "off",
  "stopping",
  "deprovisioning",
  "error",
  "deprovisioned",
  "deleted",
] as const;

const STATUS_RANK = new Map(
  STATUS_ORDER.map((status, index) => [status, index]),
);

const HOSTS_SEARCH_STORAGE_KEY = "cocalc:hosts:search";

function readHostsSearch(): string {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return window.localStorage.getItem(HOSTS_SEARCH_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function persistHostsSearch(value: string) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(HOSTS_SEARCH_STORAGE_KEY, value);
  } catch {}
}

function getProviderLabel(host: Host): string {
  const cloud = host.machine?.cloud;
  if (!cloud) return "n/a";
  if (isKnownProvider(cloud)) {
    return getProviderDescriptor(cloud).label;
  }
  return cloud;
}

function getSelfHostDetail(host: Host): string | undefined {
  if (host.machine?.cloud !== "self-host") return undefined;
  const kind = host.machine?.metadata?.self_host_kind as string | undefined;
  const mode = host.machine?.metadata?.self_host_mode as string | undefined;
  const kindLabel =
    kind === "direct"
      ? "Direct"
      : kind === "multipass"
        ? "Multipass"
        : undefined;
  const modeLabel =
    mode === "cloudflare"
      ? "Cloudflare tunnel"
      : mode === "local"
        ? "Local network"
        : undefined;
  if (kindLabel && modeLabel) return `${kindLabel} / ${modeLabel}`;
  return kindLabel ?? modeLabel ?? undefined;
}

function compareText(a?: string, b?: string): number {
  return (a ?? "").localeCompare(b ?? "", undefined, { sensitivity: "base" });
}

function compareNumber(a?: number, b?: number): number {
  return (a ?? 0) - (b ?? 0);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sortHosts(
  hosts: Host[],
  field: HostSortField,
  direction: HostSortDirection,
): Host[] {
  const dir = direction === "asc" ? 1 : -1;
  return [...hosts].sort((a, b) => {
    let result = 0;
    switch (field) {
      case "starred":
        result = compareNumber(
          Number(b.starred ?? false),
          Number(a.starred ?? false),
        );
        break;
      case "name":
        result = compareText(a.name, b.name);
        break;
      case "provider":
        result = compareText(getProviderLabel(a), getProviderLabel(b));
        break;
      case "region":
        result = compareText(a.region, b.region);
        break;
      case "size":
        result = compareText(a.size, b.size);
        break;
      case "status": {
        const aStatus = a.deleted ? "deleted" : a.status;
        const bStatus = b.deleted ? "deleted" : b.status;
        const aRank = STATUS_RANK.get(aStatus) ?? STATUS_ORDER.length;
        const bRank = STATUS_RANK.get(bStatus) ?? STATUS_ORDER.length;
        result = compareNumber(aRank, bRank);
        break;
      }
      case "changed": {
        const aRaw = a.last_action_at ?? a.last_seen ?? "";
        const bRaw = b.last_action_at ?? b.last_seen ?? "";
        const aTs = aRaw ? Date.parse(aRaw) : 0;
        const bTs = bRaw ? Date.parse(bRaw) : 0;
        result = compareNumber(
          Number.isNaN(aTs) ? 0 : aTs,
          Number.isNaN(bTs) ? 0 : bTs,
        );
        break;
      }
      default:
        result = 0;
    }
    if (result !== 0) return dir * result;
    const nameResult = compareText(a.name, b.name);
    if (nameResult !== 0) return nameResult;
    return (a.id ?? "").localeCompare(b.id ?? "");
  });
}

type HostListViewModel = {
  hosts: Host[];
  hostsLoading?: boolean;
  hostsLoaded?: boolean;
  hostsError?: string | null;
  hostOps?: Record<string, HostLroState>;
  createPanelOpen?: boolean;
  onStart: (id: string) => void;
  onStop: (id: string, opts?: HostStopOptions) => void;
  onRestart: (id: string, mode: "reboot" | "hard") => void;
  onDrain: (id: string, opts?: HostDrainOptions) => void;
  onDelete: (id: string, opts?: HostDeleteOptions) => void;
  onToggleCreatePanel?: () => void;
  onRefresh: () => void;
  onCancelOp?: (op_id: string) => void;
  onUpgrade?: (host: Host) => void;
  onUpgradeFromHub?: (host: Host) => void;
  onDetails: (host: Host) => void;
  onEdit: (host: Host) => void;
  onToggleStar: (host: Host) => void;
  selfHost?: {
    connectorMap: Map<
      string,
      { id: string; name?: string; last_seen?: string }
    >;
    isConnectorOnline: (connectorId?: string) => boolean;
    onSetup: (host: Host) => void;
  };
  viewMode: HostListViewMode;
  setViewMode: (mode: HostListViewMode) => void;
  isAdmin: boolean;
  showAdmin: boolean;
  setShowAdmin: (value: boolean) => void;
  showParallelLimits: boolean;
  setShowParallelLimits: (value: boolean) => void;
  showRuntimeVersions: boolean;
  setShowRuntimeVersions: (value: boolean) => void;
  showDeleted: boolean;
  setShowDeleted: (value: boolean) => void;
  sortField: HostSortField;
  setSortField: (value: HostSortField) => void;
  sortDirection: HostSortDirection;
  setSortDirection: (value: HostSortDirection) => void;
  autoResort: boolean;
  setAutoResort: (value: boolean) => void;
  providerCapabilities?: HostCatalog["provider_capabilities"];
  parallelOps?: {
    status: ParallelOpsWorkerStatus[];
    loading?: boolean;
    error?: string;
    savingKey?: string;
    refresh: () => void | Promise<void>;
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
  runtimeVersions?: {
    loading?: boolean;
    configured: HostSoftwareAvailableVersion[];
    configuredError?: string;
    hub: HostSoftwareAvailableVersion[];
    hubError?: string;
    globalDeployments: HostRuntimeDeploymentRecord[];
    globalDeploymentsError?: string;
    hubSourceLabel?: string;
    refresh: () => void | Promise<void>;
    onSetClusterDefault?: (opts: {
      artifact: HostSoftwareAvailableVersion["artifact"];
      desired_version: string;
      source: "configured" | "hub";
    }) => void | Promise<void>;
    settingClusterDefaultKey?: string;
    onAlignProjectHostFleetVersion?: (opts: {
      desired_version: string;
      source: "configured" | "hub";
    }) => void | Promise<void>;
    aligningProjectHostFleetKey?: string;
  };
};

export const HostList: React.FC<{ vm: HostListViewModel }> = ({ vm }) => {
  const {
    hosts,
    hostsLoading = false,
    hostsLoaded = true,
    hostsError = null,
    hostOps,
    createPanelOpen,
    onStart,
    onStop,
    onRestart,
    onDrain,
    onDelete,
    onToggleCreatePanel,
    onRefresh,
    onCancelOp,
    onUpgrade,
    onUpgradeFromHub,
    onDetails,
    onEdit,
    onToggleStar,
    selfHost,
    viewMode,
    setViewMode,
    isAdmin,
    showAdmin,
    setShowAdmin,
    showParallelLimits,
    setShowParallelLimits,
    showRuntimeVersions,
    setShowRuntimeVersions,
    showDeleted,
    setShowDeleted,
    sortField,
    setSortField,
    sortDirection,
    setSortDirection,
    autoResort,
    setAutoResort,
    providerCapabilities,
    parallelOps,
    runtimeVersions,
  } = vm;

  const [selectedRowKeys, setSelectedRowKeys] = React.useState<string[]>([]);
  const [restartTarget, setRestartTarget] = React.useState<Host | null>(null);
  const [searchText, setSearchText] = React.useState<string>(readHostsSearch);
  React.useEffect(() => {
    persistHostsSearch(searchText);
  }, [searchText]);

  const [showHardRestartHelp, setShowHardRestartHelp] = React.useState(false);

  const closeRestart = React.useCallback(() => {
    setRestartTarget(null);
    setShowHardRestartHelp(false);
  }, []);

  const restartCaps = React.useMemo(() => {
    const providerId = restartTarget?.machine?.cloud;
    const caps = providerId ? providerCapabilities?.[providerId] : undefined;
    return {
      supportsRestart: caps?.supportsRestart ?? true,
      supportsHardRestart: caps?.supportsHardRestart ?? false,
    };
  }, [providerCapabilities, restartTarget]);
  const restartHelp = React.useMemo(() => {
    if (restartCaps.supportsRestart && restartCaps.supportsHardRestart) {
      return "Reboot attempts a graceful restart. Hard reboot forces a power cycle.";
    }
    if (restartCaps.supportsRestart) {
      return "Reboot attempts a graceful restart.";
    }
    if (restartCaps.supportsHardRestart) {
      return "Hard reboot forces a power cycle.";
    }
    return "Restart is not available for this provider.";
  }, [restartCaps.supportsRestart, restartCaps.supportsHardRestart]);

  const runRestart = React.useCallback(
    async (mode: "reboot" | "hard") => {
      if (!restartTarget) return;
      const target = restartTarget;
      closeRestart();
      await onRestart(target.id, mode);
    },
    [closeRestart, onRestart, restartTarget],
  );

  const [dynamicOrder, setDynamicOrder] = React.useState<string[]>([]);
  const sortKeyRef = React.useRef<string>("");
  const isDynamicSort = sortField === "status" || sortField === "changed";
  const searchTerms = React.useMemo(() => {
    const trimmed = searchText.trim();
    return trimmed ? search_split(trimmed) : [];
  }, [searchText]);
  const filteredHosts = React.useMemo(() => {
    if (!searchTerms.length) return hosts;
    return hosts.filter((host) => {
      const statusLabel = host.deleted ? "deleted" : host.status;
      const selfHostDetail = getSelfHostDetail(host);
      const size = getHostSizeDisplay(host);
      const haystack = [
        host.name,
        getProviderLabel(host),
        host.pricing_model,
        selfHostDetail,
        host.region,
        host.size,
        size.primary,
        size.secondary,
        statusLabel,
      ]
        .filter(Boolean)
        .join(" ");
      return search_match(haystack, searchTerms);
    });
  }, [hosts, searchTerms]);
  const filterActive = !!searchText.trim();
  const visibleHosts = filteredHosts;

  React.useEffect(() => {
    if (viewMode !== "list" && selectedRowKeys.length) {
      setSelectedRowKeys([]);
    }
  }, [viewMode, selectedRowKeys.length]);

  React.useEffect(() => {
    if (!selectedRowKeys.length) return;
    const hostIds = new Set(visibleHosts.map((host) => host.id));
    setSelectedRowKeys((prev) => prev.filter((id) => hostIds.has(id)));
  }, [visibleHosts, selectedRowKeys.length]);

  React.useEffect(() => {
    if (!isDynamicSort) {
      setDynamicOrder((prev) => (prev.length ? [] : prev));
      sortKeyRef.current = `${sortField}:${sortDirection}`;
      return;
    }
    const sortKey = `${sortField}:${sortDirection}`;
    const sortChanged = sortKeyRef.current !== sortKey;
    sortKeyRef.current = sortKey;
    setDynamicOrder((prev) => {
      if (autoResort || prev.length === 0 || sortChanged) {
        const next = sortHosts(visibleHosts, sortField, sortDirection).map(
          (host) => host.id,
        );
        return arraysEqual(prev, next) ? prev : next;
      }
      const hostIds = new Set(visibleHosts.map((host) => host.id));
      const current = prev.filter((id) => hostIds.has(id));
      const currentSet = new Set(current);
      const missing = visibleHosts.filter((host) => !currentSet.has(host.id));
      if (!missing.length && current.length === prev.length) {
        return prev;
      }
      const sortedMissing = sortHosts(missing, sortField, sortDirection).map(
        (host) => host.id,
      );
      const next = [...current, ...sortedMissing];
      return arraysEqual(prev, next) ? prev : next;
    });
  }, [visibleHosts, sortField, sortDirection, autoResort, isDynamicSort]);

  const sortedHosts = React.useMemo(() => {
    if (isDynamicSort && !autoResort && dynamicOrder.length) {
      const hostMap = new Map(visibleHosts.map((host) => [host.id, host]));
      const ordered = dynamicOrder
        .map((id) => hostMap.get(id))
        .filter((host): host is Host => !!host);
      const orderedIds = new Set(ordered.map((host) => host.id));
      if (ordered.length === visibleHosts.length) {
        return ordered;
      }
      const missing = visibleHosts.filter((host) => !orderedIds.has(host.id));
      if (!missing.length) return ordered;
      return ordered.concat(sortHosts(missing, sortField, sortDirection));
    }
    return sortHosts(visibleHosts, sortField, sortDirection);
  }, [
    visibleHosts,
    sortField,
    sortDirection,
    autoResort,
    dynamicOrder,
    isDynamicSort,
  ]);

  const resortNow = React.useCallback(() => {
    if (!isDynamicSort) return;
    setDynamicOrder((prev) => {
      const next = sortHosts(visibleHosts, sortField, sortDirection).map(
        (host) => host.id,
      );
      return arraysEqual(prev, next) ? prev : next;
    });
  }, [visibleHosts, sortField, sortDirection, isDynamicSort]);

  const selectedHosts = React.useMemo(() => {
    if (!selectedRowKeys.length) return [] as Host[];
    const hostMap = new Map(visibleHosts.map((host) => [host.id, host]));
    return selectedRowKeys
      .map((id) => hostMap.get(id))
      .filter((host): host is Host => !!host);
  }, [visibleHosts, selectedRowKeys]);

  const startTargets = React.useMemo(
    () =>
      selectedHosts.filter(
        (host) =>
          !host.deleted &&
          host.status !== "running" &&
          host.status !== "starting" &&
          (!selfHost?.isConnectorOnline ||
            host.machine?.cloud !== "self-host" ||
            selfHost.isConnectorOnline(host.region)),
      ),
    [selectedHosts, selfHost],
  );
  const stopTargets = React.useMemo(
    () =>
      selectedHosts.filter((host) => {
        if (host.deleted) return false;
        if (!(host.status === "running" || host.status === "error"))
          return false;
        const providerId = host.machine?.cloud;
        const caps = providerId
          ? providerCapabilities?.[providerId]
          : undefined;
        if (caps?.supportsStop === false) return false;
        if (host.machine?.storage_mode === "ephemeral") return false;
        return true;
      }),
    [selectedHosts, providerCapabilities],
  );
  const deprovisionTargets = React.useMemo(
    () =>
      selectedHosts.filter(
        (host) => !host.deleted && host.status !== "deprovisioned",
      ),
    [selectedHosts],
  );
  const deleteTargets = React.useMemo(
    () =>
      selectedHosts.filter(
        (host) => !host.deleted && host.status === "deprovisioned",
      ),
    [selectedHosts],
  );
  const upgradeTargets = React.useMemo(
    () =>
      selectedHosts.filter((host) => {
        if (host.deleted) return false;
        if (host.status !== "running") return false;
        if (isHostOpActive(hostOps?.[host.id])) return false;
        return true;
      }),
    [selectedHosts, hostOps],
  );

  const upgradeNotice = <UpgradeConfirmContent />;

  const runBulkAction = React.useCallback(
    async (
      actionLabel: string,
      targets: Host[],
      handler: (host: Host) => Promise<void> | void,
      opts?: { danger?: boolean; notice?: React.ReactNode },
    ) => {
      if (!targets.length) return;
      Modal.confirm({
        title: `${actionLabel} ${targets.length} host${
          targets.length === 1 ? "" : "s"
        }?`,
        content: (
          <div>
            <Typography.Text type="secondary">
              This will apply to:
            </Typography.Text>
            <ul style={{ maxHeight: 240, overflowY: "auto", marginTop: 8 }}>
              {targets.map((host) => (
                <li key={host.id}>
                  {host.name} ({getProviderLabel(host)})
                </li>
              ))}
            </ul>
            {opts?.notice}
          </div>
        ),
        okText: actionLabel,
        okButtonProps: opts?.danger ? { danger: true } : undefined,
        onOk: async () => {
          for (const host of targets) {
            await handler(host);
          }
          setSelectedRowKeys([]);
        },
      });
    },
    [],
  );

  const columns: ColumnsType<Host> = [
    {
      title: (
        <Icon
          name="star-filled"
          style={{ fontSize: 16, color: COLORS.YELL_LL }}
        />
      ),
      dataIndex: "starred",
      key: "starred",
      width: 48,
      align: "center",
      sorter: true,
      sortDirections: ["ascend", "descend"],
      sortOrder:
        sortField === "starred"
          ? sortDirection === "asc"
            ? "ascend"
            : "descend"
          : undefined,
      onCell: () => ({
        onClick: (event: React.MouseEvent) => {
          event.stopPropagation();
        },
        style: { cursor: "pointer" },
      }),
      render: (starred: boolean, host: Host) => (
        <span
          onClick={(event) => {
            event.stopPropagation();
            onToggleStar(host);
          }}
          style={{ cursor: "pointer", fontSize: 18 }}
        >
          <Icon
            name={starred ? "star-filled" : "star"}
            style={{
              color: starred ? COLORS.STAR : COLORS.GRAY_L,
            }}
          />
        </span>
      ),
    },
    {
      title: "Name",
      dataIndex: "name",
      key: "name",
      sorter: true,
      sortDirections: ["ascend", "descend"],
      sortOrder:
        sortField === "name"
          ? sortDirection === "asc"
            ? "ascend"
            : "descend"
          : undefined,
      render: (_: string, host: Host) => (
        <Space orientation="vertical" size={0}>
          <Space size="small" wrap>
            <Button type="link" onClick={() => onDetails(host)}>
              {host.name}
            </Button>
            {host.pricing_model === "spot" && <Tag color="orange">spot</Tag>}
          </Space>
          {host.status === "error" && host.last_error && (
            <Popover
              title="Error"
              content={
                <div style={{ maxWidth: 360, whiteSpace: "pre-wrap" }}>
                  {host.last_error}
                </div>
              }
            >
              <Button
                size="small"
                type="link"
                danger
                style={{ padding: 0, height: "auto" }}
              >
                Error
              </Button>
            </Popover>
          )}
        </Space>
      ),
    },
    {
      title: "Provider",
      key: "provider",
      sorter: true,
      sortDirections: ["ascend", "descend"],
      sortOrder:
        sortField === "provider"
          ? sortDirection === "asc"
            ? "ascend"
            : "descend"
          : undefined,
      render: (_: string, host: Host) => {
        const baseLabel = getProviderLabel(host);
        const detail = getSelfHostDetail(host);
        if (!detail && host.pricing_model !== "spot") return baseLabel;
        return (
          <Space orientation="vertical" size={0}>
            <Space size="small" wrap>
              <span>{baseLabel}</span>
              {host.pricing_model === "spot" && <Tag color="orange">spot</Tag>}
            </Space>
            {detail && (
              <Typography.Text type="secondary">{detail}</Typography.Text>
            )}
          </Space>
        );
      },
    },
    {
      title: "Region",
      dataIndex: "region",
      key: "region",
      width: 140,
      sorter: true,
      sortDirections: ["ascend", "descend"],
      sortOrder:
        sortField === "region"
          ? sortDirection === "asc"
            ? "ascend"
            : "descend"
          : undefined,
      render: (_: string, host: Host) =>
        host.machine?.cloud === "self-host"
          ? `Connector: ${host.region}`
          : host.region,
    },
    {
      title: "Size",
      dataIndex: "size",
      key: "size",
      sorter: true,
      sortDirections: ["ascend", "descend"],
      sortOrder:
        sortField === "size"
          ? sortDirection === "asc"
            ? "ascend"
            : "descend"
          : undefined,
      render: (_: string, host: Host) => {
        const size = getHostSizeDisplay(host);
        if (!size.secondary) return size.primary;
        return (
          <Space orientation="vertical" size={0}>
            <span>{size.primary}</span>
            <Typography.Text type="secondary">{size.secondary}</Typography.Text>
          </Space>
        );
      },
    },
    {
      title: "GPU",
      key: "gpu",
      render: (_: string, host: Host) => (host.gpu ? "Yes" : "No"),
    },
    {
      title: "Resources",
      key: "resources",
      render: (_: string, host: Host) =>
        host.deleted || host.status === "deprovisioned" ? (
          <Typography.Text type="secondary">-</Typography.Text>
        ) : (
          <HostCurrentMetrics host={host} compact dense />
        ),
    },
    {
      title: "Status",
      key: "status",
      width: 320,
      sorter: true,
      sortDirections: ["ascend", "descend"],
      sortOrder:
        sortField === "status"
          ? sortDirection === "asc"
            ? "ascend"
            : "descend"
          : undefined,
      render: (_: string, host: Host) => {
        const hostOnline = isHostOnline(host.last_seen);
        const showOnlineTag = host.status === "running" && hostOnline;
        const showStaleTag = host.status === "running" && !hostOnline;
        const showSpinner = isHostTransitioning(host.status);
        const statusLabel = host.deleted ? "deleted" : host.status;
        const op = hostOps?.[host.id];
        const runtimeExceptionSummary =
          currentHostRuntimeExceptionSummary(host);
        const projectHostRollback = currentProjectHostAutomaticRollback({
          observation: host.observed_host_agent?.project_host,
          currentVersion: host.version,
        });
        const displayOp = shouldSuppressProjectHostFailedOp({
          op,
          currentVersion: host.version,
          observation: host.observed_host_agent?.project_host,
        })
          ? undefined
          : op;
        return (
          <Space orientation="vertical" size={2}>
            <Space size="small">
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
                >
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
              {showOnlineTag && (
                <Tooltip title={getHostOnlineTooltip(host.last_seen)}>
                  <Tag color="green">online</Tag>
                </Tooltip>
              )}
              {showStaleTag && (
                <Tooltip title={getHostOnlineTooltip(host.last_seen)}>
                  <Tag color="orange">offline</Tag>
                </Tooltip>
              )}
              {runtimeExceptionSummary && (
                <Tooltip
                  title={hostRuntimeExceptionDescription(
                    runtimeExceptionSummary,
                  )}
                >
                  <Tag color="blue">
                    {hostRuntimeExceptionLabel(runtimeExceptionSummary)}
                  </Tag>
                </Tooltip>
              )}
            </Space>
            <HostOpProgress op={displayOp} compact />
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
        );
      },
    },
    {
      title: "Actions",
      key: "actions",
      render: (_: string, host: Host) => {
        const isDeleted = !!host.deleted;
        const op = hostOps?.[host.id];
        const hostOpActive = isHostOpActive(op);
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
          host.status === "running" ||
          host.status === "starting" ||
          host.status === "restarting" ||
          (!connectorOnline && !autoSetup) ||
          hostOpActive;
        const startLabel =
          host.status === "starting"
            ? "Starting"
            : host.status === "restarting"
              ? "Restarting"
              : "Start";
        const stopLabel = host.status === "stopping" ? "Stopping" : "Stop";
        const statusValue = host.status;
        const providerId = host.machine?.cloud;
        const caps = providerId
          ? providerCapabilities?.[providerId]
          : undefined;
        const allowStop =
          !isDeleted &&
          (statusValue === "running" || statusValue === "error") &&
          caps?.supportsStop !== false &&
          host.machine?.storage_mode !== "ephemeral" &&
          !hostOpActive;
        const supportsRestart = caps?.supportsRestart ?? true;
        const supportsHardRestart = caps?.supportsHardRestart ?? false;
        const allowRestart =
          !isDeleted &&
          connectorOnline &&
          (statusValue === "running" || statusValue === "error") &&
          (supportsRestart || supportsHardRestart) &&
          !hostOpActive;
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
        const opPhase = getHostOpPhase(op);
        const canCancelBackups =
          !!op?.op_id && hostOpActive && opPhase === "backups";

        const actions = [
          <Button
            key="start"
            size="small"
            type="link"
            disabled={startDisabled}
            onClick={() => onStart(host.id)}
          >
            {startLabel}
          </Button>,
          showConnectorSetup && selfHost ? (
            <Button
              key="setup"
              size="small"
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
              size="small"
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
            <Button key="stop" size="small" type="link" disabled>
              {stopLabel}
            </Button>
          ),
          allowRestart ? (
            <Button
              key="restart"
              size="small"
              type="link"
              onClick={() => setRestartTarget(host)}
            >
              Restart
            </Button>
          ) : (
            <Button key="restart" size="small" type="link" disabled>
              Restart
            </Button>
          ),
          <Button
            key="drain"
            size="small"
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
          </Button>,
          canCancelBackups && onCancelOp ? (
            <Popconfirm
              key="cancel"
              title="Cancel backups for this host?"
              okText="Cancel backups"
              cancelText="Keep running"
              onConfirm={() => onCancelOp(op!.op_id)}
            >
              <Button size="small" type="link">
                Cancel
              </Button>
            </Popconfirm>
          ) : null,
          <Button
            key="edit"
            size="small"
            type="link"
            disabled={isDeleted}
            onClick={() => onEdit(host)}
          >
            Edit
          </Button>,
          isDeprovisioned ? (
            <Popconfirm
              key="delete"
              title={deleteTitle}
              okText={deleteOkText}
              cancelText="Cancel"
              okButtonProps={{ danger: true }}
              onConfirm={() => onDelete(host.id)}
              disabled={isDeleted || hostOpActive}
            >
              <Button
                size="small"
                type="link"
                danger
                disabled={isDeleted || hostOpActive}
              >
                {deleteLabel}
              </Button>
            </Popconfirm>
          ) : (
            <Button
              key="delete"
              size="small"
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
          ),
        ];

        return (
          <Space size="small">
            {actions.filter(Boolean) as React.ReactNode[]}
          </Space>
        );
      },
    },
  ];

  const sortOptions = [
    { value: "starred", label: "Starred" },
    { value: "name", label: "Name" },
    { value: "provider", label: "Provider" },
    { value: "region", label: "Region" },
    { value: "size", label: "Size" },
    { value: "status", label: "Status" },
    { value: "changed", label: "Changed" },
  ] satisfies { value: HostSortField; label: string }[];

  const toggleDirection = () => {
    setSortDirection(sortDirection === "asc" ? "desc" : "asc");
  };

  const bulkActions =
    viewMode === "list" && selectedRowKeys.length ? (
      <div style={{ marginBottom: 12 }}>
        <Space wrap size="small">
          <Typography.Text>Selected: {selectedRowKeys.length}</Typography.Text>
          <Button
            size="small"
            onClick={() =>
              runBulkAction("Start", startTargets, (host) => onStart(host.id))
            }
            disabled={!startTargets.length}
          >
            Start ({startTargets.length})
          </Button>
          <Button
            size="small"
            onClick={() =>
              runBulkAction("Stop", stopTargets, (host) => onStop(host.id))
            }
            disabled={!stopTargets.length}
          >
            Stop ({stopTargets.length})
          </Button>
          {onUpgrade && (
            <Button
              size="small"
              onClick={() =>
                runBulkAction("Upgrade", upgradeTargets, onUpgrade, {
                  notice: upgradeNotice,
                })
              }
              disabled={!upgradeTargets.length}
            >
              Upgrade ({upgradeTargets.length})
            </Button>
          )}
          {onUpgradeFromHub && (
            <Button
              size="small"
              onClick={() =>
                runBulkAction(
                  "Upgrade (hub source)",
                  upgradeTargets,
                  onUpgradeFromHub,
                  { notice: upgradeNotice },
                )
              }
              disabled={!upgradeTargets.length}
            >
              Upgrade from hub ({upgradeTargets.length})
            </Button>
          )}
          <Button
            size="small"
            danger
            onClick={() =>
              confirmBulkHostDeprovision({
                hosts: deprovisionTargets,
                onConfirm: (host, opts) => onDelete(host.id, opts),
              })
            }
            disabled={!deprovisionTargets.length}
          >
            Deprovision ({deprovisionTargets.length})
          </Button>
          <Button
            size="small"
            danger
            onClick={() =>
              runBulkAction(
                "Delete",
                deleteTargets,
                (host) => onDelete(host.id),
                {
                  danger: true,
                },
              )
            }
            disabled={!deleteTargets.length}
          >
            Delete ({deleteTargets.length})
          </Button>
        </Space>
      </div>
    ) : null;

  const filterNotice = filterActive ? (
    <Alert
      type="warning"
      showIcon
      title={
        visibleHosts.length === 0
          ? "No hosts match this filter."
          : `Showing ${visibleHosts.length} of ${hosts.length} hosts.`
      }
      action={
        <Button size="small" type="link" onClick={() => setSearchText("")}>
          Clear filter
        </Button>
      }
      style={{ marginBottom: 12 }}
    />
  ) : null;

  const runtimeExceptionCounts = React.useMemo(() => {
    let pinned = 0;
    let autoRolledBack = 0;
    for (const host of visibleHosts) {
      if (currentHostRuntimeExceptionSummary(host)) {
        pinned += 1;
      }
      if (
        currentProjectHostAutomaticRollback({
          observation: host.observed_host_agent?.project_host,
          currentVersion: host.version,
        })
      ) {
        autoRolledBack += 1;
      }
    }
    return { pinned, autoRolledBack };
  }, [visibleHosts]);

  const runtimeExceptionNotice =
    runtimeExceptionCounts.pinned > 0 ||
    runtimeExceptionCounts.autoRolledBack > 0 ? (
      <Alert
        type="info"
        showIcon
        message="Some visible hosts are not simply following the fleet default."
        description={
          <Space direction="vertical" size={6} style={{ width: "100%" }}>
            <Typography.Text type="secondary">
              Host overrides pin a host to an explicit desired runtime version,
              so it may not follow later fleet-default changes until you remove
              the override. Automatic rollbacks also show up here so they are
              easy to spot during fleet management.
            </Typography.Text>
            <Space size="small" wrap>
              {runtimeExceptionCounts.pinned > 0 && (
                <Tag color="blue">
                  Host overrides: {runtimeExceptionCounts.pinned}
                </Tag>
              )}
              {runtimeExceptionCounts.autoRolledBack > 0 && (
                <Tag color="orange">
                  Auto-rolled back: {runtimeExceptionCounts.autoRolledBack}
                </Tag>
              )}
            </Space>
          </Space>
        }
        style={{ marginBottom: 12 }}
      />
    ) : null;

  const header = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        marginBottom: 8,
      }}
    >
      <Space size="small" align="center" wrap>
        <Typography.Title level={5} style={{ margin: 0, whiteSpace: "nowrap" }}>
          Project Hosts
        </Typography.Title>
        {onToggleCreatePanel && !createPanelOpen && (
          <Button size="small" type="primary" onClick={onToggleCreatePanel}>
            Create
          </Button>
        )}
      </Space>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <Space size="middle" align="center" wrap>
          <Input.Search
            allowClear
            size="small"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Filter hosts..."
            style={{ width: 220 }}
          />
          <Space size="small" align="center" wrap>
            <Typography.Text style={{ whiteSpace: "nowrap" }}>
              Sort by
            </Typography.Text>
            <Select
              size="small"
              value={sortField}
              options={sortOptions}
              onChange={(value) => setSortField(value as HostSortField)}
              style={{ minWidth: 140 }}
            />
            <Button size="small" onClick={toggleDirection}>
              {sortDirection === "asc" ? "Asc" : "Desc"}
            </Button>
          </Space>
          {isDynamicSort && (
            <Space size="small" align="center" wrap>
              <Switch
                size="small"
                checked={autoResort}
                onChange={setAutoResort}
              />
              {autoResort ? (
                <Typography.Text style={{ whiteSpace: "nowrap" }}>
                  Auto-resort
                </Typography.Text>
              ) : (
                <Button size="small" type="link" onClick={resortNow}>
                  Auto-resort
                </Button>
              )}
            </Space>
          )}
          {isAdmin && (
            <Space size="small" align="center" wrap>
              <Switch
                size="small"
                checked={showParallelLimits}
                onChange={setShowParallelLimits}
              />
              <Typography.Text style={{ whiteSpace: "nowrap" }}>
                Parallel Limits
              </Typography.Text>
            </Space>
          )}
          {isAdmin && (
            <Space size="small" align="center" wrap>
              <Switch
                size="small"
                checked={showRuntimeVersions}
                onChange={setShowRuntimeVersions}
              />
              <Typography.Text style={{ whiteSpace: "nowrap" }}>
                Runtime Versions
              </Typography.Text>
            </Space>
          )}
          {isAdmin && (
            <Space size="small" align="center" wrap>
              <Switch
                size="small"
                checked={showAdmin}
                onChange={setShowAdmin}
              />
              <Typography.Text style={{ whiteSpace: "nowrap" }}>
                All (Admin)
              </Typography.Text>
            </Space>
          )}
          <Space size="small" align="center" wrap>
            <Switch
              size="small"
              checked={showDeleted}
              onChange={setShowDeleted}
            />
            <Typography.Text style={{ whiteSpace: "nowrap" }}>
              Deleted
            </Typography.Text>
          </Space>
        </Space>

        <Space size="small" align="center" wrap>
          <Button size="small" icon={<SyncOutlined />} onClick={onRefresh}>
            Refresh
          </Button>
          <Radio.Group
            value={viewMode}
            onChange={(event) =>
              setViewMode(event.target.value as HostListViewMode)
            }
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="grid">Cards</Radio.Button>
            <Radio.Button value="list">List</Radio.Button>
          </Radio.Group>
        </Space>
      </div>
    </div>
  );

  const showInitialLoading =
    hosts.length === 0 && (!hostsLoaded || hostsLoading);
  const showLoadError =
    hosts.length === 0 && !!hostsError && !showInitialLoading;

  if (showInitialLoading) {
    return (
      <div>
        {header}
        <Card style={{ maxWidth: 720, margin: "0 auto" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              padding: "24px 0",
            }}
          >
            <Spin tip="Loading project hosts..." />
          </div>
        </Card>
      </div>
    );
  }

  if (showLoadError) {
    return (
      <div>
        {header}
        <Alert
          type="error"
          showIcon
          title="Unable to load project hosts"
          description={hostsError}
          action={
            <Button size="small" onClick={onRefresh}>
              Retry
            </Button>
          }
          style={{ marginBottom: 12 }}
        />
      </div>
    );
  }

  if (hosts.length === 0) {
    return (
      <div>
        {header}
        <Card
          style={{ maxWidth: 720, margin: "0 auto" }}
          title={
            <span>
              <Icon name="server" /> Project Hosts
            </span>
          }
        >
          <Typography.Paragraph>
            Dedicated project hosts let you run and share normal CoCalc projects
            on your own VMs (e.g. GPU or large-memory machines). Create one
            below to get started.
          </Typography.Paragraph>
        </Card>
      </div>
    );
  }

  return (
    <div>
      {header}
      {filterNotice}
      {runtimeExceptionNotice}
      {isAdmin && showParallelLimits && parallelOps ? (
        <HostParallelOpsSummary
          status={parallelOps.status}
          loading={parallelOps.loading}
          error={parallelOps.error}
          savingKey={parallelOps.savingKey}
          onRefresh={parallelOps.refresh}
          onSetLimit={parallelOps.setLimit}
          onClearLimit={parallelOps.clearLimit}
        />
      ) : null}
      {isAdmin && showRuntimeVersions && runtimeVersions ? (
        <HostRuntimeVersionsPanel
          hosts={hosts}
          loading={runtimeVersions.loading}
          configured={runtimeVersions.configured}
          configuredError={runtimeVersions.configuredError}
          hub={runtimeVersions.hub}
          hubError={runtimeVersions.hubError}
          globalDeployments={runtimeVersions.globalDeployments}
          globalDeploymentsError={runtimeVersions.globalDeploymentsError}
          hubSourceLabel={runtimeVersions.hubSourceLabel}
          onRefresh={runtimeVersions.refresh}
          onSetClusterDefault={runtimeVersions.onSetClusterDefault}
          settingClusterDefaultKey={runtimeVersions.settingClusterDefaultKey}
        />
      ) : null}
      {bulkActions}
      {viewMode === "list" ? (
        <Table
          rowKey={(host) => host.id}
          columns={columns}
          dataSource={sortedHosts}
          pagination={false}
          rowSelection={{
            selectedRowKeys,
            onChange: (keys) => setSelectedRowKeys(keys as string[]),
            getCheckboxProps: (record) => ({
              disabled: !!record.deleted,
            }),
          }}
          onChange={(_pagination, _filters, sorter) => {
            const nextSorter = Array.isArray(sorter) ? sorter[0] : sorter;
            const nextKey =
              (nextSorter?.columnKey as HostSortField | undefined) ??
              (nextSorter?.field as HostSortField | undefined);
            const nextOrder = nextSorter?.order;
            if (!nextKey || !nextOrder) {
              setSortField("name");
              setSortDirection("asc");
              return;
            }
            setSortField(nextKey);
            setSortDirection(nextOrder === "ascend" ? "asc" : "desc");
          }}
        />
      ) : (
        <Row gutter={[16, 16]}>
          {sortedHosts.map((host) => (
            <Col xs={24} md={12} lg={8} key={host.id}>
              <HostCard
                host={host}
                hostOp={hostOps?.[host.id]}
                onStart={onStart}
                onStop={onStop}
                onRestart={(id, _mode) => {
                  const target = hosts.find((h) => h.id === id);
                  if (!target) return;
                  setRestartTarget(target);
                }}
                onDrain={onDrain}
                onDelete={onDelete}
                onCancelOp={onCancelOp}
                onDetails={onDetails}
                onEdit={onEdit}
                onToggleStar={onToggleStar}
                selfHost={selfHost}
                providerCapabilities={providerCapabilities}
              />
            </Col>
          ))}
        </Row>
      )}
      <Modal
        open={!!restartTarget}
        title={
          restartTarget ? `Restart ${restartTarget.name}?` : "Restart host?"
        }
        onCancel={closeRestart}
        footer={
          <Space>
            <Button onClick={closeRestart}>Cancel</Button>
            <Button
              type="primary"
              disabled={!restartCaps.supportsRestart}
              onClick={() => runRestart("reboot")}
            >
              Reboot
            </Button>
            {restartCaps.supportsHardRestart && (
              <Button danger onClick={() => runRestart("hard")}>
                Hard Reboot
              </Button>
            )}
          </Space>
        }
      >
        <Typography.Paragraph>{restartHelp}</Typography.Paragraph>
        {restartCaps.supportsHardRestart && (
          <>
            <Typography.Paragraph>
              <Typography.Link
                onClick={() => setShowHardRestartHelp((prev) => !prev)}
              >
                {showHardRestartHelp
                  ? "Hide hard reboot guidance"
                  : "When should I use hard reboot?"}
              </Typography.Link>
            </Typography.Paragraph>
            {showHardRestartHelp && (
              <Typography.Paragraph type="secondary">
                Hard reboot power-cycles the VM. Use it only if the host is
                unresponsive or a normal reboot fails. It can risk data loss;
                otherwise use Reboot or contact support.
              </Typography.Paragraph>
            )}
          </>
        )}
        {restartTarget?.status && (
          <Typography.Text type="secondary">
            Current status: {restartTarget.status}
          </Typography.Text>
        )}
      </Modal>
    </div>
  );
};
