import {
  Alert,
  Button,
  Card,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { SyncOutlined } from "@ant-design/icons";
import { React } from "@cocalc/frontend/app-framework";
import { TimeAgo } from "@cocalc/frontend/components";
import type {
  Host,
  HostRuntimeArtifact,
  HostRuntimeDeploymentRecord,
  HostSoftwareArtifact,
  HostSoftwareAvailableVersion,
} from "@cocalc/conat/hub/api/hosts";
import { human_readable_size } from "@cocalc/util/misc";
import type { ColumnsType } from "antd/es/table";

type HostRuntimeVersionsPanelProps = {
  hosts: Host[];
  loading?: boolean;
  configured: HostSoftwareAvailableVersion[];
  configuredError?: string;
  hub: HostSoftwareAvailableVersion[];
  hubError?: string;
  globalDeployments: HostRuntimeDeploymentRecord[];
  globalDeploymentsError?: string;
  hubSourceLabel?: string;
  onRefresh: () => void | Promise<void>;
  onSetClusterDefault?: (opts: {
    artifact: HostSoftwareArtifact;
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

type VersionRow = HostSoftwareAvailableVersion & {
  key: string;
  source: "configured" | "hub";
  running_hosts: number;
};

type ClusterDefaultCandidate = VersionRow;

const CLUSTER_DEFAULT_ARTIFACTS: HostSoftwareArtifact[] = [
  "project-host",
  "project",
  "tools",
];

function clusterDefaultArtifact(
  artifact: HostSoftwareArtifact,
): HostSoftwareArtifact {
  return artifact === "project-bundle" ? "project" : artifact;
}

function artifactLabel(artifact: HostSoftwareArtifact): string {
  switch (artifact) {
    case "project-host":
      return "Project host bundle";
    case "project":
      return "Project bundle";
    case "tools":
      return "Tools";
    case "project-bundle":
      return "Project bundle";
    default:
      return artifact;
  }
}

function toRuntimeArtifact(
  artifact: HostSoftwareArtifact,
): HostRuntimeArtifact {
  switch (artifact) {
    case "project":
    case "project-bundle":
      return "project-bundle";
    case "project-host":
      return "project-host";
    case "tools":
      return "tools";
    default:
      return "project-bundle";
  }
}

function runningVersionForArtifact(
  host: Host,
  artifact: HostSoftwareArtifact,
): string | undefined {
  switch (artifact) {
    case "project-host":
      return host.version;
    case "project":
    case "project-bundle":
      return host.project_bundle_version;
    case "tools":
      return host.tools_version;
    default:
      return undefined;
  }
}

function buildRunningCounts(hosts: Host[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const host of hosts) {
    if (host.deleted || host.status !== "running") continue;
    for (const artifact of ["project-host", "project", "tools"] as const) {
      const version = runningVersionForArtifact(host, artifact);
      if (!version) continue;
      const key = `${artifact}:${version}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function buildRows({
  hosts,
  configured,
  hub,
}: Pick<
  HostRuntimeVersionsPanelProps,
  "hosts" | "configured" | "hub"
>): VersionRow[] {
  const runningCounts = buildRunningCounts(hosts);
  const toRows = (
    source: VersionRow["source"],
    versions: HostSoftwareAvailableVersion[],
  ): VersionRow[] =>
    versions.map((row) => ({
      ...row,
      key: `${source}:${row.artifact}:${row.channel}:${row.version ?? "missing"}`,
      source,
      running_hosts: row.version
        ? (runningCounts.get(
            `${clusterDefaultArtifact(row.artifact)}:${row.version}`,
          ) ?? 0)
        : 0,
    }));
  return [...toRows("configured", configured), ...toRows("hub", hub)].sort(
    (a, b) => {
      const artifactCmp = artifactLabel(a.artifact).localeCompare(
        artifactLabel(b.artifact),
      );
      if (artifactCmp !== 0) return artifactCmp;
      const sourceCmp = a.source.localeCompare(b.source);
      if (sourceCmp !== 0) return sourceCmp;
      const aTs = a.built_at ? Date.parse(a.built_at) : 0;
      const bTs = b.built_at ? Date.parse(b.built_at) : 0;
      if (aTs !== bTs) return bTs - aTs;
      return (b.version ?? "").localeCompare(a.version ?? "");
    },
  );
}

function buildGlobalDefaultMap(
  deployments: HostRuntimeDeploymentRecord[],
): Map<HostRuntimeArtifact, HostRuntimeDeploymentRecord> {
  const map = new Map<HostRuntimeArtifact, HostRuntimeDeploymentRecord>();
  for (const deployment of deployments) {
    if (deployment.target_type !== "artifact") continue;
    const target = deployment.target as HostRuntimeArtifact;
    if (
      target !== "project-host" &&
      target !== "project-bundle" &&
      target !== "tools"
    ) {
      continue;
    }
    map.set(target, deployment);
  }
  return map;
}

function sourceLabel(source: VersionRow["source"]): string {
  return source === "configured" ? "Configured catalog" : "Hub /software";
}

function compareVersionRows(a: VersionRow, b: VersionRow): number {
  const aTs = a.built_at ? Date.parse(a.built_at) : 0;
  const bTs = b.built_at ? Date.parse(b.built_at) : 0;
  if (aTs !== bTs) return bTs - aTs;
  return (b.version ?? "").localeCompare(a.version ?? "");
}

function buildClusterDefaultCandidates(
  rows: VersionRow[],
): Map<HostSoftwareArtifact, ClusterDefaultCandidate[]> {
  const deduped = new Map<
    HostSoftwareArtifact,
    Map<string, ClusterDefaultCandidate>
  >();
  for (const row of rows) {
    if (!row.version) continue;
    const artifact = clusterDefaultArtifact(row.artifact);
    let artifactRows = deduped.get(artifact);
    if (!artifactRows) {
      artifactRows = new Map();
      deduped.set(artifact, artifactRows);
    }
    const existing = artifactRows.get(row.version);
    if (
      !existing ||
      (existing.source === "hub" && row.source === "configured")
    ) {
      artifactRows.set(row.version, row);
    }
  }
  return new Map(
    Array.from(deduped.entries()).map(([artifact, versions]) => [
      artifact,
      Array.from(versions.values()).sort(compareVersionRows),
    ]),
  );
}

function defaultSelectionForArtifact({
  artifact,
  candidates,
  globalDefaultMap,
}: {
  artifact: HostSoftwareArtifact;
  candidates: Map<HostSoftwareArtifact, ClusterDefaultCandidate[]>;
  globalDefaultMap: Map<HostRuntimeArtifact, HostRuntimeDeploymentRecord>;
}): string | undefined {
  const rows = candidates.get(artifact) ?? [];
  if (!rows.length) return undefined;
  const current = globalDefaultMap.get(toRuntimeArtifact(artifact));
  const currentMatch = rows.find(
    (row) => row.version === current?.desired_version,
  );
  if (current?.desired_version) {
    return (
      currentMatch?.key ??
      `current:${toRuntimeArtifact(artifact)}:${current.desired_version}`
    );
  }
  return rows[0].key;
}

export const HostRuntimeVersionsPanel: React.FC<
  HostRuntimeVersionsPanelProps
> = ({
  hosts,
  loading,
  configured,
  configuredError,
  hub,
  hubError,
  globalDeployments,
  globalDeploymentsError,
  hubSourceLabel,
  onRefresh,
  onSetClusterDefault,
  settingClusterDefaultKey,
  onAlignProjectHostFleetVersion,
  aligningProjectHostFleetKey,
}) => {
  const rows = React.useMemo(
    () => buildRows({ hosts, configured, hub }),
    [configured, hosts, hub],
  );
  const globalDefaultMap = React.useMemo(
    () => buildGlobalDefaultMap(globalDeployments),
    [globalDeployments],
  );
  const clusterDefaultCandidates = React.useMemo(
    () => buildClusterDefaultCandidates(rows),
    [rows],
  );
  const [selectedClusterDefaultKeys, setSelectedClusterDefaultKeys] =
    React.useState<Partial<Record<HostSoftwareArtifact, string>>>({});

  React.useEffect(() => {
    setSelectedClusterDefaultKeys((current) => {
      let changed = false;
      const next: Partial<Record<HostSoftwareArtifact, string>> = {
        ...current,
      };
      for (const artifact of CLUSTER_DEFAULT_ARTIFACTS) {
        const rows = clusterDefaultCandidates.get(artifact) ?? [];
        const existing = current[artifact];
        if (existing && rows.some((row) => row.key === existing)) {
          continue;
        }
        const fallback = defaultSelectionForArtifact({
          artifact,
          candidates: clusterDefaultCandidates,
          globalDefaultMap,
        });
        if (next[artifact] !== fallback) {
          next[artifact] = fallback;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [clusterDefaultCandidates, globalDefaultMap]);

  const columns: ColumnsType<VersionRow> = React.useMemo(
    () => [
      {
        title: "Artifact",
        dataIndex: "artifact",
        key: "artifact",
        width: 140,
        render: (artifact: HostSoftwareArtifact) => artifactLabel(artifact),
      },
      {
        title: "Source",
        dataIndex: "source",
        key: "source",
        width: 120,
        render: (source: VersionRow["source"]) =>
          source === "configured" ? (
            <Tag color="blue">Configured</Tag>
          ) : (
            <Tag>Hub /software</Tag>
          ),
      },
      {
        title: "Version",
        dataIndex: "version",
        key: "version",
        width: 160,
        render: (version?: string) => (
          <Typography.Text code>{version ?? "missing"}</Typography.Text>
        ),
      },
      {
        title: "Running Hosts",
        dataIndex: "running_hosts",
        key: "running_hosts",
        width: 120,
        align: "right",
      },
      {
        title: "Built",
        dataIndex: "built_at",
        key: "built_at",
        width: 160,
        render: (builtAt?: string) =>
          builtAt ? (
            <TimeAgo date={builtAt} />
          ) : (
            <Typography.Text type="secondary">n/a</Typography.Text>
          ),
      },
      {
        title: "Size",
        dataIndex: "size_bytes",
        key: "size_bytes",
        width: 110,
        align: "right",
        render: (sizeBytes?: number) =>
          sizeBytes ? human_readable_size(sizeBytes) : "",
      },
      {
        title: "Message",
        dataIndex: "message",
        key: "message",
        ellipsis: true,
        render: (message?: string) =>
          message ? (
            <Typography.Text>{message}</Typography.Text>
          ) : (
            <Typography.Text type="secondary">No message</Typography.Text>
          ),
      },
      {
        title: "Cluster Default",
        key: "cluster_default",
        width: 220,
        render: (_value, row) => {
          const runtimeArtifact = toRuntimeArtifact(row.artifact);
          const current = globalDefaultMap.get(runtimeArtifact);
          const isCurrentDefault =
            current?.desired_version != null &&
            current.desired_version === row.version;
          const actionKey = `${runtimeArtifact}:${row.version}`;
          if (isCurrentDefault) {
            return (
              <Space size={4} direction="vertical">
                <Tag color="green">Cluster default</Tag>
                <Typography.Text type="secondary">
                  since <TimeAgo date={current.updated_at} />
                </Typography.Text>
              </Space>
            );
          }
          if (!onSetClusterDefault || !row.version) {
            return <Typography.Text type="secondary">Not set</Typography.Text>;
          }
          return (
            <Popconfirm
              title={`Set ${artifactLabel(row.artifact)} cluster default?`}
              description={`Promote ${row.version} from ${sourceLabel(row.source)} and queue automatic reconcile on running hosts that follow the cluster default.`}
              okText="Set default"
              onConfirm={() =>
                onSetClusterDefault({
                  artifact: row.artifact,
                  desired_version: row.version!,
                  source: row.source,
                })
              }
            >
              <Button
                size="small"
                loading={settingClusterDefaultKey === actionKey}
              >
                Use this version
              </Button>
            </Popconfirm>
          );
        },
      },
      {
        title: "Fleet Rollout",
        key: "fleet_rollout",
        width: 250,
        render: (_value, row) => {
          if (row.artifact !== "project-host") {
            return (
              <Typography.Text type="secondary">
                Project-host only
              </Typography.Text>
            );
          }
          if (!row.version) {
            return (
              <Typography.Text type="secondary">No version</Typography.Text>
            );
          }
          if (!onAlignProjectHostFleetVersion) {
            return (
              <Typography.Text type="secondary">
                Unavailable here
              </Typography.Text>
            );
          }
          const actionKey = `project-host:${row.version}`;
          const sourceLabel =
            row.source === "configured"
              ? "configured catalog"
              : "hub /software";
          return (
            <Popconfirm
              title="Align all running hosts to this project-host build?"
              description={
                <Space direction="vertical" size={4}>
                  <Typography.Text>
                    This is the disruptive full-stack action. It queues:
                  </Typography.Text>
                  <Typography.Text code>
                    cocalc host upgrade --artifact project-host
                    --artifact-version {row.version} --all-online --wait
                    --align-runtime-stack
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    Running hosts will move project-host, conat-router,
                    conat-persist, and acp-worker to {row.version} from{" "}
                    {sourceLabel}.
                  </Typography.Text>
                </Space>
              }
              okText="Align fleet"
              onConfirm={() =>
                onAlignProjectHostFleetVersion({
                  desired_version: row.version!,
                  source: row.source,
                })
              }
            >
              <Button
                size="small"
                danger
                loading={aligningProjectHostFleetKey === actionKey}
              >
                Align fleet stack
              </Button>
            </Popconfirm>
          );
        },
      },
    ],
    [
      aligningProjectHostFleetKey,
      globalDefaultMap,
      hubSourceLabel,
      onAlignProjectHostFleetVersion,
      onSetClusterDefault,
      settingClusterDefaultKey,
    ],
  );

  return (
    <Card
      size="small"
      style={{ marginBottom: 12 }}
      title="Runtime Versions"
      extra={
        <Button size="small" icon={<SyncOutlined />} onClick={onRefresh}>
          Refresh
        </Button>
      }
    >
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        {configuredError ? (
          <Alert
            type="error"
            showIcon
            message="Unable to load configured runtime versions"
            description={configuredError}
          />
        ) : null}
        {hubError ? (
          <Alert
            type="warning"
            showIcon
            message="Unable to load hub runtime versions"
            description={hubError}
          />
        ) : null}
        {globalDeploymentsError ? (
          <Alert
            type="warning"
            showIcon
            message="Unable to load cluster runtime defaults"
            description={globalDeploymentsError}
          />
        ) : null}
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          {CLUSTER_DEFAULT_ARTIFACTS.map((artifact) => {
            const candidates = clusterDefaultCandidates.get(artifact) ?? [];
            const currentDefault = globalDefaultMap.get(
              toRuntimeArtifact(artifact),
            );
            const selectedKey = selectedClusterDefaultKeys[artifact];
            const selectedVersion = candidates.find(
              (row) => row.key === selectedKey,
            );
            const currentFallbackKey = currentDefault?.desired_version
              ? `current:${toRuntimeArtifact(artifact)}:${currentDefault.desired_version}`
              : undefined;
            const selectedActionKey = selectedVersion?.version
              ? `${toRuntimeArtifact(artifact)}:${selectedVersion.version}`
              : undefined;
            const selectedIsCurrent =
              (!!selectedVersion?.version &&
                selectedVersion.version === currentDefault?.desired_version) ||
              (!!currentFallbackKey && selectedKey === currentFallbackKey);
            const label = artifactLabel(artifact);
            const options =
              currentFallbackKey &&
              currentDefault?.desired_version &&
              !candidates.some(
                (row) => row.version === currentDefault.desired_version,
              )
                ? [
                    {
                      value: currentFallbackKey,
                      label: `${currentDefault.desired_version} (current, not in catalog)`,
                    },
                    ...candidates.map((row) => ({
                      value: row.key,
                      label: row.version,
                    })),
                  ]
                : candidates.map((row) => ({
                    value: row.key,
                    label: row.version,
                  }));
            return (
              <div
                key={artifact}
                style={{
                  alignItems: "center",
                  display: "grid",
                  gap: 12,
                  gridTemplateColumns: "180px minmax(320px, 1fr) auto",
                }}
              >
                <Typography.Text strong>{label}</Typography.Text>
                <Select
                  placeholder={`Select a ${label.toLowerCase()} version`}
                  value={selectedKey}
                  onChange={(value) =>
                    setSelectedClusterDefaultKeys((current) => ({
                      ...current,
                      [artifact]: value,
                    }))
                  }
                  options={options}
                />
                <Popconfirm
                  title="Switch new and existing hosts that follow the default to this version?"
                  okText="Change version"
                  disabled={
                    !selectedVersion?.version ||
                    !onSetClusterDefault ||
                    selectedIsCurrent
                  }
                  onConfirm={() => {
                    if (!selectedVersion?.version || !onSetClusterDefault) {
                      return;
                    }
                    return onSetClusterDefault({
                      artifact,
                      desired_version: selectedVersion.version,
                      source: selectedVersion.source,
                    });
                  }}
                >
                  <Button
                    disabled={
                      !selectedVersion?.version ||
                      !onSetClusterDefault ||
                      selectedIsCurrent
                    }
                    loading={
                      !!selectedActionKey &&
                      settingClusterDefaultKey === selectedActionKey
                    }
                  >
                    Change version
                  </Button>
                </Popconfirm>
              </div>
            );
          })}
        </Space>
        <details>
          <summary>
            <Typography.Text type="secondary">
              Advanced: raw catalog rows and fleet rollout controls
            </Typography.Text>
          </summary>
          <div style={{ marginTop: 12 }}>
            {hubSourceLabel ? (
              <Typography.Paragraph type="secondary">
                Hub source: {hubSourceLabel}
              </Typography.Paragraph>
            ) : null}
            <Table<VersionRow>
              size="small"
              rowKey="key"
              columns={columns}
              dataSource={rows}
              loading={loading}
              pagination={false}
              locale={{
                emptyText: loading
                  ? "Loading runtime versions..."
                  : "No published runtime versions found.",
              }}
              scroll={{ x: 1360 }}
            />
          </div>
        </details>
      </Space>
    </Card>
  );
};
