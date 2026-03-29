import { Space, Tag, Typography } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import type { Host } from "@cocalc/conat/hub/api/hosts";
import { human_readable_size } from "@cocalc/util/misc";

type HostCurrentMetricsProps = {
  host: Host;
  compact?: boolean;
};

function formatPercent(value?: number): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return `${Math.round(value)}%`;
}

function formatBytes(value?: number): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return human_readable_size(value);
}

function metricTagColor(percent?: number): string | undefined {
  if (percent == null || !Number.isFinite(percent)) return undefined;
  if (percent >= 90) return "red";
  if (percent >= 75) return "orange";
  return undefined;
}

function diskTagColor(host: Host): string | undefined {
  const metrics = host.metrics?.current;
  if (!metrics) return undefined;
  const available = metrics.disk_available_conservative_bytes;
  const total = metrics.disk_device_total_bytes;
  if (
    available == null ||
    total == null ||
    !Number.isFinite(available) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return undefined;
  }
  const ratio = available / total;
  if (ratio <= 0.1) return "red";
  if (ratio <= 0.2) return "orange";
  return undefined;
}

function formatMetadataPercent(host: Host): string | undefined {
  const metrics = host.metrics?.current;
  if (!metrics) return undefined;
  const used = metrics.btrfs_metadata_used_bytes;
  const total = metrics.btrfs_metadata_total_bytes;
  if (
    used == null ||
    total == null ||
    !Number.isFinite(used) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return undefined;
  }
  return `${Math.round((used / total) * 100)}%`;
}

export const HostCurrentMetrics: React.FC<HostCurrentMetricsProps> = ({
  host,
  compact,
}) => {
  const metrics = host.metrics?.current;
  if (!metrics) {
    return compact ? (
      <Typography.Text type="secondary">metrics pending</Typography.Text>
    ) : (
      <Typography.Text type="secondary">
        Current host metrics have not arrived yet.
      </Typography.Text>
    );
  }

  const cpuPercent = formatPercent(metrics.cpu_percent);
  const memoryPercent = formatPercent(metrics.memory_used_percent);
  const diskFree = formatBytes(metrics.disk_available_conservative_bytes);
  const memoryUsed = formatBytes(metrics.memory_used_bytes);
  const memoryTotal = formatBytes(metrics.memory_total_bytes);
  const diskTotal = formatBytes(metrics.disk_device_total_bytes);
  const metadataUsed = formatBytes(metrics.btrfs_metadata_used_bytes);
  const metadataTotal = formatBytes(metrics.btrfs_metadata_total_bytes);
  const metadataPercent = formatMetadataPercent(host);
  const load =
    metrics.load_1 != null || metrics.load_5 != null || metrics.load_15 != null
      ? [metrics.load_1, metrics.load_5, metrics.load_15]
          .map((value) =>
            value == null || !Number.isFinite(value) ? "?" : value.toFixed(2),
          )
          .join(" / ")
      : undefined;

  if (compact) {
    return (
      <Space wrap size={[4, 4]}>
        {cpuPercent && (
          <Tag color={metricTagColor(metrics.cpu_percent)}>
            CPU {cpuPercent}
          </Tag>
        )}
        {memoryPercent && (
          <Tag color={metricTagColor(metrics.memory_used_percent)}>
            RAM {memoryPercent}
          </Tag>
        )}
        {diskFree && <Tag color={diskTagColor(host)}>Disk {diskFree} free</Tag>}
        {(metrics.running_project_count != null ||
          metrics.assigned_project_count != null) && (
          <Tag>
            Projects {metrics.running_project_count ?? 0}/
            {metrics.assigned_project_count ?? 0} running
          </Tag>
        )}
      </Space>
    );
  }

  return (
    <Space orientation="vertical" size={4}>
      <Typography.Text>
        CPU: {cpuPercent ?? "n/a"}
        {load ? `  |  load ${load}` : ""}
      </Typography.Text>
      <Typography.Text>
        Memory:{" "}
        {memoryUsed && memoryTotal
          ? `${memoryUsed} / ${memoryTotal} (${memoryPercent ?? "n/a"})`
          : "n/a"}
      </Typography.Text>
      <Typography.Text>
        Disk:{" "}
        {diskFree
          ? `${diskFree} conservative free${
              diskTotal ? ` / ${diskTotal} total` : ""
            }`
          : "n/a"}
      </Typography.Text>
      <Typography.Text>
        Metadata:{" "}
        {metadataUsed && metadataTotal
          ? `${metadataUsed} / ${metadataTotal} (${metadataPercent ?? "n/a"})`
          : "n/a"}
      </Typography.Text>
      <Typography.Text>
        Projects: {metrics.running_project_count ?? 0} running,{" "}
        {metrics.starting_project_count ?? 0} starting,{" "}
        {metrics.stopping_project_count ?? 0} stopping,{" "}
        {metrics.assigned_project_count ?? 0} assigned
      </Typography.Text>
      {metrics.collected_at && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Sampled {new Date(metrics.collected_at).toLocaleString()}
        </Typography.Text>
      )}
    </Space>
  );
};
