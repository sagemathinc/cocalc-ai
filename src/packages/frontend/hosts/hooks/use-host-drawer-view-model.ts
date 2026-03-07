import type {
  Host,
  HostSoftwareArtifact,
  HostSoftwareAvailableVersion,
} from "@cocalc/conat/hub/api/hosts";
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
  selfHost?: {
    connectorMap: Map<string, { id: string; name?: string; last_seen?: string }>;
    isConnectorOnline: (connectorId?: string) => boolean;
    onSetup: (host: Host) => void;
    onRemove: (host: Host) => void;
    onForceDeprovision: (host: Host) => void;
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
  selfHost,
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
    selfHost,
  };
};
