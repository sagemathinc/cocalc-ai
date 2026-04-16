import type {
  Host,
  HostRuntimeArtifact,
  HostRuntimeDeploymentStatus,
  HostRootfsGcResult,
  HostRootfsImage,
  HostSoftwareArtifact,
  HostSoftwareAvailableVersion,
} from "@cocalc/conat/hub/api/hosts";
import type { ParallelOpsWorkerStatus } from "@cocalc/conat/hub/api/system";
import type { HostLogEntry } from "./use-host-log";
import type { HostLroState } from "./use-host-ops";

type HostSoftwareMap = Partial<
  Record<HostSoftwareArtifact, HostSoftwareAvailableVersion>
>;

type UseHostDrawerViewModelArgs = {
  open: boolean;
  host: Host | undefined;
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
    configured: HostSoftwareMap;
    configuredError?: string;
    hub: HostSoftwareMap;
    hubError?: string;
    refresh: () => Promise<void>;
    hubSourceBaseUrl?: string;
  };
  runtimeDeployments?: {
    status?: HostRuntimeDeploymentStatus;
    loading: boolean;
    refreshing: boolean;
    error?: string;
    refresh: () => Promise<void>;
  };
  onSetRuntimeArtifactDeployment?: (opts: {
    host: Host;
    artifact: HostRuntimeArtifact;
    desired_version: string;
    source: "configured" | "hub";
  }) => void | Promise<void>;
  onRollbackRuntimeArtifact?: (opts: {
    host: Host;
    artifact: HostRuntimeArtifact;
    version?: string;
    last_known_good?: boolean;
  }) => void | Promise<void>;
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
  onStopRunningProjects?: (host: Host) => void | Promise<void>;
  onRestartRunningProjects?: (host: Host) => void | Promise<void>;
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

export const useHostDrawerViewModel = ({
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
  runtimeDeployments,
  onSetRuntimeArtifactDeployment,
  onRollbackRuntimeArtifact,
  rootfsInventory,
  canManageRootfs,
  onStopRunningProjects,
  onRestartRunningProjects,
  selfHost,
  parallelOps,
}: UseHostDrawerViewModelArgs) => {
  return {
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
    runtimeDeployments,
    onSetRuntimeArtifactDeployment,
    onRollbackRuntimeArtifact,
    rootfsInventory,
    canManageRootfs,
    onStopRunningProjects,
    onRestartRunningProjects,
    selfHost,
    parallelOps,
  };
};
