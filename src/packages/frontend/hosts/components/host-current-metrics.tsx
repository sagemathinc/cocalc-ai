import { Progress, Space, Tag, Typography } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import type { Host } from "@cocalc/conat/hub/api/hosts";
import { human_readable_size } from "@cocalc/util/misc";

type HostCurrentMetricsProps = {
  host: Host;
  compact?: boolean;
};

type MetricBarProps = {
  label: string;
  percent?: number;
  detail?: string;
  compact?: boolean;
};

function formatBytes(value?: number): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return human_readable_size(value);
}

function normalizePercent(value?: number): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

function progressStatus(percent?: number): "normal" | "active" | "exception" {
  if (percent == null || !Number.isFinite(percent)) return "normal";
  if (percent >= 90) return "exception";
  if (percent >= 75) return "active";
  return "normal";
}

function getDiskUsedPercent(host: Host): number | undefined {
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
  return normalizePercent(((total - available) / total) * 100);
}

function getMetadataUsedPercent(host: Host): number | undefined {
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
  return normalizePercent((used / total) * 100);
}

function MetricBar({ label, percent, detail, compact }: MetricBarProps) {
  const displayPercent = normalizePercent(percent);
  return (
    <Space
      orientation="vertical"
      size={2}
      style={{ width: compact ? 180 : "100%" }}
    >
      <Space
        size={8}
        style={{
          justifyContent: "space-between",
          width: "100%",
        }}
      >
        <Typography.Text style={{ fontSize: compact ? 12 : undefined }}>
          {label}
          {displayPercent != null ? ` ${Math.round(displayPercent)}%` : ""}
        </Typography.Text>
        {detail && (
          <Typography.Text
            type="secondary"
            style={{ fontSize: compact ? 12 : undefined }}
          >
            {detail}
          </Typography.Text>
        )}
      </Space>
      {displayPercent != null ? (
        <Progress
          percent={Math.round(displayPercent)}
          size="small"
          status={progressStatus(displayPercent)}
          showInfo={false}
        />
      ) : (
        <Typography.Text
          type="secondary"
          style={{ fontSize: compact ? 12 : undefined }}
        >
          n/a
        </Typography.Text>
      )}
    </Space>
  );
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

  const cpuPercent = normalizePercent(metrics.cpu_percent);
  const memoryPercent = normalizePercent(metrics.memory_used_percent);
  const diskPercent = getDiskUsedPercent(host);
  const metadataPercent = getMetadataUsedPercent(host);
  const diskFree = formatBytes(metrics.disk_available_conservative_bytes);
  const memoryUsed = formatBytes(metrics.memory_used_bytes);
  const memoryTotal = formatBytes(metrics.memory_total_bytes);
  const diskTotal = formatBytes(metrics.disk_device_total_bytes);
  const metadataUsed = formatBytes(metrics.btrfs_metadata_used_bytes);
  const metadataTotal = formatBytes(metrics.btrfs_metadata_total_bytes);
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
      <Space orientation="vertical" size={4}>
        <MetricBar
          label="CPU"
          percent={cpuPercent}
          detail={load ? `load ${load}` : undefined}
          compact
        />
        <MetricBar
          label="RAM"
          percent={memoryPercent}
          detail={
            memoryUsed && memoryTotal
              ? `${memoryUsed} / ${memoryTotal}`
              : undefined
          }
          compact
        />
        <MetricBar
          label="Disk"
          percent={diskPercent}
          detail={diskFree ? `${diskFree} free` : diskTotal}
          compact
        />
        <Tag>
          Projects {metrics.running_project_count ?? 0}/
          {metrics.assigned_project_count ?? 0} running
        </Tag>
      </Space>
    );
  }

  return (
    <Space orientation="vertical" size={6} style={{ width: "100%" }}>
      <MetricBar
        label="CPU"
        percent={cpuPercent}
        detail={load ? `load ${load}` : undefined}
      />
      <MetricBar
        label="Memory"
        percent={memoryPercent}
        detail={
          memoryUsed && memoryTotal
            ? `${memoryUsed} / ${memoryTotal}`
            : undefined
        }
      />
      <MetricBar
        label="Disk"
        percent={diskPercent}
        detail={
          diskFree
            ? `${diskFree} conservative free${diskTotal ? ` / ${diskTotal}` : ""}`
            : diskTotal
        }
      />
      <MetricBar
        label="Metadata"
        percent={metadataPercent}
        detail={
          metadataUsed && metadataTotal
            ? `${metadataUsed} / ${metadataTotal}`
            : undefined
        }
      />
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
