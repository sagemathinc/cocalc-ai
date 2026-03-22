import type {
  Host,
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
  rootfsInventory?: {
    entries: HostRootfsImage[];
    loading: boolean;
    error?: string;
    refreshing: boolean;
    actionKey?: string;
    refresh: () => Promise<void>;
    pull: (image: string) => Promise<void>;
    remove: (image: string) => Promise<void>;
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

export const useHostDrawerViewModel = ({
  open,
  host,
  hostOps,
  onClose,
  onEdit,
  onUpgrade,
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
}: UseHostDrawerViewModelArgs) => {
  return {
    open,
    host,
    hostOps,
    onClose,
    onEdit,
    onUpgrade,
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
  };
};
