import {
  Alert,
  Button,
  Card,
  Divider,
  Drawer,
  Popover,
  Popconfirm,
  Select,
  Space,
  Tag,
  Tabs,
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
  HostRuntimeArtifact,
  HostRuntimeArtifactObservation,
  HostRuntimeDeploymentObservedTarget,
  HostRuntimeDeploymentObservedVersionState,
  HostRuntimeDeploymentStatus,
  HostRuntimeRollbackTarget,
  HostRootfsGcResult,
  HostRootfsImage,
  HostSoftwareArtifact,
  HostSoftwareAvailableVersion,
} from "@cocalc/conat/hub/api/hosts";
import type {
  ManagedComponentKind,
  ManagedComponentRuntimeState,
  ManagedComponentUpgradePolicy,
} from "@cocalc/conat/project-host/api";
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
import {
  UpgradeAllConfirmContent,
  UpgradeConfirmContent,
} from "./upgrade-confirmation";
import { HostBootstrapProgress } from "./host-bootstrap-progress";
import { HostBootstrapLifecycle } from "./host-bootstrap-lifecycle";
import { HostParallelOpsPanel } from "./host-parallel-ops-panel";
import { HostDaemonHealthSummary } from "./host-daemon-health-summary";
import { HostProjectStatus } from "./host-project-status";
import { HostProjectsBrowser } from "./host-projects-browser";
import { HostRootfsCachePanel } from "./host-rootfs-cache-panel";
import { HostCurrentMetrics } from "./host-current-metrics";
import { confirmHostDeprovision } from "./host-confirm";
import {
  formatBinaryBytes,
  getHostCpuCount,
  getHostRamGiB,
  getHostSizeDisplay,
} from "../utils/format";
import type { HostDeleteOptions } from "../types";
import {
  projectHostRollbackReasonLabel,
  shouldSuppressProjectHostFailedOp,
} from "../utils/project-host-rollout";

type HostDrawerViewModel = {
  open: boolean;
  host?: Host;
  hostOps?: Record<string, HostLroState>;
  onClose: () => void;
  onEdit: (host: Host) => void;
  onDelete?: (id: string, opts?: HostDeleteOptions) => void | Promise<void>;
  onUpgrade?: (host: Host) => void;
  onUpgradeAll?: (host: Host) => void;
  onReconcile?: (host: Host) => void;
  onRefreshCloudStatus?: (host: Host) => void;
  onUpgradeFromHub?: (host: Host) => void;
  onUpgradeAllFromHub?: (host: Host) => void;
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
    configuredCatalog?: HostSoftwareAvailableVersion[];
    hubCatalog?: HostSoftwareAvailableVersion[];
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
  onResumeRuntimeArtifactClusterDefault?: (opts: {
    host: Host;
    artifact: HostRuntimeArtifact;
  }) => void | Promise<void>;
  onSetRuntimeComponentDeployment?: (opts: {
    host: Host;
    component: ManagedComponentKind;
    desired_version: string;
    source: "configured" | "hub";
  }) => void | Promise<void>;
  onRollbackRuntimeComponent?: (opts: {
    host: Host;
    component: ManagedComponentKind;
    version?: string;
    last_known_good?: boolean;
  }) => void | Promise<void>;
  onRestartRuntimeComponent?: (opts: {
    host: Host;
    component: ManagedComponentKind;
  }) => void | Promise<void>;
  onResumeRuntimeComponentClusterDefault?: (opts: {
    host: Host;
    component: ManagedComponentKind;
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
  artifact: HostRuntimeArtifact;
  sourceArtifact?: HostSoftwareArtifact;
  label: string;
  desiredLabel: string;
}> = [
  {
    artifact: "project-host",
    sourceArtifact: "project-host",
    label: "Project host",
    desiredLabel: "Host runtime",
  },
  {
    artifact: "project-bundle",
    sourceArtifact: "project",
    label: "Project bundle",
    desiredLabel: "New projects",
  },
  {
    artifact: "tools",
    sourceArtifact: "tools",
    label: "Tools",
    desiredLabel: "Tool archive",
  },
];
const DAEMON_COMPONENTS: Array<{
  component: ManagedComponentKind;
  label: string;
}> = [
  { component: "project-host", label: "Project host daemon" },
  { component: "conat-router", label: "Conat router" },
  { component: "conat-persist", label: "Conat persist" },
  { component: "acp-worker", label: "ACP worker" },
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
  artifact: HostRuntimeArtifact,
): string | undefined {
  if (artifact === "project-host") return host.version;
  if (artifact === "project-bundle") return host.project_bundle_version;
  return host.tools_version;
}

function runningBuildId(
  host: Host,
  artifact: HostRuntimeArtifact,
): string | undefined {
  if (artifact === "project-host") return host.project_host_build_id;
  if (artifact === "project-bundle") return host.project_bundle_build_id;
  return undefined;
}

function observedVersionStateTag(
  state?: HostRuntimeDeploymentObservedVersionState,
) {
  if (!state) return <Tag>unknown</Tag>;
  if (state === "aligned") return <Tag color="green">aligned</Tag>;
  if (state === "drifted") return <Tag color="orange">drifted</Tag>;
  if (state === "mixed") return <Tag color="orange">mixed</Tag>;
  if (state === "missing") return <Tag color="red">not installed</Tag>;
  if (state === "unsupported") return <Tag>unsupported</Tag>;
  if (state === "unobserved") return <Tag>unobserved</Tag>;
  return <Tag>unknown</Tag>;
}

function availableVersionTag({
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

function upgradeAllTitle({ label, source }: { label: string; source: string }) {
  return (
    <div>
      <div>
        Upgrade {label.toLowerCase()} from {source} and align the runtime stack?
      </div>
      <UpgradeAllConfirmContent />
    </div>
  );
}

function cliCommandsForArtifact({
  host,
  artifact,
}: {
  host: Host;
  artifact: HostRuntimeArtifact;
}): string[] {
  return [
    `cocalc host deploy`,
    `cocalc host deploy status ${host.id}`,
    `cocalc host deploy set --host ${host.id} --artifact ${artifact} --desired-version <version>`,
    `cocalc host deploy rollback ${host.id} --artifact ${artifact} --last-known-good`,
    `cocalc host deploy rollback ${host.id} --artifact ${artifact} --to-version <version>`,
  ];
}

function RuntimeCliButton({
  title,
  commands,
}: {
  title: string;
  commands: string[];
}) {
  return (
    <Popover
      trigger="click"
      title={title}
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
      <Button size="small" type="text" icon={<CodeOutlined />}>
        CLI
      </Button>
    </Popover>
  );
}

function sourceVersionForArtifact({
  artifact,
  softwareVersions,
  source,
}: {
  artifact: HostRuntimeArtifact;
  softwareVersions: HostDrawerViewModel["softwareVersions"] | undefined;
  source: "configured" | "hub";
}): HostSoftwareAvailableVersion | undefined {
  const sourceArtifact = SOFTWARE_ARTIFACTS.find(
    (entry) => entry.artifact === artifact,
  )?.sourceArtifact;
  if (!sourceArtifact || !softwareVersions) {
    return undefined;
  }
  return source === "configured"
    ? softwareVersions.configured?.[sourceArtifact]
    : softwareVersions.hub?.[sourceArtifact];
}

function runtimeArtifactForSoftwareArtifact(
  artifact: HostSoftwareArtifact,
): HostRuntimeArtifact {
  if (artifact === "project" || artifact === "project-bundle") {
    return "project-bundle";
  }
  if (artifact === "project-host") {
    return "project-host";
  }
  return "tools";
}

function sourceVersionForComponent({
  softwareVersions,
  source,
}: {
  softwareVersions: HostDrawerViewModel["softwareVersions"] | undefined;
  source: "configured" | "hub";
}): HostSoftwareAvailableVersion | undefined {
  if (!softwareVersions) {
    return undefined;
  }
  return source === "configured"
    ? softwareVersions.configured?.["project-host"]
    : softwareVersions.hub?.["project-host"];
}

function deploymentRecordForArtifact(
  status: HostRuntimeDeploymentStatus | undefined,
  artifact: HostRuntimeArtifact,
) {
  return status?.effective.find(
    (record) => record.target_type === "artifact" && record.target === artifact,
  );
}

function observedTargetForArtifact(
  status: HostRuntimeDeploymentStatus | undefined,
  artifact: HostRuntimeArtifact,
): HostRuntimeDeploymentObservedTarget | undefined {
  return status?.observed_targets?.find(
    (record) => record.target_type === "artifact" && record.target === artifact,
  );
}

function observedArtifactForArtifact(
  status: HostRuntimeDeploymentStatus | undefined,
  artifact: HostRuntimeArtifact,
): HostRuntimeArtifactObservation | undefined {
  return status?.observed_artifacts?.find(
    (record) => record.artifact === artifact,
  );
}

function observedTargetForComponent(
  status: HostRuntimeDeploymentStatus | undefined,
  component: ManagedComponentKind,
): HostRuntimeDeploymentObservedTarget | undefined {
  return status?.observed_targets?.find(
    (record) =>
      record.target_type === "component" && record.target === component,
  );
}

function observedComponentForComponent(
  status: HostRuntimeDeploymentStatus | undefined,
  component: ManagedComponentKind,
) {
  return status?.observed_components?.find(
    (record) => record.component === component,
  );
}

function rollbackTargetForArtifact(
  status: HostRuntimeDeploymentStatus | undefined,
  artifact: HostRuntimeArtifact,
): HostRuntimeRollbackTarget | undefined {
  return status?.rollback_targets?.find(
    (record) => record.target_type === "artifact" && record.target === artifact,
  );
}

function rollbackTargetForComponent(
  status: HostRuntimeDeploymentStatus | undefined,
  component: ManagedComponentKind,
): HostRuntimeRollbackTarget | undefined {
  return status?.rollback_targets?.find(
    (record) =>
      record.target_type === "component" && record.target === component,
  );
}

function rollbackVersionOptions(
  rollbackTarget: HostRuntimeRollbackTarget | undefined,
): string[] {
  return Array.from(
    new Set(
      [
        rollbackTarget?.last_known_good_version,
        rollbackTarget?.previous_version,
        ...(rollbackTarget?.retained_versions ?? []),
      ]
        .map((value) => `${value ?? ""}`.trim())
        .filter(Boolean),
    ),
  );
}

function primaryRollbackSelection(
  rollbackTarget: HostRuntimeRollbackTarget | undefined,
): {
  version?: string;
  source?: "last_known_good" | "previous_version";
  label: string;
} {
  if (rollbackTarget?.last_known_good_version) {
    return {
      version: rollbackTarget.last_known_good_version,
      source: "last_known_good",
      label: "last known good",
    };
  }
  if (rollbackTarget?.previous_version) {
    return {
      version: rollbackTarget.previous_version,
      source: "previous_version",
      label: "previous",
    };
  }
  return { label: "retained version" };
}

type RuntimeVersionMetadata = {
  built_at?: string;
  message?: string;
  source?: "configured" | "hub";
};

type RuntimeVersionMetadataIndex = Map<string, RuntimeVersionMetadata>;

function runtimeVersionKey(artifact: HostRuntimeArtifact, version: string) {
  return `${artifact}:${version}`;
}

function buildRuntimeVersionMetadataIndex({
  configuredCatalog,
  hubCatalog,
}: {
  configuredCatalog?: HostSoftwareAvailableVersion[];
  hubCatalog?: HostSoftwareAvailableVersion[];
}): RuntimeVersionMetadataIndex {
  const out: RuntimeVersionMetadataIndex = new Map();
  const ingest = (
    source: "configured" | "hub",
    rows?: HostSoftwareAvailableVersion[],
  ) => {
    for (const row of rows ?? []) {
      const version = `${row.version ?? ""}`.trim();
      if (!version) continue;
      const key = runtimeVersionKey(
        runtimeArtifactForSoftwareArtifact(row.artifact),
        version,
      );
      const prev = out.get(key);
      if (
        prev &&
        (!!prev.built_at || !row.built_at) &&
        (!!prev.message || !row.message)
      ) {
        continue;
      }
      out.set(key, {
        built_at: row.built_at,
        message: row.message,
        source,
      });
    }
  };
  ingest("configured", configuredCatalog);
  ingest("hub", hubCatalog);
  return out;
}

function inferredVersionTimestamp(version?: string): number | undefined {
  const value = `${version ?? ""}`.trim();
  if (!value) return undefined;
  if (/^\d{13}$/.test(value)) {
    const ts = Number(value);
    return Number.isFinite(ts) ? ts : undefined;
  }
  if (/^\d{10}$/.test(value)) {
    const ts = Number(value) * 1000;
    return Number.isFinite(ts) ? ts : undefined;
  }
  const buildId = value.match(/^(\d{8}T\d{6}Z)(?:-|$)/)?.[1];
  if (buildId) {
    const ts = Date.parse(buildId);
    return Number.isFinite(ts) ? ts : undefined;
  }
  return undefined;
}

function lookupRuntimeVersionMetadata({
  artifact,
  version,
  metadataIndex,
}: {
  artifact: HostRuntimeArtifact;
  version: string;
  metadataIndex: RuntimeVersionMetadataIndex;
}): RuntimeVersionMetadata | undefined {
  return metadataIndex.get(runtimeVersionKey(artifact, version));
}

function formatVersionBuiltAt({
  version,
  metadata,
}: {
  version: string;
  metadata?: RuntimeVersionMetadata;
}): string | undefined {
  const builtAt = metadata?.built_at;
  if (builtAt) {
    const ts = Date.parse(builtAt);
    if (Number.isFinite(ts)) {
      return new Date(ts).toLocaleString();
    }
  }
  const inferred = inferredVersionTimestamp(version);
  return inferred ? new Date(inferred).toLocaleString() : undefined;
}

function runtimeVersionBadges({
  rollbackTarget,
  version,
  section,
}: {
  rollbackTarget?: HostRuntimeRollbackTarget;
  version: string;
  section?: "protected" | "prune" | "option";
}): React.ReactNode[] {
  const badges: React.ReactNode[] = [];
  if (version === rollbackTarget?.current_version) {
    badges.push(<Tag key={`${version}:current`}>current</Tag>);
  }
  if (version === rollbackTarget?.desired_version) {
    badges.push(<Tag key={`${version}:desired`}>desired</Tag>);
  }
  if (version === rollbackTarget?.last_known_good_version) {
    badges.push(
      <Tag color="green" key={`${version}:lkg`}>
        last known good
      </Tag>,
    );
  }
  if (version === rollbackTarget?.previous_version) {
    badges.push(
      <Tag color="blue" key={`${version}:previous`}>
        previous
      </Tag>,
    );
  }
  const reference = rollbackTarget?.referenced_versions?.find(
    (entry) => entry.version === version,
  );
  if (reference) {
    badges.push(
      <Tag color="cyan" key={`${version}:referenced`}>
        running projects x{reference.project_count}
      </Tag>,
    );
  }
  if (
    section !== "protected" &&
    rollbackTarget?.protected_versions?.includes(version)
  ) {
    badges.push(<Tag key={`${version}:protected`}>protected</Tag>);
  }
  if (
    section !== "prune" &&
    rollbackTarget?.prune_candidate_versions?.includes(version)
  ) {
    badges.push(
      <Tag color="orange" key={`${version}:prune`}>
        prune candidate
      </Tag>,
    );
  }
  return badges;
}

function RuntimeVersionDisplay({
  artifact,
  version,
  rollbackTarget,
  metadataIndex,
  section,
}: {
  artifact: HostRuntimeArtifact;
  version: string;
  rollbackTarget?: HostRuntimeRollbackTarget;
  metadataIndex: RuntimeVersionMetadataIndex;
  section?: "protected" | "prune" | "option";
}) {
  const metadata = lookupRuntimeVersionMetadata({
    artifact,
    version,
    metadataIndex,
  });
  const builtAt = formatVersionBuiltAt({ version, metadata });
  const message = `${metadata?.message ?? ""}`.trim();
  const source =
    metadata?.source === "configured"
      ? "configured catalog"
      : metadata?.source === "hub"
        ? "hub /software"
        : undefined;
  const badges = runtimeVersionBadges({ rollbackTarget, version, section });
  const detailLine = [builtAt, source, message].filter(Boolean).join(" · ");
  return (
    <Space direction="vertical" size={2} style={{ width: "100%", minWidth: 0 }}>
      <Space wrap size={[6, 4]}>
        <Typography.Text code>{version}</Typography.Text>
        {badges}
      </Space>
      {detailLine ? (
        <Typography.Text
          type="secondary"
          style={{
            fontSize: 12,
            lineHeight: 1.3,
            whiteSpace: "normal",
          }}
        >
          {detailLine}
        </Typography.Text>
      ) : null}
    </Space>
  );
}

function RuntimeVersionList({
  title,
  emptyText,
  artifact,
  versions,
  rollbackTarget,
  metadataIndex,
  section,
}: {
  title: string;
  emptyText?: string;
  artifact: HostRuntimeArtifact;
  versions?: string[];
  rollbackTarget?: HostRuntimeRollbackTarget;
  metadataIndex: RuntimeVersionMetadataIndex;
  section?: "protected" | "prune";
}) {
  return (
    <Space direction="vertical" size={4} style={{ width: "100%" }}>
      <Typography.Text>{title}</Typography.Text>
      {versions?.length ? (
        <Card size="small" styles={{ body: { padding: 10 } }}>
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {versions.map((version) => (
              <RuntimeVersionDisplay
                key={`${title}:${artifact}:${version}`}
                artifact={artifact}
                version={version}
                rollbackTarget={rollbackTarget}
                metadataIndex={metadataIndex}
                section={section}
              />
            ))}
          </Space>
        </Card>
      ) : (
        <Typography.Text type="secondary">
          {emptyText ?? "none"}
        </Typography.Text>
      )}
    </Space>
  );
}

function RuntimeRetentionExplanation({
  rollbackTarget,
}: {
  rollbackTarget?: HostRuntimeRollbackTarget;
}) {
  if (!rollbackTarget) return null;
  const hasReferencedVersions = !!rollbackTarget.referenced_versions?.length;
  return (
    <Alert
      type="info"
      showIcon
      message="Local retention policy"
      description={
        <span>
          Protected versions stay installed because they are current, desired,
          rollback checkpoints, or still referenced
          {hasReferencedVersions ? " by running projects" : ""}. Prune
          candidates are retained local cache and are the first versions removed
          when the keep floor or byte budget needs space.
        </span>
      }
    />
  );
}

function formatBytes(value?: number): string | undefined {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return undefined;
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  let scaled = value;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled >= 10 || unit === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unit]}`;
}

function componentDeploymentRecord(
  status: HostRuntimeDeploymentStatus | undefined,
  component: string,
) {
  return status?.effective.find(
    (record) =>
      record.target_type === "component" && record.target === component,
  );
}

function cliCommandsForComponent({
  host,
  component,
}: {
  host: Host;
  component: ManagedComponentKind;
}): string[] {
  return [
    `cocalc host deploy`,
    `cocalc host deploy status ${host.id}`,
    `cocalc host deploy restart ${host.id} --component ${component} --wait`,
    `cocalc host deploy set --host ${host.id} --component ${component} --desired-version <version>`,
    `cocalc host deploy rollback ${host.id} --component ${component} --last-known-good`,
    `cocalc host deploy rollback ${host.id} --component ${component} --to-version <version>`,
  ];
}

function formatRuntimeTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return undefined;
  return new Date(ts).toLocaleString();
}

function formatRolloutReason(reason?: string): string {
  switch (`${reason ?? ""}`.trim()) {
    case "automatic_project_host_local_rollback":
      return "automatic local rollback after a failed project-host rollout";
    default:
      return reason?.trim() || "manual override";
  }
}

function runtimeStateTag(state?: ManagedComponentRuntimeState) {
  switch (state) {
    case "running":
      return <Tag color="green">running</Tag>;
    case "stopped":
      return <Tag color="red">stopped</Tag>;
    case "disabled":
      return <Tag>disabled</Tag>;
    case "unknown":
      return <Tag>unknown</Tag>;
    default:
      return <Tag>unobserved</Tag>;
  }
}

function formatUpgradePolicy(policy?: ManagedComponentUpgradePolicy): string {
  switch (policy) {
    case "restart_now":
      return "restart now";
    case "drain_then_replace":
      return "drain then replace";
    default:
      return "unknown";
  }
}

function componentModeDetails({
  managed,
  runningVersions,
  runningPids,
}: {
  managed?: boolean;
  runningVersions: string[];
  runningPids: number[];
}): { tag?: React.ReactNode; summary?: string; externallyManaged: boolean } {
  if (managed !== false) {
    return { externallyManaged: false };
  }
  if (runningVersions.length > 0 || runningPids.length > 0) {
    return {
      tag: <Tag>shared</Tag>,
      summary: "shared with project-host",
      externallyManaged: false,
    };
  }
  return {
    tag: <Tag>external</Tag>,
    summary: "external endpoint",
    externallyManaged: true,
  };
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
  const [activeTab, setActiveTab] = React.useState("overview");
  const [showProjects, setShowProjects] = React.useState(false);
  const [expandedArtifacts, setExpandedArtifacts] = React.useState<
    Partial<Record<HostRuntimeArtifact, boolean>>
  >({});
  const [expandedComponents, setExpandedComponents] = React.useState<
    Partial<Record<ManagedComponentKind, boolean>>
  >({});
  const [artifactRollbackSelection, setArtifactRollbackSelection] =
    React.useState<Partial<Record<HostRuntimeArtifact, string>>>({});
  const [componentRollbackSelection, setComponentRollbackSelection] =
    React.useState<Partial<Record<ManagedComponentKind, string>>>({});
  React.useEffect(() => {
    setArtifactRollbackSelection({});
    setComponentRollbackSelection({});
  }, [vm.host?.id]);
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
    onDelete,
    onUpgradeAll,
    onReconcile,
    onRefreshCloudStatus,
    onUpgradeAllFromHub,
    canUpgrade,
    onCancelOp,
    hostLog,
    loadingLog,
    softwareVersions,
    runtimeDeployments,
    onSetRuntimeArtifactDeployment,
    onRollbackRuntimeArtifact,
    onResumeRuntimeArtifactClusterDefault,
    onSetRuntimeComponentDeployment,
    onRollbackRuntimeComponent,
    onRestartRuntimeComponent,
    onResumeRuntimeComponentClusterDefault,
    rootfsInventory,
    canManageRootfs,
    onStopRunningProjects,
    onRestartRunningProjects,
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
  const deploymentStatus = runtimeDeployments?.status;
  const projectHostObservation =
    deploymentStatus?.observed_host_agent?.project_host ??
    host?.observed_host_agent?.project_host;
  const projectHostComponentDeployment = componentDeploymentRecord(
    deploymentStatus,
    "project-host",
  );
  const activeOp = host ? hostOps?.[host.id] : undefined;
  const displayActiveOp = shouldSuppressProjectHostFailedOp({
    op: activeOp,
    currentVersion: host?.version,
    observation: projectHostObservation,
  })
    ? undefined
    : activeOp;
  const hostOpActive = host ? isHostOpActive(displayActiveOp) : false;
  const opPhase = getHostOpPhase(displayActiveOp);
  const canCancelBackups =
    !!displayActiveOp?.op_id &&
    hostOpActive &&
    opPhase === "backups" &&
    !!onCancelOp;
  const showUpgradeProgress =
    displayActiveOp?.summary?.kind === "host-upgrade-software" ||
    displayActiveOp?.kind === "host-upgrade-software" ||
    displayActiveOp?.summary?.kind === "host-reconcile-software" ||
    displayActiveOp?.kind === "host-reconcile-software" ||
    displayActiveOp?.summary?.kind === "host-reconcile-runtime-deployments" ||
    displayActiveOp?.kind === "host-reconcile-runtime-deployments" ||
    displayActiveOp?.summary?.kind === "host-rollback-runtime-deployments" ||
    displayActiveOp?.kind === "host-rollback-runtime-deployments";
  const upgradeAllConfirmContent = upgradeAllTitle({
    label: "all software",
    source: "the configured source",
  });
  const upgradeAllFromHubConfirmContent = upgradeAllTitle({
    label: "all software",
    source: "this hub source",
  });
  const softwareHelp = (
    <div style={{ maxWidth: 480 }}>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <Typography.Text>
          This section compares the versions currently reported by the host with
          the newest versions available from the configured software source and
          from this site&apos;s <code>/software</code> endpoint.
        </Typography.Text>
        <Typography.Text type="secondary">
          Installed runtime artifacts live on the host under{" "}
          <code>/opt/cocalc/project-host</code>,{" "}
          <code>/opt/cocalc/project-bundles</code>, and{" "}
          <code>/opt/cocalc/tools</code>.
        </Typography.Text>
        <Typography.Text type="secondary">
          Local development hubs can publish fresh runtime artifacts with{" "}
          <code>pnpm hub:daemon:build</code>. Production sites normally publish
          to the configured software base URL instead.
        </Typography.Text>
      </Space>
      <UpgradeConfirmContent />
    </div>
  );
  const versionMetadataIndex = React.useMemo(
    () =>
      buildRuntimeVersionMetadataIndex({
        configuredCatalog: softwareVersions?.configuredCatalog,
        hubCatalog: softwareVersions?.hubCatalog,
      }),
    [softwareVersions?.configuredCatalog, softwareVersions?.hubCatalog],
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
  const canRefreshCloudStatus =
    !!host &&
    !host.deleted &&
    !!onRefreshCloudStatus &&
    !!host.machine?.cloud &&
    host.machine.cloud !== "self-host" &&
    host.machine.cloud !== "local";
  const softwareSummary = React.useMemo(() => {
    if (!host) {
      return { upToDate: 0, updatesAvailable: 0, unknown: 0 };
    }
    let upToDate = 0;
    let updatesAvailable = 0;
    let unknown = 0;
    for (const { artifact } of SOFTWARE_ARTIFACTS) {
      const observed = observedTargetForArtifact(deploymentStatus, artifact);
      const latest = sourceVersionForArtifact({
        artifact,
        softwareVersions,
        source: "configured",
      });
      if (!observed || !latest?.version || latest.error) {
        unknown += 1;
      } else if (observed.observed_version_state === "aligned") {
        upToDate += 1;
      } else {
        updatesAvailable += 1;
      }
    }
    return { upToDate, updatesAvailable, unknown };
  }, [deploymentStatus, host, softwareVersions]);
  const latestLogEntry = hostLog[0];
  const latestLogChange = latestLogEntry
    ? describeSpecChange(latestLogEntry.spec)
    : undefined;
  React.useEffect(() => {
    setActiveTab("overview");
    setShowProjects(false);
    setExpandedArtifacts({});
    setExpandedComponents({});
  }, [host?.id]);
  if (!host) {
    return (
      <Drawer
        size={drawerWidth}
        title={
          <Space>
            <Icon name="server" /> Host details
          </Space>
        }
        onClose={onClose}
        resizable={{ onResize: handleResize }}
        open={false}
      >
        <Typography.Text type="secondary">
          Select a host to see details.
        </Typography.Text>
      </Drawer>
    );
  }
  const deleteLabel = host.deleted
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
  const overviewContent = host ? (
    <Space orientation="vertical" style={{ width: "100%" }} size="middle">
      {!showUpgradeProgress && (
        <Space orientation="vertical" size="small">
          <HostOpProgress op={displayActiveOp} />
          <HostBootstrapProgress host={host} />
          {canCancelBackups && (
            <Popconfirm
              title="Cancel backups for this host?"
              okText="Cancel backups"
              cancelText="Keep running"
              onConfirm={() => onCancelOp?.(displayActiveOp!.op_id)}
            >
              <Button size="small" type="link">
                Cancel backups
              </Button>
            </Popconfirm>
          )}
        </Space>
      )}
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
          <Typography.Text strong>Connector</Typography.Text>
          <Space wrap>
            <Button
              size="small"
              disabled={hostOpActive}
              onClick={handleSetupClick}
            >
              Setup or reconnect
            </Button>
          </Space>
        </Space>
      )}
      <Card size="small" title="Summary">
        <Space orientation="vertical" size="small" style={{ width: "100%" }}>
          <Typography.Text copyable={{ text: host.id }}>
            Host ID: {host.id}
          </Typography.Text>
          {isSelfHost && host.region && (
            <Typography.Text copyable={{ text: host.region }}>
              Connector ID: {host.region}
            </Typography.Text>
          )}
          {host.machine?.cloud && host.public_ip && (
            <Typography.Text copyable={{ text: host.public_ip }}>
              Public IP: {host.public_ip}
            </Typography.Text>
          )}
          <Typography.Text type="secondary">
            {[
              host.machine?.zone ? `Zone ${host.machine.zone}` : null,
              host.machine?.machine_type
                ? `Machine ${host.machine.machine_type}`
                : null,
              host.machine?.gpu_type ? `GPU ${host.machine.gpu_type}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "No machine details reported yet."}
          </Typography.Text>
          {showHostResources && (
            <Typography.Text type="secondary">
              Resources {hostCpu ?? "?"} vCPU · {hostRam ?? "?"} GiB RAM ·{" "}
              {hostDisk ?? "?"} disk
            </Typography.Text>
          )}
          {isSelfHost && host.machine?.metadata?.self_host_ssh_target && (
            <Typography.Text type="secondary">
              SSH target: {host.machine.metadata.self_host_ssh_target}
            </Typography.Text>
          )}
          <Typography.Text type="secondary">
            Last seen:{" "}
            {host.last_seen ? new Date(host.last_seen).toLocaleString() : "n/a"}
          </Typography.Text>
        </Space>
      </Card>
      <Card size="small" title="Daemon health">
        <HostDaemonHealthSummary host={host} />
      </Card>
      <Card size="small" title="Current metrics">
        <HostCurrentMetrics host={host} compact dense />
      </Card>
      <Card
        size="small"
        title="Projects"
        extra={
          <Button
            size="small"
            type="link"
            onClick={() => setActiveTab("projects")}
          >
            Open projects
          </Button>
        }
      >
        <Space orientation="vertical" size="small" style={{ width: "100%" }}>
          <HostProjectStatus host={host} fontSize={13} />
          <Typography.Text type="secondary">
            Backups{" "}
            {host.backup_status
              ? `${host.backup_status.provisioned_up_to_date}/${host.backup_status.provisioned} provisioned up to date · ${host.backup_status.provisioned_needs_backup} need backup`
              : "n/a"}
          </Typography.Text>
        </Space>
      </Card>
      <Card
        size="small"
        title="Recent activity"
        extra={
          <Button size="small" type="link" onClick={() => setActiveTab("logs")}>
            Open logs
          </Button>
        }
      >
        <Space orientation="vertical" size="small" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            Last action:{" "}
            {host.last_action
              ? `${host.last_action}${
                  host.last_action_at
                    ? ` · ${new Date(host.last_action_at).toLocaleString()}`
                    : ""
                }`
              : "n/a"}
          </Typography.Text>
          {latestLogEntry && (
            <Typography.Text type="secondary">
              Latest log: {latestLogEntry.action} — {latestLogEntry.status}
              {latestLogEntry.ts
                ? ` · ${new Date(latestLogEntry.ts).toLocaleString()}`
                : ""}
            </Typography.Text>
          )}
          {latestLogChange?.summary && (
            <Typography.Text type="secondary">
              Config update: {latestLogChange.summary}
            </Typography.Text>
          )}
          {host.status === "error" && host.last_error && (
            <Alert
              type="error"
              showIcon
              message="Provisioning error"
              description={host.last_error}
            />
          )}
        </Space>
      </Card>
    </Space>
  ) : null;
  const projectsContent = host ? (
    <Space orientation="vertical" style={{ width: "100%" }} size="middle">
      <HostProjectStatus host={host} fontSize={14} />
      <Space wrap>
        <Button size="small" onClick={() => setShowProjects(true)}>
          Browse projects
        </Button>
      </Space>
    </Space>
  ) : null;
  const storageContent = host ? (
    <HostRootfsCachePanel
      host={host}
      canManage={!!canManageRootfs}
      inventory={rootfsInventory}
    />
  ) : null;
  const logsContent = host ? (
    <Space orientation="vertical" style={{ width: "100%" }} size="middle">
      <Card
        size="small"
        title="Bootstrap lifecycle"
        styles={{ body: { padding: 12 } }}
      >
        <HostBootstrapLifecycle host={host} detailed />
      </Card>
      <Card
        size="small"
        title="Recent actions"
        styles={{ body: { padding: 12 } }}
      >
        {loadingLog ? (
          <Typography.Text type="secondary">Loading…</Typography.Text>
        ) : hostLog.length === 0 ? (
          <Typography.Text type="secondary">No actions yet.</Typography.Text>
        ) : (
          <Space orientation="vertical" style={{ width: "100%" }} size="small">
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
      </Card>
    </Space>
  ) : null;
  const dangerContent = host ? (
    <Space orientation="vertical" style={{ width: "100%" }} size="middle">
      {!host.deleted ? (
        <Card
          size="small"
          title="Host lifecycle"
          styles={{ body: { padding: 12 } }}
        >
          <Space orientation="vertical" size="small" style={{ width: "100%" }}>
            <Typography.Text type="secondary">
              Deprovisioning removes the host from service. Permanently deleting
              is only available after the host is already deprovisioned.
            </Typography.Text>
            {isDeprovisioned ? (
              <Popconfirm
                title={deleteTitle}
                okText={deleteOkText}
                cancelText="Cancel"
                onConfirm={() => onDelete?.(host.id)}
                okButtonProps={{ danger: true }}
              >
                <Button
                  size="small"
                  danger
                  disabled={hostOpActive || !onDelete}
                >
                  {deleteLabel}
                </Button>
              </Popconfirm>
            ) : (
              <Button
                size="small"
                danger
                disabled={hostOpActive || !onDelete}
                onClick={() =>
                  onDelete &&
                  confirmHostDeprovision({
                    host,
                    onConfirm: (opts) => onDelete(host.id, opts),
                  })
                }
              >
                {deleteLabel}
              </Button>
            )}
          </Space>
        </Card>
      ) : (
        <Typography.Text type="secondary">
          Deleted hosts do not expose further destructive actions.
        </Typography.Text>
      )}
      {isSelfHost && selfHost && !host.deleted ? (
        <Card
          size="small"
          title="Connector actions"
          styles={{ body: { padding: 12 } }}
        >
          <Space orientation="vertical" size="small" style={{ width: "100%" }}>
            <Typography.Text type="secondary">
              These actions affect the self-host connector relationship rather
              than the cloud host lifecycle itself.
            </Typography.Text>
            <Space wrap>
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
        </Card>
      ) : null}
    </Space>
  ) : null;
  const tabItems = [
    {
      key: "overview",
      label: "Overview",
      children: overviewContent,
    },
    {
      key: "runtime",
      label: "Runtime",
      children:
        deploymentStatus ||
        host?.version ||
        host?.project_bundle_version ||
        host?.tools_version ||
        softwareVersions ? (
          <Space orientation="vertical" size="small" style={{ width: "100%" }}>
            <Space wrap align="center">
              <Typography.Text strong>Runtime software</Typography.Text>
              <Popover content={softwareHelp} trigger="click">
                <Button
                  type="text"
                  size="small"
                  icon={<QuestionCircleOutlined />}
                />
              </Popover>
              {(softwareVersions || runtimeDeployments) && (
                <Button
                  type="text"
                  size="small"
                  icon={
                    <SyncOutlined
                      spin={
                        !!softwareVersions?.loading ||
                        !!runtimeDeployments?.loading ||
                        !!runtimeDeployments?.refreshing
                      }
                    />
                  }
                  onClick={() => {
                    Promise.all([
                      softwareVersions?.refresh?.(),
                      runtimeDeployments?.refresh?.(),
                    ]).catch((err) => {
                      console.error("failed to refresh runtime software", err);
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
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Version entries below show the raw version plus inferred build
              time and published message when that metadata is available.
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
            {runtimeDeployments?.error && (
              <Alert
                type="warning"
                showIcon
                title="Runtime deployment status unavailable"
                description={runtimeDeployments.error}
              />
            )}
            {deploymentStatus?.observation_error && (
              <Alert
                type="warning"
                showIcon
                title="Host observation warning"
                description={deploymentStatus.observation_error}
              />
            )}
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
            {deploymentStatus?.observed_host_agent?.project_host && (
              <Card size="small" title="Host agent rollback state">
                <Space orientation="vertical" size="small">
                  {projectHostComponentDeployment?.scope_type === "host" && (
                    <Alert
                      type="warning"
                      showIcon
                      message="Project-host is pinned away from the cluster default"
                      description={
                        <span>
                          This host currently overrides the cluster default and
                          stays on{" "}
                          <code>
                            {projectHostComponentDeployment.desired_version}
                          </code>
                          {observedTargetForArtifact(
                            deploymentStatus,
                            "project-host",
                          )?.desired_version ? (
                            <>
                              {" "}
                              while the fleet target is{" "}
                              <code>
                                {
                                  observedTargetForArtifact(
                                    deploymentStatus,
                                    "project-host",
                                  )?.desired_version
                                }
                              </code>
                              .
                            </>
                          ) : (
                            "."
                          )}{" "}
                          Reason:{" "}
                          {formatRolloutReason(
                            projectHostComponentDeployment.rollout_reason,
                          )}
                          . Use <strong>Resume cluster default</strong> when you
                          are ready to retry the fleet version.
                        </span>
                      }
                    />
                  )}
                  {deploymentStatus.observed_host_agent.project_host
                    .last_known_good_version && (
                    <Typography.Text>
                      Last known good:{" "}
                      <code>
                        {
                          deploymentStatus.observed_host_agent.project_host
                            .last_known_good_version
                        }
                      </code>
                    </Typography.Text>
                  )}
                  {deploymentStatus.observed_host_agent.project_host
                    .pending_rollout && (
                    <Alert
                      type="info"
                      showIcon
                      message="Project-host rollout in progress"
                      description={
                        <span>
                          Target{" "}
                          <code>
                            {
                              deploymentStatus.observed_host_agent.project_host
                                .pending_rollout.target_version
                            }
                          </code>{" "}
                          from{" "}
                          <code>
                            {
                              deploymentStatus.observed_host_agent.project_host
                                .pending_rollout.previous_version
                            }
                          </code>
                          {formatRuntimeTimestamp(
                            deploymentStatus.observed_host_agent.project_host
                              .pending_rollout.started_at,
                          ) && (
                            <>
                              {" "}
                              · started{" "}
                              {formatRuntimeTimestamp(
                                deploymentStatus.observed_host_agent
                                  .project_host.pending_rollout.started_at,
                              )}
                            </>
                          )}
                          {formatRuntimeTimestamp(
                            deploymentStatus.observed_host_agent.project_host
                              .pending_rollout.deadline_at,
                          ) && (
                            <>
                              {" "}
                              · deadline{" "}
                              {formatRuntimeTimestamp(
                                deploymentStatus.observed_host_agent
                                  .project_host.pending_rollout.deadline_at,
                              )}
                            </>
                          )}
                        </span>
                      }
                    />
                  )}
                  {deploymentStatus.observed_host_agent.project_host
                    .last_automatic_rollback && (
                    <Alert
                      type="warning"
                      showIcon
                      message="Last automatic rollback"
                      description={
                        <span>
                          Target{" "}
                          <code>
                            {
                              deploymentStatus.observed_host_agent.project_host
                                .last_automatic_rollback.target_version
                            }
                          </code>{" "}
                          rolled back to{" "}
                          <code>
                            {
                              deploymentStatus.observed_host_agent.project_host
                                .last_automatic_rollback.rollback_version
                            }
                          </code>
                          {formatRuntimeTimestamp(
                            deploymentStatus.observed_host_agent.project_host
                              .last_automatic_rollback.finished_at,
                          ) && (
                            <>
                              {" "}
                              · finished{" "}
                              {formatRuntimeTimestamp(
                                deploymentStatus.observed_host_agent
                                  .project_host.last_automatic_rollback
                                  .finished_at,
                              )}
                            </>
                          )}{" "}
                          ·{" "}
                          {projectHostRollbackReasonLabel(
                            deploymentStatus.observed_host_agent.project_host
                              .last_automatic_rollback.reason,
                          )}
                        </span>
                      }
                    />
                  )}
                </Space>
              </Card>
            )}
            {showUpgradeProgress && <HostOpProgress op={displayActiveOp} />}
            <Space
              orientation="vertical"
              size="small"
              style={{ width: "100%" }}
            >
              <Space wrap align="center">
                <Typography.Text strong>
                  Runtime software artifacts
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Desired versions, observed versions, and rollout controls for
                  host software artifacts.
                </Typography.Text>
              </Space>
              {SOFTWARE_ARTIFACTS.map(({ artifact, label, desiredLabel }) => {
                const running = runningVersion(host, artifact);
                const buildId = runningBuildId(host, artifact);
                const configured = sourceVersionForArtifact({
                  artifact,
                  softwareVersions,
                  source: "configured",
                });
                const hubVersion = sourceVersionForArtifact({
                  artifact,
                  softwareVersions,
                  source: "hub",
                });
                const deployment = deploymentRecordForArtifact(
                  deploymentStatus,
                  artifact,
                );
                const observedTarget = observedTargetForArtifact(
                  deploymentStatus,
                  artifact,
                );
                const observedArtifact = observedArtifactForArtifact(
                  deploymentStatus,
                  artifact,
                );
                const rollbackTarget = rollbackTargetForArtifact(
                  deploymentStatus,
                  artifact,
                );
                const componentOverride =
                  artifact === "project-host"
                    ? projectHostComponentDeployment
                    : undefined;
                const hasHostOverride =
                  componentOverride?.scope_type === "host" ||
                  deployment?.scope_type === "host";
                const effectiveDesiredVersion =
                  componentOverride?.desired_version ??
                  deployment?.desired_version;
                const effectiveOverrideReason =
                  componentOverride?.rollout_reason ??
                  deployment?.rollout_reason;
                const currentVersion =
                  observedTarget?.current_version ??
                  observedArtifact?.current_version ??
                  running;
                const installedVersions =
                  observedTarget?.installed_versions ??
                  observedArtifact?.installed_versions ??
                  [];
                const primaryRollback =
                  primaryRollbackSelection(rollbackTarget);
                const rollbackVersion = primaryRollback.version;
                const rollbackOptions = rollbackVersionOptions(rollbackTarget);
                const selectedRollbackVersion =
                  artifactRollbackSelection[artifact] ??
                  rollbackVersion ??
                  rollbackOptions[0];
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
                        {observedVersionStateTag(
                          observedTarget?.observed_version_state,
                        )}
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 12 }}
                        >
                          {desiredLabel}
                        </Typography.Text>
                        {hasHostOverride && (
                          <Tag color="blue">host override</Tag>
                        )}
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
                          desired{" "}
                          <code>{effectiveDesiredVersion ?? "n/a"}</code> |
                          current <code>{currentVersion ?? "n/a"}</code> |
                          latest <code>{configured?.version ?? "unknown"}</code>
                        </Typography.Text>
                        <Space wrap>
                          {canUpgrade &&
                            !host.deleted &&
                            onSetRuntimeArtifactDeployment &&
                            configured?.version && (
                              <Popconfirm
                                title={upgradeTitle({
                                  label,
                                  source: "the configured source",
                                })}
                                okText="Deploy"
                                cancelText="Cancel"
                                onConfirm={() =>
                                  onSetRuntimeArtifactDeployment({
                                    host,
                                    artifact,
                                    desired_version: configured.version!,
                                    source: "configured",
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
                                  Deploy latest
                                </Button>
                              </Popconfirm>
                            )}
                          {canUpgrade &&
                            !host.deleted &&
                            onSetRuntimeArtifactDeployment &&
                            hubVersion?.version && (
                              <Popconfirm
                                title={upgradeTitle({
                                  label,
                                  source: "this hub source",
                                })}
                                okText="Deploy"
                                cancelText="Cancel"
                                onConfirm={() =>
                                  onSetRuntimeArtifactDeployment({
                                    host,
                                    artifact,
                                    desired_version: hubVersion.version!,
                                    source: "hub",
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
                                  Deploy hub latest
                                </Button>
                              </Popconfirm>
                            )}
                          {canUpgrade &&
                            !host.deleted &&
                            hasHostOverride &&
                            onResumeRuntimeArtifactClusterDefault && (
                              <Popconfirm
                                title={`Resume following the cluster default for ${label.toLowerCase()}?`}
                                description={`This deletes the host-specific desired version for ${label.toLowerCase()}. After that, this host will inherit the cluster default again, and if the host is running the backend may immediately queue the corresponding reconcile/upgrade work.`}
                                okText="Resume default"
                                cancelText="Cancel"
                                onConfirm={() =>
                                  onResumeRuntimeArtifactClusterDefault({
                                    host,
                                    artifact,
                                  })
                                }
                                disabled={hostOpActive}
                              >
                                <Button size="small" disabled={hostOpActive}>
                                  Resume cluster default
                                </Button>
                              </Popconfirm>
                            )}
                          {canUpgrade &&
                            !host.deleted &&
                            onRollbackRuntimeArtifact &&
                            rollbackVersion && (
                              <Popconfirm
                                title={`Roll back ${label.toLowerCase()} to ${primaryRollback.label}?`}
                                description={`This will switch this host to ${rollbackVersion}.`}
                                okText="Rollback"
                                cancelText="Cancel"
                                onConfirm={() =>
                                  onRollbackRuntimeArtifact({
                                    host,
                                    artifact,
                                    ...(rollbackTarget?.last_known_good_version
                                      ? { last_known_good: true }
                                      : { version: rollbackVersion }),
                                  })
                                }
                                disabled={hostOpActive}
                              >
                                <Button size="small" disabled={hostOpActive}>
                                  {primaryRollback.source === "last_known_good"
                                    ? "Rollback to last known good"
                                    : primaryRollback.source ===
                                        "previous_version"
                                      ? "Rollback to previous"
                                      : "Rollback"}
                                </Button>
                              </Popconfirm>
                            )}
                          <RuntimeCliButton
                            title={`${label} CLI`}
                            commands={commands}
                          />
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
                            {expanded ? "Hide details" : "Show details"}
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
                          {observedArtifact?.current_build_id && !buildId && (
                            <Typography.Text
                              copyable={{
                                text: observedArtifact.current_build_id,
                              }}
                            >
                              Build ID:{" "}
                              <code>{observedArtifact.current_build_id}</code>
                            </Typography.Text>
                          )}
                          <Typography.Text>
                            Latest hub source:{" "}
                            <code>{hubVersion?.version ?? "unknown"}</code>{" "}
                            {availableVersionTag({
                              running: currentVersion,
                              latest: hubVersion?.version,
                              error: hubVersion?.error,
                            })}
                          </Typography.Text>
                          <RuntimeVersionList
                            title="Installed versions"
                            emptyText="none reported"
                            artifact={artifact}
                            versions={installedVersions}
                            rollbackTarget={rollbackTarget}
                            metadataIndex={versionMetadataIndex}
                          />
                          {!!formatBytes(
                            observedArtifact?.installed_bytes_total,
                          ) && (
                            <Typography.Text>
                              Installed size:{" "}
                              <code>
                                {formatBytes(
                                  observedArtifact?.installed_bytes_total,
                                )}
                              </code>
                            </Typography.Text>
                          )}
                          {!!observedArtifact?.referenced_versions?.length && (
                            <Typography.Text>
                              Referenced by running projects:{" "}
                              <code>
                                {observedArtifact.referenced_versions
                                  .map(
                                    ({ version, project_count }) =>
                                      `${version} x${project_count}`,
                                  )
                                  .join(", ")}
                              </code>
                            </Typography.Text>
                          )}
                          {observedTarget?.observed_version_state ===
                            "missing" && (
                            <Alert
                              type="warning"
                              showIcon
                              message="Desired version is not installed on this host yet"
                              description="Setting a desired version queues the corresponding host artifact operation automatically. Use Refresh to watch that operation appear in the host activity panel."
                            />
                          )}
                          {rollbackTarget && (
                            <Typography.Text>
                              Retention keep floor:{" "}
                              <code>
                                {rollbackTarget.retention_policy?.keep_count ??
                                  "unknown"}
                              </code>
                            </Typography.Text>
                          )}
                          {rollbackTarget && (
                            <Typography.Text>
                              Retention byte budget:{" "}
                              <code>
                                {formatBytes(
                                  rollbackTarget.retention_policy?.max_bytes,
                                ) || "none"}
                              </code>
                            </Typography.Text>
                          )}
                          <RuntimeRetentionExplanation
                            rollbackTarget={rollbackTarget}
                          />
                          {rollbackTarget && (
                            <Space
                              direction="vertical"
                              size={4}
                              style={{ width: "100%" }}
                            >
                              <Typography.Text>
                                Rollback candidate:
                              </Typography.Text>
                              {rollbackTarget.last_known_good_version ||
                              rollbackTarget.previous_version ? (
                                <RuntimeVersionDisplay
                                  artifact={artifact}
                                  version={
                                    rollbackTarget.last_known_good_version ??
                                    rollbackTarget.previous_version ??
                                    ""
                                  }
                                  rollbackTarget={rollbackTarget}
                                  metadataIndex={versionMetadataIndex}
                                />
                              ) : (
                                <Typography.Text type="secondary">
                                  none
                                </Typography.Text>
                              )}
                            </Space>
                          )}
                          <RuntimeVersionList
                            title="Protected from pruning"
                            emptyText="none"
                            artifact={artifact}
                            versions={rollbackTarget?.protected_versions}
                            rollbackTarget={rollbackTarget}
                            metadataIndex={versionMetadataIndex}
                            section="protected"
                          />
                          {!!formatBytes(
                            rollbackTarget?.protected_bytes_total,
                          ) && (
                            <Typography.Text>
                              Protected bytes:{" "}
                              <code>
                                {formatBytes(
                                  rollbackTarget?.protected_bytes_total,
                                )}
                              </code>
                            </Typography.Text>
                          )}
                          <RuntimeVersionList
                            title="Prune candidates"
                            emptyText="none"
                            artifact={artifact}
                            versions={rollbackTarget?.prune_candidate_versions}
                            rollbackTarget={rollbackTarget}
                            metadataIndex={versionMetadataIndex}
                            section="prune"
                          />
                          {!!formatBytes(
                            rollbackTarget?.prune_candidate_bytes_total,
                          ) && (
                            <Typography.Text>
                              Prune-candidate bytes:{" "}
                              <code>
                                {formatBytes(
                                  rollbackTarget?.prune_candidate_bytes_total,
                                )}
                              </code>
                            </Typography.Text>
                          )}
                          {canUpgrade &&
                            !host.deleted &&
                            onRollbackRuntimeArtifact &&
                            rollbackOptions.length > 0 && (
                              <Space wrap align="center">
                                <Typography.Text>
                                  Roll back to retained version:
                                </Typography.Text>
                                <Select
                                  size="small"
                                  style={{ minWidth: 320 }}
                                  popupMatchSelectWidth={480}
                                  value={selectedRollbackVersion}
                                  onChange={(value) =>
                                    setArtifactRollbackSelection((prev) => ({
                                      ...prev,
                                      [artifact]: value,
                                    }))
                                  }
                                  options={rollbackOptions.map((value) => ({
                                    value,
                                    label: (
                                      <RuntimeVersionDisplay
                                        artifact={artifact}
                                        version={value}
                                        rollbackTarget={rollbackTarget}
                                        metadataIndex={versionMetadataIndex}
                                        section="option"
                                      />
                                    ),
                                  }))}
                                  disabled={hostOpActive}
                                />
                                <Popconfirm
                                  title={`Roll back ${label.toLowerCase()} to ${selectedRollbackVersion}?`}
                                  okText="Rollback"
                                  cancelText="Cancel"
                                  onConfirm={() =>
                                    selectedRollbackVersion
                                      ? onRollbackRuntimeArtifact({
                                          host,
                                          artifact,
                                          version: selectedRollbackVersion,
                                        })
                                      : undefined
                                  }
                                  disabled={
                                    hostOpActive || !selectedRollbackVersion
                                  }
                                >
                                  <Button
                                    size="small"
                                    disabled={
                                      hostOpActive || !selectedRollbackVersion
                                    }
                                  >
                                    Rollback to version
                                  </Button>
                                </Popconfirm>
                              </Space>
                            )}
                          {hasHostOverride && (
                            <Alert
                              type="info"
                              showIcon
                              message="This host is pinned by a host-specific override"
                              description={`Reason: ${formatRolloutReason(effectiveOverrideReason)}. Use “Resume cluster default” to remove the override and inherit the fleet default again.`}
                            />
                          )}
                        </Space>
                      )}
                    </Space>
                  </Card>
                );
              })}
            </Space>
            <Divider style={{ margin: "4px 0" }} />
            <Space
              orientation="vertical"
              size="small"
              style={{ width: "100%" }}
            >
              <Space wrap align="center">
                <Typography.Text strong>
                  Managed daemon components
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Runtime state and desired versions for managed host daemons.
                </Typography.Text>
              </Space>
              {DAEMON_COMPONENTS.map(({ component, label }) => {
                const deployment = componentDeploymentRecord(
                  deploymentStatus,
                  component,
                );
                const observedTarget = observedTargetForComponent(
                  deploymentStatus,
                  component,
                );
                const observedComponent = observedComponentForComponent(
                  deploymentStatus,
                  component,
                );
                const rollbackTarget = rollbackTargetForComponent(
                  deploymentStatus,
                  component,
                );
                const configured = sourceVersionForComponent({
                  softwareVersions,
                  source: "configured",
                });
                const hubVersion = sourceVersionForComponent({
                  softwareVersions,
                  source: "hub",
                });
                const desiredVersion =
                  deployment?.desired_version ??
                  observedTarget?.desired_version;
                const currentVersion =
                  observedTarget?.current_version ??
                  observedComponent?.running_versions?.[0];
                const versionState =
                  observedTarget?.observed_version_state ??
                  observedComponent?.version_state;
                const runtimeState =
                  observedTarget?.observed_runtime_state ??
                  observedComponent?.runtime_state;
                const runningVersions =
                  observedTarget?.running_versions ??
                  observedComponent?.running_versions ??
                  [];
                const runningPids =
                  observedTarget?.running_pids ??
                  observedComponent?.running_pids ??
                  [];
                const primaryRollback =
                  primaryRollbackSelection(rollbackTarget);
                const rollbackVersion = primaryRollback.version;
                const rollbackOptions = rollbackVersionOptions(rollbackTarget);
                const selectedRollbackVersion =
                  componentRollbackSelection[component] ??
                  rollbackVersion ??
                  rollbackOptions[0];
                const hasHostOverride = deployment?.scope_type === "host";
                const enabled =
                  observedTarget?.enabled ?? observedComponent?.enabled;
                const managed =
                  observedTarget?.managed ?? observedComponent?.managed;
                const modeDetails = componentModeDetails({
                  managed,
                  runningVersions,
                  runningPids,
                });
                const commands = cliCommandsForComponent({ host, component });
                const expanded = !!expandedComponents[component];
                return (
                  <Card
                    key={component}
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
                        {modeDetails.tag}
                        {!modeDetails.externallyManaged &&
                          runtimeStateTag(runtimeState)}
                        {!modeDetails.externallyManaged &&
                          observedVersionStateTag(versionState)}
                        {hasHostOverride && (
                          <Tag color="blue">host override</Tag>
                        )}
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
                          desired <code>{desiredVersion ?? "n/a"}</code> |
                          current{" "}
                          <code>
                            {modeDetails.summary ?? currentVersion ?? "n/a"}
                          </code>{" "}
                          | latest{" "}
                          <code>{configured?.version ?? "unknown"}</code>
                        </Typography.Text>
                        <Space wrap>
                          {canUpgrade &&
                            !host.deleted &&
                            !modeDetails.externallyManaged &&
                            onSetRuntimeComponentDeployment &&
                            configured?.version && (
                              <Popconfirm
                                title={upgradeTitle({
                                  label,
                                  source: "the configured source",
                                })}
                                okText="Deploy"
                                cancelText="Cancel"
                                onConfirm={() =>
                                  onSetRuntimeComponentDeployment({
                                    host,
                                    component,
                                    desired_version: configured.version!,
                                    source: "configured",
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
                                  Deploy latest
                                </Button>
                              </Popconfirm>
                            )}
                          {canUpgrade &&
                            !host.deleted &&
                            !modeDetails.externallyManaged &&
                            onSetRuntimeComponentDeployment &&
                            hubVersion?.version && (
                              <Popconfirm
                                title={upgradeTitle({
                                  label,
                                  source: "this hub source",
                                })}
                                okText="Deploy"
                                cancelText="Cancel"
                                onConfirm={() =>
                                  onSetRuntimeComponentDeployment({
                                    host,
                                    component,
                                    desired_version: hubVersion.version!,
                                    source: "hub",
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
                                  Deploy hub latest
                                </Button>
                              </Popconfirm>
                            )}
                          {canUpgrade &&
                            !host.deleted &&
                            hasHostOverride &&
                            onResumeRuntimeComponentClusterDefault && (
                              <Popconfirm
                                title={`Resume following the cluster default for ${label.toLowerCase()}?`}
                                description={`This deletes the host-specific desired version for ${label.toLowerCase()}. After that, this daemon will inherit the cluster default again, and if the host is running the backend may immediately queue the corresponding reconcile/restart work.`}
                                okText="Resume default"
                                cancelText="Cancel"
                                onConfirm={() =>
                                  onResumeRuntimeComponentClusterDefault({
                                    host,
                                    component,
                                  })
                                }
                                disabled={hostOpActive}
                              >
                                <Button size="small" disabled={hostOpActive}>
                                  Resume cluster default
                                </Button>
                              </Popconfirm>
                            )}
                          {canUpgrade &&
                            !host.deleted &&
                            !modeDetails.externallyManaged &&
                            onRestartRuntimeComponent && (
                              <Popconfirm
                                title={`Restart ${label.toLowerCase()} on this host?`}
                                description="This restarts the currently desired version without changing desired state."
                                okText="Restart"
                                cancelText="Cancel"
                                onConfirm={() =>
                                  onRestartRuntimeComponent({
                                    host,
                                    component,
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
                                  Restart
                                </Button>
                              </Popconfirm>
                            )}
                          {canUpgrade &&
                            !host.deleted &&
                            !modeDetails.externallyManaged &&
                            onRollbackRuntimeComponent &&
                            rollbackVersion && (
                              <Popconfirm
                                title={`Roll back ${label.toLowerCase()} to ${primaryRollback.label}?`}
                                description={`This will switch this host to ${rollbackVersion}.`}
                                okText="Rollback"
                                cancelText="Cancel"
                                onConfirm={() =>
                                  onRollbackRuntimeComponent({
                                    host,
                                    component,
                                    ...(rollbackTarget?.last_known_good_version
                                      ? { last_known_good: true }
                                      : { version: rollbackVersion }),
                                  })
                                }
                                disabled={hostOpActive}
                              >
                                <Button size="small" disabled={hostOpActive}>
                                  {primaryRollback.source === "last_known_good"
                                    ? "Rollback to last known good"
                                    : primaryRollback.source ===
                                        "previous_version"
                                      ? "Rollback to previous"
                                      : "Rollback"}
                                </Button>
                              </Popconfirm>
                            )}
                          <RuntimeCliButton
                            title={`${label} CLI`}
                            commands={commands}
                          />
                          <Button
                            size="small"
                            type="link"
                            onClick={() =>
                              setExpandedComponents((prev) => ({
                                ...prev,
                                [component]: !prev[component],
                              }))
                            }
                          >
                            {expanded ? "Hide details" : "Show details"}
                          </Button>
                        </Space>
                      </Space>
                      {expanded && (
                        <Space
                          orientation="vertical"
                          size="small"
                          style={{ width: "100%" }}
                        >
                          <Typography.Text>
                            Upgrade policy:{" "}
                            <code>
                              {formatUpgradePolicy(
                                deployment?.rollout_policy ??
                                  observedComponent?.upgrade_policy,
                              )}
                            </code>
                          </Typography.Text>
                          <Typography.Text>
                            Enabled: {enabled ? "yes" : "no"} · Managed:{" "}
                            {managed ? "yes" : "no"}
                          </Typography.Text>
                          {!!runningVersions.length && (
                            <Typography.Text>
                              Running versions:{" "}
                              <code>{runningVersions.join(", ")}</code>
                            </Typography.Text>
                          )}
                          {!!runningPids.length && (
                            <Typography.Text>
                              Running PIDs:{" "}
                              <code>{runningPids.join(", ")}</code>
                            </Typography.Text>
                          )}
                          {rollbackTarget && (
                            <Typography.Text>
                              Retention keep floor:{" "}
                              <code>
                                {rollbackTarget.retention_policy?.keep_count ??
                                  "unknown"}
                              </code>
                            </Typography.Text>
                          )}
                          {rollbackTarget && (
                            <Typography.Text>
                              Retention byte budget:{" "}
                              <code>
                                {formatBytes(
                                  rollbackTarget.retention_policy?.max_bytes,
                                ) || "none"}
                              </code>
                            </Typography.Text>
                          )}
                          <RuntimeRetentionExplanation
                            rollbackTarget={rollbackTarget}
                          />
                          {rollbackTarget && (
                            <Space
                              direction="vertical"
                              size={4}
                              style={{ width: "100%" }}
                            >
                              <Typography.Text>
                                Rollback candidate:
                              </Typography.Text>
                              {rollbackTarget.last_known_good_version ||
                              rollbackTarget.previous_version ? (
                                <RuntimeVersionDisplay
                                  artifact="project-host"
                                  version={
                                    rollbackTarget.last_known_good_version ??
                                    rollbackTarget.previous_version ??
                                    ""
                                  }
                                  rollbackTarget={rollbackTarget}
                                  metadataIndex={versionMetadataIndex}
                                />
                              ) : (
                                <Typography.Text type="secondary">
                                  none
                                </Typography.Text>
                              )}
                            </Space>
                          )}
                          <RuntimeVersionList
                            title="Protected from pruning"
                            emptyText="none"
                            artifact="project-host"
                            versions={rollbackTarget?.protected_versions}
                            rollbackTarget={rollbackTarget}
                            metadataIndex={versionMetadataIndex}
                            section="protected"
                          />
                          {!!formatBytes(
                            rollbackTarget?.protected_bytes_total,
                          ) && (
                            <Typography.Text>
                              Protected bytes:{" "}
                              <code>
                                {formatBytes(
                                  rollbackTarget?.protected_bytes_total,
                                )}
                              </code>
                            </Typography.Text>
                          )}
                          <RuntimeVersionList
                            title="Prune candidates"
                            emptyText="none"
                            artifact="project-host"
                            versions={rollbackTarget?.prune_candidate_versions}
                            rollbackTarget={rollbackTarget}
                            metadataIndex={versionMetadataIndex}
                            section="prune"
                          />
                          {!!formatBytes(
                            rollbackTarget?.prune_candidate_bytes_total,
                          ) && (
                            <Typography.Text>
                              Prune-candidate bytes:{" "}
                              <code>
                                {formatBytes(
                                  rollbackTarget?.prune_candidate_bytes_total,
                                )}
                              </code>
                            </Typography.Text>
                          )}
                          {canUpgrade &&
                            !host.deleted &&
                            !modeDetails.externallyManaged &&
                            onRollbackRuntimeComponent &&
                            rollbackOptions.length > 0 && (
                              <Space wrap align="center">
                                <Typography.Text>
                                  Roll back to retained version:
                                </Typography.Text>
                                <Select
                                  size="small"
                                  style={{ minWidth: 320 }}
                                  popupMatchSelectWidth={480}
                                  value={selectedRollbackVersion}
                                  onChange={(value) =>
                                    setComponentRollbackSelection((prev) => ({
                                      ...prev,
                                      [component]: value,
                                    }))
                                  }
                                  options={rollbackOptions.map((value) => ({
                                    value,
                                    label: (
                                      <RuntimeVersionDisplay
                                        artifact="project-host"
                                        version={value}
                                        rollbackTarget={rollbackTarget}
                                        metadataIndex={versionMetadataIndex}
                                        section="option"
                                      />
                                    ),
                                  }))}
                                  disabled={hostOpActive}
                                />
                                <Popconfirm
                                  title={`Roll back ${label.toLowerCase()} to ${selectedRollbackVersion}?`}
                                  okText="Rollback"
                                  cancelText="Cancel"
                                  onConfirm={() =>
                                    selectedRollbackVersion
                                      ? onRollbackRuntimeComponent({
                                          host,
                                          component,
                                          version: selectedRollbackVersion,
                                        })
                                      : undefined
                                  }
                                  disabled={
                                    hostOpActive || !selectedRollbackVersion
                                  }
                                >
                                  <Button
                                    size="small"
                                    disabled={
                                      hostOpActive || !selectedRollbackVersion
                                    }
                                  >
                                    Rollback to version
                                  </Button>
                                </Popconfirm>
                              </Space>
                            )}
                          {hasHostOverride && (
                            <Alert
                              type="info"
                              showIcon
                              message="This daemon is pinned by a host-specific override"
                              description={`Reason: ${formatRolloutReason(deployment?.rollout_reason)}. Use “Resume cluster default” to remove the override and inherit the fleet default again.`}
                            />
                          )}
                          {modeDetails.externallyManaged && (
                            <Alert
                              type="info"
                              showIcon
                              message="This component is using an external endpoint"
                              description="This host is not running or observing a local daemon for this component, so the current runtime version is not available from host telemetry."
                            />
                          )}
                          {versionState === "missing" && (
                            <Alert
                              type="warning"
                              showIcon
                              message="Desired daemon version is not installed on this host yet"
                              description="Setting a desired version queues the corresponding reconcile automatically. Use Refresh to watch the host activity panel for the rollout."
                            />
                          )}
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
              {canRefreshCloudStatus && host && onRefreshCloudStatus && (
                <Popconfirm
                  title="Refresh cloud/provider status for this host?"
                  description="This forces an immediate cloud reconcile for this host's provider and updates the host row if reality drifted."
                  okText="Refresh"
                  cancelText="Cancel"
                  onConfirm={() => onRefreshCloudStatus(host)}
                  disabled={hostOpActive}
                >
                  <Button size="small" disabled={hostOpActive}>
                    Refresh Cloud Status
                  </Button>
                </Popconfirm>
              )}
              {canUpgrade && host && !host.deleted && onUpgradeAll && (
                <Popconfirm
                  title="Upgrade all runtime components"
                  description={upgradeAllConfirmContent}
                  okText="Upgrade"
                  cancelText="Cancel"
                  onConfirm={() => onUpgradeAll(host)}
                  disabled={hostOpActive || host.status !== "running"}
                >
                  <Button
                    size="small"
                    disabled={hostOpActive || host.status !== "running"}
                  >
                    Upgrade all now
                  </Button>
                </Popconfirm>
              )}
              {canUpgrade && host && !host.deleted && onUpgradeAllFromHub && (
                <Popconfirm
                  title="Upgrade all runtime components from hub"
                  description={upgradeAllFromHubConfirmContent}
                  okText="Upgrade"
                  cancelText="Cancel"
                  onConfirm={() => onUpgradeAllFromHub(host)}
                  disabled={hostOpActive || host.status !== "running"}
                >
                  <Button
                    size="small"
                    disabled={hostOpActive || host.status !== "running"}
                  >
                    Upgrade all from hub now
                  </Button>
                </Popconfirm>
              )}
            </Space>
            {parallelOps ? (
              <>
                <Divider style={{ margin: "4px 0" }} />
                <HostParallelOpsPanel
                  host_id={host.id}
                  status={parallelOps.status}
                  loading={parallelOps.loading}
                  savingKey={parallelOps.savingKey}
                  onSetLimit={parallelOps.setLimit}
                  onClearLimit={parallelOps.clearLimit}
                />
              </>
            ) : null}
          </Space>
        ) : (
          <Typography.Text type="secondary">
            No runtime deployment details reported yet.
          </Typography.Text>
        ),
    },
    {
      key: "projects",
      label: "Projects",
      children: projectsContent,
    },
    {
      key: "storage",
      label: "Storage",
      children: storageContent,
    },
    {
      key: "logs",
      label: "Logs",
      children: logsContent,
    },
    {
      key: "danger",
      label: "Danger",
      children: dangerContent,
    },
  ];
  return (
    <Drawer
      size={drawerWidth}
      title={
        <Space>
          <Icon name="server" /> {host.name ?? "Host details"}
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
          {onlineTag}
          <Button
            type="link"
            size="small"
            disabled={!!host.deleted || hostOpActive}
            onClick={() => onEdit(host)}
          >
            Edit
          </Button>
        </Space>
      }
      onClose={onClose}
      resizable={{ onResize: handleResize }}
      open={open}
    >
      <Space orientation="vertical" style={{ width: "100%" }} size="middle">
        <Space size="small" wrap>
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
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
        <HostProjectsBrowser
          host={host}
          open={showProjects}
          onClose={() => setShowProjects(false)}
          hostOpActive={hostOpActive}
          onStopRunningProjects={onStopRunningProjects}
          onRestartRunningProjects={onRestartRunningProjects}
        />
      </Space>
    </Drawer>
  );
};
