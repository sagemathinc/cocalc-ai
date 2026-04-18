import { Button, Popover, Space, Tag, Typography } from "antd";
import { CodeOutlined } from "@ant-design/icons";
import { Tooltip } from "@cocalc/frontend/components";
import type { Host } from "@cocalc/conat/hub/api/hosts";
import type {
  HostManagedComponentStatus,
  ManagedComponentKind,
} from "@cocalc/conat/project-host/api";

const DAEMON_COMPONENTS: Array<{
  component: ManagedComponentKind;
  shortLabel: string;
  label: string;
}> = [
  {
    component: "project-host",
    shortLabel: "host",
    label: "Project host",
  },
  {
    component: "conat-router",
    shortLabel: "router",
    label: "Conat router",
  },
  {
    component: "conat-persist",
    shortLabel: "persist",
    label: "Conat persist",
  },
  {
    component: "acp-worker",
    shortLabel: "acp",
    label: "ACP worker",
  },
];

function observedComponent(
  host: Host,
  component: ManagedComponentKind,
): HostManagedComponentStatus | undefined {
  return host.observed_components?.find(
    (entry) => entry.component === component,
  );
}

function daemonTagColor(status?: HostManagedComponentStatus): string {
  if (!status) return "default";
  if (status.runtime_state === "disabled") return "default";
  if (status.runtime_state !== "running") return "red";
  if (status.version_state === "aligned") return "green";
  if (status.version_state === "drifted" || status.version_state === "mixed") {
    return "orange";
  }
  return "blue";
}

function daemonTooltipText(
  label: string,
  status?: HostManagedComponentStatus,
): string {
  if (!status) {
    return `${label}: no host-reported daemon status yet`;
  }
  const desired = `${status.desired_version ?? ""}`.trim() || "n/a";
  const running = status.running_versions.length
    ? status.running_versions.join(", ")
    : "n/a";
  const pids = status.running_pids.length
    ? status.running_pids.join(", ")
    : "n/a";
  return `${label}: ${status.runtime_state}, ${status.version_state}, desired=${desired}, running=${running}, pids=${pids}`;
}

function cliCommands(host: Host): string[] {
  return [
    `cocalc host deploy status ${host.id}`,
    `cocalc host deploy status ${host.id} --component project-host --component conat-router --component conat-persist --component acp-worker`,
    `cocalc host logs ${host.id} --tail 200`,
  ];
}

export function HostDaemonHealthSummary({
  host,
  compact = false,
}: {
  host: Host;
  compact?: boolean;
}) {
  return (
    <Space wrap size={compact ? 4 : 6} align="center" style={{ width: "100%" }}>
      <Typography.Text type="secondary" style={{ fontSize: compact ? 12 : 13 }}>
        Daemons
      </Typography.Text>
      {DAEMON_COMPONENTS.map(({ component, shortLabel, label }) => {
        const status = observedComponent(host, component);
        const tagLabel = status
          ? `${shortLabel}:${status.runtime_state}`
          : `${shortLabel}:n/a`;
        return (
          <Tooltip key={component} title={daemonTooltipText(label, status)}>
            <Tag color={daemonTagColor(status)} style={{ marginInlineEnd: 0 }}>
              {tagLabel}
            </Tag>
          </Tooltip>
        );
      })}
      <Popover
        trigger="click"
        title="Daemon health CLI"
        content={
          <div style={{ maxWidth: 540 }}>
            <Typography.Paragraph style={{ marginBottom: 8 }}>
              Use the deploy status command to inspect the same daemon/runtime
              state from the CLI.
            </Typography.Paragraph>
            {cliCommands(host).map((command) => (
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
          style={{ paddingInline: compact ? 4 : 8 }}
        >
          CLI
        </Button>
      </Popover>
    </Space>
  );
}
