import type {
  Host,
  HostCatalog,
  HostRuntimeDeploymentRecord,
  HostSoftwareAvailableVersion,
} from "@cocalc/conat/hub/api/hosts";
import type {
  HostListViewMode,
  HostSortDirection,
  HostSortField,
  HostStopOptions,
  HostDeleteOptions,
  HostDrainOptions,
} from "../types";
import type { ParallelOpsWorkerStatus } from "@cocalc/conat/hub/api/system";
import type { HostLroState } from "./use-host-ops";

type UseHostListViewModelArgs = {
  hosts: Host[];
  hostsLoading?: boolean;
  hostsLoaded?: boolean;
  hostsError?: string | null;
  hostOps?: Record<string, HostLroState>;
  onStart: (id: string) => void;
  onStop: (id: string, opts?: HostStopOptions) => void;
  onRestart: (id: string, mode: "reboot" | "hard") => void;
  onDrain: (id: string, opts?: HostDrainOptions) => void;
  onDelete: (id: string, opts?: HostDeleteOptions) => void;
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
  };
};

export const useHostListViewModel = ({
  hosts,
  hostsLoading,
  hostsLoaded,
  hostsError,
  hostOps,
  onStart,
  onStop,
  onRestart,
  onDrain,
  onDelete,
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
}: UseHostListViewModelArgs) => {
  return {
    hosts,
    hostsLoading,
    hostsLoaded,
    hostsError,
    hostOps,
    onStart,
    onStop,
    onRestart,
    onDrain,
    onDelete,
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
  };
};
