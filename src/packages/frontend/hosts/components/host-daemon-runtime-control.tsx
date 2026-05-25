/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Divider,
  Popconfirm,
  Popover,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  CodeOutlined,
  DownOutlined,
  MoreOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import { React } from "@cocalc/frontend/app-framework";
import { Tooltip } from "@cocalc/frontend/components";
import type {
  Host,
  HostRuntimeDeploymentObservedVersionState,
  HostRuntimeDeploymentStatus,
  HostRuntimeRollbackTarget,
  HostSoftwareArtifact,
  HostSoftwareAvailableVersion,
} from "@cocalc/conat/hub/api/hosts";
import type {
  HostManagedComponentStatus,
  ManagedComponentKind,
  ManagedComponentRuntimeState,
  ManagedComponentUpgradePolicy,
} from "@cocalc/conat/project-host/api";
import { humanSize } from "@cocalc/util/misc";

const DAEMON_COMPONENTS: Array<{
  component: ManagedComponentKind;
  shortLabel: string;
  label: string;
  disruptive: boolean;
}> = [
  {
    component: "project-host",
    shortLabel: "host",
    label: "Project host",
    disruptive: false,
  },
  {
    component: "conat-router",
    shortLabel: "router",
    label: "Conat router",
    disruptive: true,
  },
  {
    component: "conat-persist",
    shortLabel: "persist",
    label: "Conat persist",
    disruptive: true,
  },
  {
    component: "acp-worker",
    shortLabel: "acp",
    label: "ACP worker",
    disruptive: true,
  },
];

type SoftwareVersions = {
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

type RuntimeDeployments = {
  status?: HostRuntimeDeploymentStatus;
  loading: boolean;
  refreshing: boolean;
  error?: string;
  refresh: () => Promise<void>;
};

type RuntimeLogViewer = {
  load: (opts?: {
    source?: ManagedComponentKind;
    lines?: number;
  }) => Promise<void>;
};

type Props = {
  host: Host;
  deploymentStatus?: HostRuntimeDeploymentStatus;
  softwareVersions?: SoftwareVersions;
  runtimeDeployments?: RuntimeDeployments;
  runtimeLogViewer?: RuntimeLogViewer;
  canUpgrade?: boolean;
  hostOpActive?: boolean;
  canReconcile?: boolean;
  canRefreshCloudStatus?: boolean;
  onRefresh?: () => void;
  onReconcile?: (host: Host) => void;
  onRefreshCloudStatus?: (host: Host) => void;
  onUpgradeAll?: (host: Host) => void;
  onUpgradeAllFromHub?: (host: Host) => void;
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
  compact?: boolean;
};

type RuntimeVersionMetadata = {
  built_at?: string;
  message?: string;
  source?: "configured" | "hub";
};

type RuntimeVersionMetadataIndex = Map<string, RuntimeVersionMetadata>;

function runtimeVersionKey(version: string) {
  return `project-host:${version}`;
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
      if (row.artifact !== "project-host") continue;
      const version = `${row.version ?? ""}`.trim();
      if (!version) continue;
      const prev = out.get(runtimeVersionKey(version));
      if (prev?.built_at && prev?.message) continue;
      out.set(runtimeVersionKey(version), {
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
  const buildId = value.match(/^(\d{8}T\d{6}Z)(?:-|$)/)?.[1];
  if (!buildId) return undefined;
  const ts = Date.parse(buildId);
  return Number.isFinite(ts) ? ts : undefined;
}

function shortVersion({
  version,
  metadataIndex,
}: {
  version?: string;
  metadataIndex: RuntimeVersionMetadataIndex;
}): React.ReactNode {
  const raw = `${version ?? ""}`.trim();
  if (!raw) return <Typography.Text type="secondary">n/a</Typography.Text>;
  const metadata = metadataIndex.get(runtimeVersionKey(raw));
  const builtAt = metadata?.built_at
    ? Date.parse(metadata.built_at)
    : inferredVersionTimestamp(raw);
  const sha = raw.match(/-([0-9a-f]{7,40})(?:-|$)/i)?.[1]?.slice(0, 8);
  const dirty = raw.includes("-dirty-") ? "dirty" : undefined;
  const built =
    builtAt && Number.isFinite(builtAt)
      ? new Date(builtAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
        })
      : undefined;
  const label = [built, sha, dirty].filter(Boolean).join(" · ") || raw;
  return (
    <Tooltip title={<code>{raw}</code>}>
      <Typography.Text code copyable={{ text: raw }}>
        {label}
      </Typography.Text>
    </Tooltip>
  );
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

function versionStateTag(state?: HostRuntimeDeploymentObservedVersionState) {
  switch (state) {
    case "aligned":
      return <Tag color="green">current</Tag>;
    case "drifted":
      return <Tag color="orange">drifted</Tag>;
    case "mixed":
      return <Tag color="orange">mixed</Tag>;
    case "missing":
      return <Tag color="red">missing</Tag>;
    case "unsupported":
      return <Tag>unsupported</Tag>;
    case "unobserved":
      return <Tag>unobserved</Tag>;
    default:
      return <Tag>unknown</Tag>;
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

function formatBytes(value?: number): string | undefined {
  if (!Number.isFinite(value) || !value || value <= 0) return undefined;
  return humanSize(value, { binary: true });
}

function deploymentRecord(
  status: HostRuntimeDeploymentStatus | undefined,
  component: ManagedComponentKind,
) {
  return status?.effective.find(
    (record) =>
      record.target_type === "component" && record.target === component,
  );
}

function observedTarget(
  status: HostRuntimeDeploymentStatus | undefined,
  component: ManagedComponentKind,
) {
  return status?.observed_targets?.find(
    (record) =>
      record.target_type === "component" && record.target === component,
  );
}

function observedComponent(
  host: Host,
  status: HostRuntimeDeploymentStatus | undefined,
  component: ManagedComponentKind,
): HostManagedComponentStatus | undefined {
  return (
    status?.observed_components?.find(
      (entry) => entry.component === component,
    ) ??
    host.observed_components?.find((entry) => entry.component === component)
  );
}

function rollbackTarget(
  status: HostRuntimeDeploymentStatus | undefined,
  component: ManagedComponentKind,
): HostRuntimeRollbackTarget | undefined {
  return status?.rollback_targets?.find(
    (record) =>
      record.target_type === "component" && record.target === component,
  );
}

function rollbackOptions(
  target: HostRuntimeRollbackTarget | undefined,
): string[] {
  return Array.from(
    new Set(
      [
        target?.last_known_good_version,
        target?.previous_version,
        ...(target?.retained_versions ?? []),
      ]
        .map((value) => `${value ?? ""}`.trim())
        .filter(Boolean),
    ),
  );
}

function cliCommands(host: Host, component: ManagedComponentKind): string[] {
  return [
    `cocalc host deploy status ${host.id}`,
    `cocalc host deploy set --host ${host.id} --component ${component} --desired-version <version>`,
    `cocalc host deploy rollback ${host.id} --component ${component} --last-known-good`,
    `cocalc host deploy rollback ${host.id} --component ${component} --to-version <version>`,
    `cocalc host deploy restart ${host.id} --component ${component} --wait`,
  ];
}

function CliButton({
  host,
  component,
}: {
  host: Host;
  component: ManagedComponentKind;
}) {
  return (
    <Popover
      trigger="click"
      title="Daemon CLI"
      content={
        <div style={{ maxWidth: 560 }}>
          {cliCommands(host, component).map((command) => (
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

function MoreActions({ children }: { children: React.ReactNode }) {
  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      content={
        <Space direction="vertical" size={6} style={{ minWidth: 240 }}>
          {children}
        </Space>
      }
    >
      <Button size="small" icon={<MoreOutlined />}>
        More
      </Button>
    </Popover>
  );
}

export function HostDaemonRuntimeControl({
  host,
  deploymentStatus,
  softwareVersions,
  runtimeDeployments,
  runtimeLogViewer,
  canUpgrade,
  hostOpActive,
  canReconcile,
  canRefreshCloudStatus,
  onRefresh,
  onReconcile,
  onRefreshCloudStatus,
  onUpgradeAll,
  onUpgradeAllFromHub,
  onSetRuntimeComponentDeployment,
  onRollbackRuntimeComponent,
  onRestartRuntimeComponent,
  onResumeRuntimeComponentClusterDefault,
  compact = false,
}: Props) {
  const [expanded, setExpanded] = React.useState<
    Partial<Record<ManagedComponentKind, boolean>>
  >({});
  const [selectedRollback, setSelectedRollback] = React.useState<
    Partial<Record<ManagedComponentKind, string>>
  >({});
  const metadataIndex = React.useMemo(
    () =>
      buildRuntimeVersionMetadataIndex({
        configuredCatalog: softwareVersions?.configuredCatalog,
        hubCatalog: softwareVersions?.hubCatalog,
      }),
    [softwareVersions?.configuredCatalog, softwareVersions?.hubCatalog],
  );
  const configuredLatest = softwareVersions?.configured?.["project-host"];
  const hubLatest = softwareVersions?.hub?.["project-host"];
  const disabled = !!hostOpActive || host.status !== "running";
  const canControl = !!canUpgrade && !host.deleted;

  return (
    <Space direction="vertical" size="small" style={{ width: "100%" }}>
      <Space
        wrap
        align="center"
        style={{ justifyContent: "space-between", width: "100%" }}
      >
        <Space wrap align="center">
          <Typography.Text strong>Daemon runtime control</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Current daemon versions, desired versions, and safe runtime actions.
          </Typography.Text>
        </Space>
        <Space wrap>
          {onRefresh && (
            <Button
              size="small"
              type="text"
              icon={
                <SyncOutlined
                  spin={
                    !!softwareVersions?.loading ||
                    !!runtimeDeployments?.loading ||
                    !!runtimeDeployments?.refreshing
                  }
                />
              }
              onClick={onRefresh}
            >
              Refresh
            </Button>
          )}
        </Space>
      </Space>
      {runtimeDeployments?.error && (
        <Alert
          type="warning"
          showIcon
          message="Runtime deployment status unavailable"
          description={runtimeDeployments.error}
        />
      )}
      {deploymentStatus?.observation_error && (
        <Alert
          type="warning"
          showIcon
          message="Host observation warning"
          description={deploymentStatus.observation_error}
        />
      )}
      {softwareVersions?.configuredError && (
        <Alert
          type="warning"
          showIcon
          message="Configured source lookup failed"
          description={softwareVersions.configuredError}
        />
      )}
      {softwareVersions?.hubError && (
        <Alert
          type="warning"
          showIcon
          message="Hub source lookup failed"
          description={softwareVersions.hubError}
        />
      )}
      {DAEMON_COMPONENTS.map(({ component, shortLabel, label, disruptive }) => {
        const deployment = deploymentRecord(deploymentStatus, component);
        const target = observedTarget(deploymentStatus, component);
        const observed = observedComponent(host, deploymentStatus, component);
        const rollback = rollbackTarget(deploymentStatus, component);
        const versions = rollbackOptions(rollback);
        const preferredRollback =
          rollback?.last_known_good_version ??
          rollback?.previous_version ??
          versions[0];
        const rollbackVersion =
          selectedRollback[component] ?? preferredRollback;
        const runningVersions =
          target?.running_versions ?? observed?.running_versions ?? [];
        const runningPids =
          target?.running_pids ?? observed?.running_pids ?? [];
        const runtimeState =
          target?.observed_runtime_state ?? observed?.runtime_state;
        const versionState =
          target?.observed_version_state ?? observed?.version_state;
        const desiredVersion =
          deployment?.desired_version ??
          target?.desired_version ??
          observed?.desired_version;
        const currentVersion =
          runningVersions[0] ??
          target?.current_version ??
          (component === "project-host" ? host.version : undefined);
        const hasHostOverride = deployment?.scope_type === "host";
        const managed = target?.managed ?? observed?.managed;
        const externallyManaged =
          managed === false && !runningVersions.length && !runningPids.length;
        const rowExpanded = !!expanded[component];
        const canAct =
          canControl && !externallyManaged && !!onSetRuntimeComponentDeployment;
        const deployHubButton =
          canAct && hubLatest?.version ? (
            <Popconfirm
              title={`Deploy latest hub build for ${label.toLowerCase()}?`}
              description={
                disruptive
                  ? "This daemon can be disruptive. Prefer changing it during a maintenance window."
                  : "This updates the project-host daemon without changing the rest of the runtime stack."
              }
              okText="Deploy"
              cancelText="Cancel"
              onConfirm={() =>
                onSetRuntimeComponentDeployment?.({
                  host,
                  component,
                  desired_version: hubLatest.version!,
                  source: "hub",
                })
              }
              disabled={disabled}
            >
              <Button
                size="small"
                type={component === "project-host" ? "primary" : "default"}
                disabled={disabled}
              >
                Deploy hub latest
              </Button>
            </Popconfirm>
          ) : null;
        const deployConfiguredButton =
          canAct && configuredLatest?.version ? (
            <Popconfirm
              title={`Deploy configured latest for ${label.toLowerCase()}?`}
              description={
                disruptive
                  ? "This daemon can be disruptive. Prefer changing it during a maintenance window."
                  : "This updates the project-host daemon from the configured software source."
              }
              okText="Deploy"
              cancelText="Cancel"
              onConfirm={() =>
                onSetRuntimeComponentDeployment?.({
                  host,
                  component,
                  desired_version: configuredLatest.version!,
                  source: "configured",
                })
              }
              disabled={disabled}
            >
              <Button size="small" disabled={disabled}>
                Deploy latest
              </Button>
            </Popconfirm>
          ) : null;
        return (
          <Card
            key={component}
            size="small"
            styles={{ body: { padding: compact ? 10 : 12 } }}
          >
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              <Space
                wrap
                align="center"
                style={{ justifyContent: "space-between", width: "100%" }}
              >
                <Space wrap align="center">
                  <Typography.Text strong>{shortLabel}</Typography.Text>
                  <Typography.Text type="secondary">{label}</Typography.Text>
                  {runtimeStateTag(runtimeState)}
                  {versionStateTag(versionState)}
                  {hasHostOverride && <Tag color="blue">host override</Tag>}
                  {disruptive && <Tag color="orange">disruptive</Tag>}
                  {externallyManaged && <Tag>external</Tag>}
                </Space>
                <Space wrap>
                  {component === "project-host" &&
                    (deployHubButton ?? deployConfiguredButton)}
                  <MoreActions>
                    {component !== "project-host" && deployHubButton}
                    {component !== "project-host" && deployConfiguredButton}
                    {canControl &&
                      hasHostOverride &&
                      onResumeRuntimeComponentClusterDefault && (
                        <Popconfirm
                          title={`Resume cluster default for ${label.toLowerCase()}?`}
                          description="This removes the host-specific desired version so the daemon inherits the cluster default again."
                          okText="Resume default"
                          cancelText="Cancel"
                          onConfirm={() =>
                            onResumeRuntimeComponentClusterDefault({
                              host,
                              component,
                            })
                          }
                          disabled={!!hostOpActive}
                        >
                          <Button size="small" block disabled={!!hostOpActive}>
                            Resume cluster default
                          </Button>
                        </Popconfirm>
                      )}
                    {canControl &&
                      !externallyManaged &&
                      onRollbackRuntimeComponent &&
                      preferredRollback && (
                        <Popconfirm
                          title={`Rollback ${label.toLowerCase()}?`}
                          description={`Switch this daemon to ${preferredRollback}.`}
                          okText="Rollback"
                          cancelText="Cancel"
                          onConfirm={() =>
                            onRollbackRuntimeComponent({
                              host,
                              component,
                              ...(rollback?.last_known_good_version
                                ? { last_known_good: true }
                                : { version: preferredRollback }),
                            })
                          }
                          disabled={!!hostOpActive}
                        >
                          <Button size="small" block disabled={!!hostOpActive}>
                            Rollback
                          </Button>
                        </Popconfirm>
                      )}
                    {canControl &&
                      !externallyManaged &&
                      onRestartRuntimeComponent && (
                        <Popconfirm
                          title={`Restart ${label.toLowerCase()}?`}
                          description="Restart is a last-resort operational action. It does not change desired version."
                          okText="Restart"
                          cancelText="Cancel"
                          onConfirm={() =>
                            onRestartRuntimeComponent({ host, component })
                          }
                          disabled={disabled}
                        >
                          <Button size="small" danger block disabled={disabled}>
                            Restart
                          </Button>
                        </Popconfirm>
                      )}
                    {runtimeLogViewer && (
                      <Button
                        size="small"
                        block
                        onClick={() =>
                          void runtimeLogViewer.load({
                            source: component,
                            lines: 200,
                          })
                        }
                      >
                        Load recent log
                      </Button>
                    )}
                    <CliButton host={host} component={component} />
                  </MoreActions>
                  <Button
                    size="small"
                    type="link"
                    onClick={() =>
                      setExpanded((prev) => ({
                        ...prev,
                        [component]: !prev[component],
                      }))
                    }
                  >
                    Details <DownOutlined />
                  </Button>
                </Space>
              </Space>
              <div
                style={{
                  display: "grid",
                  gap: 8,
                  gridTemplateColumns: compact
                    ? "1fr"
                    : "repeat(auto-fit, minmax(170px, 1fr))",
                }}
              >
                <Typography.Text type="secondary">
                  running{" "}
                  {shortVersion({ version: currentVersion, metadataIndex })}
                </Typography.Text>
                <Typography.Text type="secondary">
                  desired{" "}
                  {shortVersion({ version: desiredVersion, metadataIndex })}
                </Typography.Text>
                <Typography.Text type="secondary">
                  hub latest{" "}
                  {shortVersion({
                    version: hubLatest?.version,
                    metadataIndex,
                  })}
                </Typography.Text>
              </div>
              {rowExpanded && (
                <>
                  <Divider style={{ margin: "2px 0" }} />
                  <Space
                    direction="vertical"
                    size={6}
                    style={{ width: "100%" }}
                  >
                    <Typography.Text type="secondary">
                      upgrade policy{" "}
                      <code>
                        {formatUpgradePolicy(
                          deployment?.rollout_policy ??
                            observed?.upgrade_policy,
                        )}
                      </code>{" "}
                      · enabled{" "}
                      <code>
                        {(target?.enabled ?? observed?.enabled) ? "yes" : "no"}
                      </code>{" "}
                      · managed <code>{managed === false ? "no" : "yes"}</code>
                    </Typography.Text>
                    {!!runningVersions.length && (
                      <Typography.Text type="secondary">
                        running versions{" "}
                        <code>{runningVersions.join(", ")}</code>
                      </Typography.Text>
                    )}
                    {!!runningPids.length && (
                      <Typography.Text type="secondary">
                        running pids <code>{runningPids.join(", ")}</code>
                      </Typography.Text>
                    )}
                    {rollback && (
                      <Typography.Text type="secondary">
                        retention keep{" "}
                        <code>
                          {rollback.retention_policy?.keep_count ?? "unknown"}
                        </code>
                        {formatBytes(rollback.retention_policy?.max_bytes)
                          ? ` · budget ${formatBytes(
                              rollback.retention_policy?.max_bytes,
                            )}`
                          : ""}
                      </Typography.Text>
                    )}
                    {canControl &&
                      !externallyManaged &&
                      onRollbackRuntimeComponent &&
                      versions.length > 0 && (
                        <Space wrap align="center">
                          <Typography.Text>Rollback version</Typography.Text>
                          <Select
                            size="small"
                            style={{ minWidth: 260 }}
                            value={rollbackVersion}
                            onChange={(value) =>
                              setSelectedRollback((prev) => ({
                                ...prev,
                                [component]: value,
                              }))
                            }
                            options={versions.map((version) => ({
                              value: version,
                              label: version,
                            }))}
                            disabled={!!hostOpActive}
                          />
                          <Popconfirm
                            title={`Rollback ${label.toLowerCase()} to ${rollbackVersion}?`}
                            okText="Rollback"
                            cancelText="Cancel"
                            onConfirm={() =>
                              rollbackVersion
                                ? onRollbackRuntimeComponent({
                                    host,
                                    component,
                                    version: rollbackVersion,
                                  })
                                : undefined
                            }
                            disabled={!!hostOpActive || !rollbackVersion}
                          >
                            <Button
                              size="small"
                              disabled={!!hostOpActive || !rollbackVersion}
                            >
                              Apply
                            </Button>
                          </Popconfirm>
                        </Space>
                      )}
                    {externallyManaged && (
                      <Alert
                        type="info"
                        showIcon
                        message="Externally managed"
                        description="This component is not running as a local managed daemon on this host."
                      />
                    )}
                    {versionState === "missing" && (
                      <Alert
                        type="warning"
                        showIcon
                        message="Desired daemon version is not installed"
                        description="Setting a desired version queues reconcile work. Refresh to watch the rollout state."
                      />
                    )}
                  </Space>
                </>
              )}
            </Space>
          </Card>
        );
      })}
      {(canReconcile ||
        canRefreshCloudStatus ||
        onUpgradeAll ||
        onUpgradeAllFromHub) && (
        <Space wrap>
          {canReconcile && onReconcile && (
            <Popconfirm
              title="Run bootstrap/software reconcile on this host?"
              okText="Reconcile"
              cancelText="Cancel"
              onConfirm={() => onReconcile(host)}
              disabled={!!hostOpActive}
            >
              <Button size="small" disabled={!!hostOpActive}>
                Reconcile
              </Button>
            </Popconfirm>
          )}
          {canRefreshCloudStatus && onRefreshCloudStatus && (
            <Popconfirm
              title="Refresh cloud/provider status for this host?"
              description="This forces an immediate cloud reconcile and updates the host row if reality drifted."
              okText="Refresh"
              cancelText="Cancel"
              onConfirm={() => onRefreshCloudStatus(host)}
              disabled={!!hostOpActive}
            >
              <Button size="small" disabled={!!hostOpActive}>
                Refresh Cloud Status
              </Button>
            </Popconfirm>
          )}
          {canControl && onUpgradeAll && (
            <Popconfirm
              title="Upgrade all runtime components?"
              description="This updates the whole managed runtime stack and can disrupt Conat or ACP. Prefer project-host-only deploys during development."
              okText="Upgrade all"
              cancelText="Cancel"
              onConfirm={() => onUpgradeAll(host)}
              disabled={disabled}
            >
              <Button size="small" disabled={disabled}>
                Upgrade all
              </Button>
            </Popconfirm>
          )}
          {canControl && onUpgradeAllFromHub && (
            <Popconfirm
              title="Upgrade all runtime components from hub?"
              description="This updates the whole managed runtime stack from the hub source and can disrupt Conat or ACP."
              okText="Upgrade all"
              cancelText="Cancel"
              onConfirm={() => onUpgradeAllFromHub(host)}
              disabled={disabled}
            >
              <Button size="small" disabled={disabled}>
                Upgrade all from hub
              </Button>
            </Popconfirm>
          )}
        </Space>
      )}
    </Space>
  );
}
