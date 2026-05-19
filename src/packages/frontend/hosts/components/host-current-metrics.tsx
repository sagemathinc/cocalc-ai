import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  ExclamationCircleFilled,
  HddOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { Progress, Space, Tag, Typography } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import { Tooltip } from "@cocalc/frontend/components";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import type {
  Host,
  HostMetricsDerived,
  HostMetricsHistoryPoint,
  HostMetricsRiskLevel,
} from "@cocalc/conat/hub/api/hosts";
import { COLORS } from "@cocalc/util/theme";
import { formatBinaryBytes } from "../utils/format";

type HostCurrentMetricsProps = {
  host: Host;
  compact?: boolean;
  dense?: boolean;
};

type MetricBarProps = {
  label: string;
  percent?: number;
  detail?: string;
  compact?: boolean;
  historyPoints?: SparklinePoint[];
  color?: string;
  icon?: React.ReactNode;
};

type SparklinePoint = {
  value: number;
  tooltip: React.ReactNode;
};

function formatBytes(value?: number): string | undefined {
  return formatBinaryBytes(value);
}

function formatBytesCompact(value?: number): string | undefined {
  return formatBinaryBytes(value, { compact: true });
}

function normalizePercent(value?: number): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

function parseTimestampMs(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sparklinePoints(values: number[], width = 180, height = 24): string {
  if (values.length === 0) return "";
  if (values.length === 1) {
    return `0,${height / 2} ${width},${height / 2}`;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const y = (value: number) => {
    if (max === min) return height / 2;
    return height - ((value - min) / (max - min)) * (height - 4) - 2;
  };
  const dx = width / (values.length - 1);
  return values
    .map((value, i) => `${(i * dx).toFixed(2)},${y(value).toFixed(2)}`)
    .join(" ");
}

function sparklineCoordinates(
  values: number[],
  width = 180,
  height = 24,
): { x: number; y: number }[] {
  if (values.length === 0) return [];
  if (values.length === 1) {
    return [{ x: width / 2, y: height / 2 }];
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const y = (value: number) => {
    if (max === min) return height / 2;
    return height - ((value - min) / (max - min)) * (height - 4) - 2;
  };
  const dx = width / (values.length - 1);
  return values.map((value, i) => ({
    x: i * dx,
    y: y(value),
  }));
}

function formatGrowthBytesPerHour(value?: number): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
  const formatted = formatBinaryBytes(Math.abs(value));
  return formatted ? `${prefix}${formatted}/h` : undefined;
}

function progressStatus(percent?: number): "normal" | "active" | "exception" {
  if (percent == null || !Number.isFinite(percent)) return "normal";
  if (percent >= 90) return "exception";
  if (percent >= 75) return "active";
  return "normal";
}

type ResourceTone = "green" | "blue" | "orange" | "red" | "gray";

const RESOURCE_TONES: Record<
  ResourceTone,
  { text: string; background: string; border: string }
> = {
  green: {
    text: COLORS.ANTD_GREEN_D,
    background: COLORS.BS_GREEN_LL,
    border: COLORS.ANTD_GREEN,
  },
  blue: {
    text: COLORS.ANTD_LINK_BLUE,
    background: COLORS.BLUE_LLLL,
    border: COLORS.BLUE_LLL,
  },
  orange: {
    text: COLORS.YELL_D,
    background: COLORS.YELL_LLL,
    border: COLORS.YELL_LL,
  },
  red: {
    text: COLORS.FG_RED,
    background: COLORS.ANTD_BG_RED_L,
    border: COLORS.ANTD_BG_RED_M,
  },
  gray: {
    text: COLORS.GRAY_M,
    background: COLORS.GRAY_LLL,
    border: COLORS.GRAY_L0,
  },
};

function percentTone(percent?: number): ResourceTone {
  if (percent == null || !Number.isFinite(percent)) return "gray";
  if (percent >= 90) return "red";
  if (percent >= 75) return "orange";
  return "green";
}

type DiskUsageSource = {
  disk_device_total_bytes?: number;
  disk_device_used_bytes?: number;
  disk_available_conservative_bytes?: number;
};

function getDisplayedDiskUsedBytes(
  source: DiskUsageSource | undefined,
): number | undefined {
  if (!source) return undefined;
  const used = source.disk_device_used_bytes;
  if (used != null && Number.isFinite(used) && used >= 0) {
    return used;
  }
  const available = source.disk_available_conservative_bytes;
  const total = source.disk_device_total_bytes;
  if (
    available == null ||
    total == null ||
    !Number.isFinite(available) ||
    !Number.isFinite(total)
  ) {
    return undefined;
  }
  return Math.max(0, total - available);
}

function getDisplayedDiskUsedPercent(
  source: DiskUsageSource | undefined,
): number | undefined {
  if (!source) return undefined;
  const total = source.disk_device_total_bytes;
  const used = getDisplayedDiskUsedBytes(source);
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

function formatTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatPercent(value?: number): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return `${value.toFixed(1)}%`;
}

function formatSignedBytes(value?: number): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
  const formatted = formatBinaryBytes(Math.abs(value));
  return formatted ? `${prefix}${formatted}` : undefined;
}

function formatHours(value?: number): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  if (value < 1) {
    return `${Math.round(value * 60)}m`;
  }
  if (value < 24) {
    return `${value.toFixed(1)}h`;
  }
  return `${Math.round(value)}h`;
}

function getMetricsStaleness(host: Host): {
  stale: boolean;
  message?: string;
} {
  const collectedAt = parseTimestampMs(host.metrics?.current?.collected_at);
  if (collectedAt == null) {
    return { stale: false };
  }
  const lastActionAt = parseTimestampMs(host.last_action_at);
  if (lastActionAt != null && collectedAt + 5_000 < lastActionAt) {
    const action = host.last_action ? ` ${host.last_action}` : "";
    return {
      stale: true,
      message: `Current metrics were sampled at ${new Date(collectedAt).toLocaleString()}, before the last host action${action} at ${new Date(lastActionAt).toLocaleString()}.`,
    };
  }
  const lastSeenAt = parseTimestampMs(host.last_seen);
  if (lastSeenAt != null && lastSeenAt - collectedAt > 90_000) {
    return {
      stale: true,
      message:
        "The host heartbeat is newer than the current metrics sample, so these values may be out of date.",
    };
  }
  return { stale: false };
}

function riskColor(level: HostMetricsRiskLevel): string | undefined {
  switch (level) {
    case "critical":
      return "red";
    case "warning":
      return "orange";
    default:
      return undefined;
  }
}

function riskLabel(
  kind: "disk" | "metadata",
  level: HostMetricsRiskLevel,
): string {
  return `${kind} ${level}`;
}

function riskTooltip(
  title: string,
  opts: {
    reason?: string;
    used_percent?: number;
    available_bytes?: number;
    hours_to_exhaustion?: number;
  },
): React.ReactNode {
  const lines: string[] = [];
  if (opts.reason) lines.push(opts.reason);
  if (opts.used_percent != null) {
    lines.push(`Used ${formatPercent(opts.used_percent)}`);
  }
  if (opts.available_bytes != null) {
    lines.push(`Available ${formatBytes(opts.available_bytes)}`);
  }
  if (opts.hours_to_exhaustion != null) {
    lines.push(`Exhaustion forecast ${formatHours(opts.hours_to_exhaustion)}`);
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {lines.map((line, i) => (
        <div key={`${title}-risk-${i}`}>{line}</div>
      ))}
    </div>
  );
}

function renderDerivedRiskTags(
  derived: HostMetricsDerived | undefined,
): React.ReactNode {
  if (!derived) return null;
  const overlayInnerStyle = {
    maxWidth: "min(420px, calc(100vw - 64px))",
    width: "max-content",
  } as const;
  const tags: React.ReactNode[] = [];
  if (derived.disk.level !== "healthy") {
    const tag = (
      <Tag color={riskColor(derived.disk.level)}>
        {riskLabel("disk", derived.disk.level)}
      </Tag>
    );
    tags.push(
      derived.disk.reason ? (
        <Tooltip
          key="disk-risk"
          title={riskTooltip("Disk risk", derived.disk)}
          placement="top"
          overlayInnerStyle={overlayInnerStyle}
        >
          {tag}
        </Tooltip>
      ) : (
        <React.Fragment key="disk-risk">{tag}</React.Fragment>
      ),
    );
  }
  if (derived.metadata.level !== "healthy") {
    const tag = (
      <Tag color={riskColor(derived.metadata.level)}>
        {riskLabel("metadata", derived.metadata.level)}
      </Tag>
    );
    tags.push(
      derived.metadata.reason ? (
        <Tooltip
          key="metadata-risk"
          title={riskTooltip("Metadata risk", derived.metadata)}
          placement="top"
          overlayInnerStyle={overlayInnerStyle}
        >
          {tag}
        </Tooltip>
      ) : (
        <React.Fragment key="metadata-risk">{tag}</React.Fragment>
      ),
    );
  }
  if (!derived.admission_allowed) {
    tags.push(
      <Tooltip
        key="admission-blocked"
        title="Storage-heavy admissions should be blocked until the host recovers."
        overlayInnerStyle={overlayInnerStyle}
      >
        <Tag color="red">admission blocked</Tag>
      </Tooltip>,
    );
  }
  if (derived.auto_grow_recommended) {
    tags.push(
      <Tooltip
        key="auto-grow-recommended"
        title="The host is approaching a disk limit where guarded disk growth would likely help."
        overlayInnerStyle={overlayInnerStyle}
      >
        <Tag color="gold">auto-grow suggested</Tag>
      </Tooltip>,
    );
  }
  if (!tags.length) return null;
  return (
    <Space size={[4, 4]} wrap>
      {tags}
    </Space>
  );
}

function resourceHealth({
  derived,
  diskPercent,
  metadataPercent,
  stale,
}: {
  derived?: HostMetricsDerived;
  diskPercent?: number;
  metadataPercent?: number;
  stale?: boolean;
}): { label: string; tone: ResourceTone; detail: string } {
  if (
    derived?.disk.level === "critical" ||
    derived?.metadata.level === "critical" ||
    derived?.admission_allowed === false ||
    percentTone(diskPercent) === "red" ||
    percentTone(metadataPercent) === "red"
  ) {
    return { label: "Critical", tone: "red", detail: "Resource pressure" };
  }
  if (
    derived?.disk.level === "warning" ||
    derived?.metadata.level === "warning" ||
    derived?.auto_grow_recommended ||
    percentTone(diskPercent) === "orange" ||
    percentTone(metadataPercent) === "orange"
  ) {
    return { label: "Watch disk", tone: "orange", detail: "Overall health" };
  }
  if (stale) {
    return {
      label: "Metrics stale",
      tone: "orange",
      detail: "Refresh pending",
    };
  }
  return { label: "Healthy", tone: "green", detail: "Overall health" };
}

function HealthBadge({
  label,
  detail,
  tone,
}: {
  label: string;
  detail?: string;
  tone: ResourceTone;
}) {
  const colors = RESOURCE_TONES[tone];
  const icon =
    tone === "green" ? <CheckCircleFilled /> : <ExclamationCircleFilled />;
  return (
    <Space size={8}>
      <span
        style={{
          width: 30,
          height: 30,
          borderRadius: 15,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: colors.text,
          background: colors.background,
          border: `1px solid ${colors.border}`,
        }}
      >
        {icon}
      </span>
      <span>
        <Typography.Text strong style={{ color: colors.text }}>
          {label}
        </Typography.Text>
        {detail ? (
          <Typography.Text
            type="secondary"
            style={{ display: "block", fontSize: 12 }}
          >
            {detail}
          </Typography.Text>
        ) : null}
      </span>
    </Space>
  );
}

function StaleMetricsTag({
  stale,
  message,
}: {
  stale: boolean;
  message?: string;
}) {
  if (!stale) return null;
  return (
    <Tooltip title={message} placement="top">
      <Tag color="orange" style={{ marginInlineEnd: 0 }}>
        metrics stale
      </Tag>
    </Tooltip>
  );
}

function tooltipContent(
  title: string,
  point: HostMetricsHistoryPoint,
  lines: Array<string | undefined>,
): React.ReactNode {
  const timestamp = formatTimestamp(point.collected_at);
  const visibleLines = lines.filter(
    (line): line is string => typeof line === "string" && line.length > 0,
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {timestamp && <div>{timestamp}</div>}
      {visibleLines.map((line, i) => (
        <div key={`${title}-${i}`}>{line}</div>
      ))}
    </div>
  );
}

function buildHistoryPoints(
  points: HostMetricsHistoryPoint[] | undefined,
  getValue: (point: HostMetricsHistoryPoint) => number | undefined,
  renderTooltip: (
    point: HostMetricsHistoryPoint,
    prev?: HostMetricsHistoryPoint,
  ) => React.ReactNode,
): SparklinePoint[] {
  return (points ?? []).flatMap((point, index, all) => {
    const value = getValue(point);
    if (value == null || !Number.isFinite(value) || value < 0) {
      return [];
    }
    return [
      {
        value,
        tooltip: renderTooltip(point, index > 0 ? all[index - 1] : undefined),
      },
    ];
  });
}

function Sparkline({
  points,
  color,
  compact,
}: {
  points: SparklinePoint[];
  color?: string;
  compact?: boolean;
}) {
  const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null);
  const chartWidth = compact ? 180 : 320;
  const chartHeight = compact ? 24 : 28;
  if (points.length < 2) {
    return <div style={{ height: chartHeight }} />;
  }
  const values = points.map((point) => point.value);
  const coordinates = sparklineCoordinates(values, chartWidth, chartHeight);
  const hoveredPoint =
    hoveredIndex != null ? coordinates[hoveredIndex] : undefined;
  const tooltipStyle =
    hoveredPoint && hoveredIndex != null
      ? hoveredPoint.x < 72
        ? {
            left: 0,
            top: -8,
            transform: "translate(0, -100%)",
          }
        : hoveredPoint.x > chartWidth - 72
          ? {
              right: 0,
              top: -8,
              transform: "translate(0, -100%)",
            }
          : {
              left: `${(hoveredPoint.x / chartWidth) * 100}%`,
              top: -8,
              transform: "translate(-50%, -100%)",
            }
      : undefined;
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: chartHeight,
        cursor: "crosshair",
      }}
      onMouseLeave={() => setHoveredIndex(null)}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        const relativeX = Math.max(
          0,
          Math.min(1, (event.clientX - rect.left) / rect.width),
        );
        setHoveredIndex(Math.round(relativeX * (points.length - 1)));
      }}
    >
      <svg
        width="100%"
        height={chartHeight}
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        preserveAspectRatio="none"
      >
        <polyline
          fill="none"
          stroke={color ?? COLORS.BLUE_D}
          strokeWidth="2"
          points={sparklinePoints(values, chartWidth, chartHeight)}
          strokeLinecap="round"
        />
        {hoveredPoint && (
          <>
            <line
              x1={hoveredPoint.x}
              x2={hoveredPoint.x}
              y1={0}
              y2={chartHeight}
              stroke={color ?? COLORS.BLUE_D}
              strokeOpacity="0.25"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <circle
              cx={hoveredPoint.x}
              cy={hoveredPoint.y}
              r="3.5"
              fill={color ?? COLORS.BLUE_D}
              stroke="white"
              strokeWidth="1.5"
            />
          </>
        )}
      </svg>
      {hoveredPoint && hoveredIndex != null && (
        <div
          style={{
            position: "absolute",
            zIndex: 20,
            pointerEvents: "none",
            maxWidth: compact ? 220 : 280,
            borderRadius: 6,
            padding: "8px 10px",
            background: "rgba(24, 24, 27, 0.94)",
            color: "white",
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
            fontSize: 12,
            lineHeight: 1.35,
            ...tooltipStyle,
          }}
        >
          {points[hoveredIndex].tooltip}
        </div>
      )}
    </div>
  );
}

function CompactMetricLine({
  label,
  percent,
  detail,
  color,
}: {
  label: string;
  percent?: number;
  detail?: string;
  color?: string;
}) {
  const displayPercent = normalizePercent(percent);
  const toneColors = RESOURCE_TONES[percentTone(displayPercent)];
  const display =
    displayPercent != null ? Math.round(displayPercent) : undefined;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "32px 38px minmax(40px, 1fr) minmax(0, 70px)",
        gap: 5,
        alignItems: "center",
        minHeight: 22,
        padding: "2px 0",
        minWidth: 0,
      }}
    >
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        {label}
      </Typography.Text>
      <Typography.Text
        strong
        style={{
          color: toneColors.text,
          fontSize: 12,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {display != null ? `${display}%` : "n/a"}
      </Typography.Text>
      <Progress
        percent={display ?? 0}
        size="small"
        status={progressStatus(displayPercent)}
        showInfo={false}
        strokeColor={color ?? toneColors.text}
      />
      {detail ? (
        <Typography.Text
          type="secondary"
          style={{
            fontSize: 11,
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
          title={detail}
        >
          {detail}
        </Typography.Text>
      ) : null}
    </div>
  );
}

function MetricBar({
  label,
  percent,
  detail,
  compact,
  historyPoints,
  color,
  icon,
}: MetricBarProps) {
  const displayPercent = normalizePercent(percent);
  const trendPoints = historyPoints ?? [];
  const tone = percentTone(displayPercent);
  const toneColors = RESOURCE_TONES[tone];
  const display =
    displayPercent != null ? Math.round(displayPercent) : undefined;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: compact
          ? "34px minmax(95px, 0.8fr) minmax(120px, 1fr)"
          : "42px minmax(120px, 0.7fr) minmax(180px, 1fr) minmax(160px, 1fr)",
        gap: compact ? 10 : 16,
        alignItems: "center",
        width: "100%",
        padding: compact ? "8px 0" : "12px 0",
        borderTop: `1px solid ${COLORS.GRAY_LL}`,
      }}
    >
      <span
        style={{
          width: compact ? 30 : 38,
          height: compact ? 30 : 38,
          borderRadius: 10,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: color ?? COLORS.BLUE_D,
          background: COLORS.GRAY_LLL,
          fontSize: compact ? 17 : 20,
        }}
      >
        {icon}
      </span>
      <span>
        <Typography.Text strong style={{ display: "block" }}>
          {label}
        </Typography.Text>
        <Typography.Text
          strong
          style={{ color: toneColors.text, fontSize: compact ? 16 : 18 }}
        >
          {display != null ? `${display}%` : "n/a"}
        </Typography.Text>
        {detail ? (
          <Typography.Text
            type="secondary"
            style={{ display: "block", fontSize: 12 }}
          >
            {detail}
          </Typography.Text>
        ) : null}
      </span>
      <Sparkline points={trendPoints} color={color} compact={compact} />
      <div>
        <Progress
          percent={display ?? 0}
          size="small"
          status={progressStatus(displayPercent)}
          showInfo={false}
          strokeColor={toneColors.text}
        />
        {!compact ? (
          <div
            style={{
              display: "flex",
              justifyContent: "space-around",
              color: COLORS.GRAY_M,
              fontSize: 11,
            }}
          >
            <span>75%</span>
            <span>90%</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const HostCurrentMetrics: React.FC<HostCurrentMetricsProps> = ({
  host,
  compact,
  dense,
}) => {
  const metrics = host.metrics?.current;
  const history = host.metrics?.history;
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
  const diskPercent = getDisplayedDiskUsedPercent(metrics);
  const metadataPercent = getMetadataUsedPercent(host);
  const diskUsedBytes = getDisplayedDiskUsedBytes(metrics);
  const diskUsed = compact
    ? formatBytesCompact(diskUsedBytes)
    : formatBytes(diskUsedBytes);
  const memoryUsed = compact
    ? formatBytesCompact(metrics.memory_used_bytes)
    : formatBytes(metrics.memory_used_bytes);
  const memoryTotal = compact
    ? formatBytesCompact(metrics.memory_total_bytes)
    : formatBytes(metrics.memory_total_bytes);
  const diskTotal = compact
    ? formatBytesCompact(metrics.disk_device_total_bytes)
    : formatBytes(metrics.disk_device_total_bytes);
  const metadataUsed = compact
    ? formatBytesCompact(metrics.btrfs_metadata_used_bytes)
    : formatBytes(metrics.btrfs_metadata_used_bytes);
  const metadataTotal = compact
    ? formatBytesCompact(metrics.btrfs_metadata_total_bytes)
    : formatBytes(metrics.btrfs_metadata_total_bytes);
  const cpuHistory = buildHistoryPoints(
    history?.points,
    (point) => normalizePercent(point.cpu_percent),
    (point) =>
      tooltipContent("CPU", point, [
        point.cpu_percent != null
          ? `CPU ${formatPercent(point.cpu_percent)}`
          : undefined,
        point.load_1 != null || point.load_5 != null || point.load_15 != null
          ? `Load ${[point.load_1, point.load_5, point.load_15]
              .map((value) =>
                value == null || !Number.isFinite(value)
                  ? "?"
                  : value.toFixed(2),
              )
              .join(" / ")}`
          : undefined,
      ]),
  );
  const memoryHistory = buildHistoryPoints(
    history?.points,
    (point) => normalizePercent(point.memory_used_percent),
    (point, prev) => {
      const delta =
        point.memory_used_bytes != null && prev?.memory_used_bytes != null
          ? point.memory_used_bytes - prev.memory_used_bytes
          : undefined;
      return tooltipContent("RAM", point, [
        point.memory_used_bytes != null && point.memory_total_bytes != null
          ? `${formatBytes(point.memory_used_bytes)} / ${formatBytes(point.memory_total_bytes)}`
          : undefined,
        point.memory_used_percent != null
          ? `Used ${formatPercent(point.memory_used_percent)}`
          : undefined,
        delta != null ? `Δ used ${formatSignedBytes(delta)}` : undefined,
      ]);
    },
  );
  const diskHistory = buildHistoryPoints(
    history?.points,
    (point) => getDisplayedDiskUsedPercent(point),
    (point, prev) => {
      const currentUsed = getDisplayedDiskUsedBytes(point);
      const previousUsed = getDisplayedDiskUsedBytes(prev);
      const delta =
        currentUsed != null && previousUsed != null
          ? currentUsed - previousUsed
          : undefined;
      const displayedPercent = getDisplayedDiskUsedPercent(point);
      return tooltipContent("Disk", point, [
        point.disk_available_conservative_bytes != null &&
        point.disk_device_total_bytes != null
          ? `Used ${formatBytes(currentUsed)} / ${formatBytes(point.disk_device_total_bytes)}`
          : undefined,
        displayedPercent != null
          ? `Used ${formatPercent(displayedPercent)}`
          : undefined,
        delta != null ? `Δ used ${formatSignedBytes(delta)}` : undefined,
      ]);
    },
  );
  const metadataHistory = buildHistoryPoints(
    history?.points,
    (point) => normalizePercent(point.metadata_used_percent),
    (point, prev) => {
      const delta =
        point.btrfs_metadata_used_bytes != null &&
        prev?.btrfs_metadata_used_bytes != null
          ? point.btrfs_metadata_used_bytes - prev.btrfs_metadata_used_bytes
          : undefined;
      return tooltipContent("Metadata", point, [
        point.btrfs_metadata_used_bytes != null &&
        point.btrfs_metadata_total_bytes != null
          ? `${formatBytes(point.btrfs_metadata_used_bytes)} / ${formatBytes(point.btrfs_metadata_total_bytes)}`
          : undefined,
        point.metadata_used_percent != null
          ? `Used ${formatPercent(point.metadata_used_percent)}`
          : undefined,
        delta != null ? `Δ used ${formatSignedBytes(delta)}` : undefined,
      ]);
    },
  );
  const diskTrend = formatGrowthBytesPerHour(
    history?.growth?.disk_used_bytes_per_hour,
  );
  const metadataTrend = formatGrowthBytesPerHour(
    history?.growth?.metadata_used_bytes_per_hour,
  );
  const derived = history?.derived;
  const riskTags = renderDerivedRiskTags(derived);
  const metricsStaleness = getMetricsStaleness(host);
  const health = resourceHealth({
    derived,
    diskPercent,
    metadataPercent,
    stale: metricsStaleness.stale,
  });
  const staleMetricsTag = (
    <StaleMetricsTag
      stale={metricsStaleness.stale}
      message={metricsStaleness.message}
    />
  );
  const riskSummary = derived
    ? `Risk: disk ${derived.disk.level}, metadata ${derived.metadata.level} · ${
        derived.admission_allowed ? "admission allowed" : "admission blocked"
      }${derived.auto_grow_recommended ? " · auto-grow suggested" : ""}`
    : undefined;
  const load =
    metrics.load_1 != null || metrics.load_5 != null || metrics.load_15 != null
      ? [metrics.load_1, metrics.load_5, metrics.load_15]
          .map((value) =>
            value == null || !Number.isFinite(value) ? "?" : value.toFixed(2),
          )
          .join(" / ")
      : undefined;

  if (compact) {
    if (dense) {
      const metadataCritical =
        derived?.metadata.level === "critical" ||
        percentTone(metadataPercent) === "red";
      const healthTagColor =
        health.tone === "red"
          ? "red"
          : health.tone === "orange"
            ? "orange"
            : health.tone === "green"
              ? "green"
              : undefined;
      const denseStaleMetricsTag =
        health.label === "Metrics stale" ? null : staleMetricsTag;
      return (
        <div
          style={{
            minWidth: 0,
            width: "100%",
            maxWidth: 236,
            border: `1px solid ${COLORS.GRAY_LL}`,
            borderRadius: 10,
            background: "white",
            padding: "6px 9px",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              alignItems: "center",
              marginBottom: riskTags ? 3 : 5,
            }}
          >
            <Tag color={healthTagColor} style={{ marginInlineEnd: 0 }}>
              {health.label}
            </Tag>
            {denseStaleMetricsTag}
          </div>
          {riskTags ? (
            <div style={{ marginBottom: 4, lineHeight: 1 }}>{riskTags}</div>
          ) : null}
          <CompactMetricLine
            label="CPU"
            percent={cpuPercent}
            detail={load ? `load ${load.split(" / ")[0]}` : undefined}
            color={COLORS.BLUE_D}
          />
          <CompactMetricLine
            label="RAM"
            percent={memoryPercent}
            detail={
              memoryUsed && memoryTotal
                ? `${memoryUsed} / ${memoryTotal}`
                : undefined
            }
            color={COLORS.ANTD_GREEN_D}
          />
          <CompactMetricLine
            label="Disk"
            percent={diskPercent}
            detail={
              diskUsed && diskTotal ? `${diskUsed} / ${diskTotal}` : diskTotal
            }
            color={COLORS.ANTD_ORANGE}
          />
          {metadataCritical ? (
            <CompactMetricLine
              label="Meta"
              percent={metadataPercent}
              detail={
                metadataUsed && metadataTotal
                  ? `${metadataUsed} / ${metadataTotal}`
                  : undefined
              }
              color={COLORS.ANTD_RED}
            />
          ) : null}
          <div
            style={{
              borderTop: `1px solid ${COLORS.GRAY_LL}`,
              paddingTop: 5,
              marginTop: 4,
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              alignItems: "center",
              fontSize: 11,
            }}
          >
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              <TeamOutlined /> {metrics.running_project_count ?? 0} running /{" "}
              {metrics.assigned_project_count ?? 0} assigned
            </Typography.Text>
            {metrics.collected_at ? (
              <Typography.Text
                type="secondary"
                style={{ fontSize: 11, whiteSpace: "nowrap" }}
              >
                <ClockCircleOutlined /> <TimeAgo date={metrics.collected_at} />
              </Typography.Text>
            ) : null}
          </div>
        </div>
      );
    }

    const body = (
      <>
        <MetricBar
          label="CPU"
          percent={cpuPercent}
          detail={load ? load : undefined}
          compact
          historyPoints={cpuHistory}
          color={COLORS.BLUE_D}
          icon={<CloudServerOutlined />}
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
          historyPoints={memoryHistory}
          color={COLORS.ANTD_GREEN_D}
          icon={<HddOutlined />}
        />
        <MetricBar
          label="Disk"
          percent={diskPercent}
          detail={
            diskUsed && diskTotal ? `${diskUsed} / ${diskTotal}` : diskTotal
          }
          compact
          historyPoints={diskHistory}
          color={COLORS.ANTD_ORANGE}
          icon={<DatabaseOutlined />}
        />
        <MetricBar
          label="Metadata"
          percent={metadataPercent}
          detail={
            metadataUsed && metadataTotal
              ? `${metadataUsed} / ${metadataTotal}`
              : undefined
          }
          compact
          historyPoints={metadataHistory}
          color={COLORS.ANTD_RED}
          icon={<DatabaseOutlined />}
        />
      </>
    );
    return (
      <div
        style={{
          border: `1px solid ${COLORS.GRAY_LL}`,
          borderRadius: 10,
          background: "white",
          padding: 10,
          width: "100%",
        }}
      >
        <Space orientation="vertical" size={6} style={{ width: "100%" }}>
          <Space size={[8, 6]} wrap>
            <HealthBadge
              label={health.label}
              detail={health.detail}
              tone={health.tone}
            />
            {staleMetricsTag}
            {riskTags}
          </Space>
          {body}
          <Space size={[12, 6]} wrap>
            <Tag icon={<TeamOutlined />}>
              Projects {metrics.running_project_count ?? 0} running /{" "}
              {metrics.assigned_project_count ?? 0} assigned
            </Tag>
            {metrics.collected_at ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                <ClockCircleOutlined /> Sampled{" "}
                <TimeAgo date={metrics.collected_at} />
              </Typography.Text>
            ) : null}
          </Space>
        </Space>
      </div>
    );
  }

  return (
    <div
      style={{
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: 12,
        background: "white",
        width: "100%",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "12px 14px" }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Resources
        </Typography.Title>
      </div>
      <div
        style={{
          borderTop: `1px solid ${COLORS.GRAY_LL}`,
          borderBottom: `1px solid ${COLORS.GRAY_LL}`,
          padding: "12px 14px",
          display: "grid",
          gridTemplateColumns:
            "minmax(160px, 1fr) minmax(140px, auto) minmax(140px, auto) auto",
          gap: 16,
          alignItems: "center",
        }}
      >
        <HealthBadge
          label={health.label}
          detail={health.detail}
          tone={health.tone}
        />
        <Space size={8}>
          <TeamOutlined
            style={{ color: COLORS.ANTD_LINK_BLUE, fontSize: 20 }}
          />
          <Typography.Text>
            <strong>{metrics.running_project_count ?? 0}</strong> running
            <br />
            <strong>{metrics.assigned_project_count ?? 0}</strong> assigned
          </Typography.Text>
        </Space>
        {metrics.collected_at ? (
          <Space size={8}>
            <ClockCircleOutlined
              style={{ color: COLORS.GRAY_M, fontSize: 20 }}
            />
            <Typography.Text>
              Sampled
              <br />
              <TimeAgo date={metrics.collected_at} />
            </Typography.Text>
          </Space>
        ) : null}
        {staleMetricsTag}
      </div>
      <div style={{ padding: "0 14px" }}>
        <MetricBar
          label="CPU"
          percent={cpuPercent}
          detail={load ? `load ${load}` : undefined}
          historyPoints={cpuHistory}
          color={COLORS.BLUE_D}
          icon={<CloudServerOutlined />}
        />
        <MetricBar
          label="Memory"
          percent={memoryPercent}
          detail={
            memoryUsed && memoryTotal
              ? `${memoryUsed} / ${memoryTotal}`
              : undefined
          }
          historyPoints={memoryHistory}
          color={COLORS.ANTD_GREEN_D}
          icon={<HddOutlined />}
        />
        <MetricBar
          label="Disk"
          percent={diskPercent}
          detail={
            diskUsed && diskTotal ? `${diskUsed} / ${diskTotal}` : diskTotal
          }
          historyPoints={diskHistory}
          color={COLORS.ANTD_ORANGE}
          icon={<DatabaseOutlined />}
        />
        <MetricBar
          label="Metadata"
          percent={metadataPercent}
          detail={
            metadataUsed && metadataTotal
              ? `${metadataUsed} / ${metadataTotal}`
              : undefined
          }
          historyPoints={metadataHistory}
          color={COLORS.ANTD_RED}
          icon={<DatabaseOutlined />}
        />
      </div>
      <div
        style={{
          borderTop: `1px solid ${COLORS.GRAY_LL}`,
          padding: "10px 14px",
        }}
      >
        <Space size={[12, 8]} wrap>
          <Tag icon={<TeamOutlined />}>
            {metrics.running_project_count ?? 0} running
          </Tag>
          <Tag>{metrics.starting_project_count ?? 0} starting</Tag>
          <Tag>{metrics.stopping_project_count ?? 0} stopping</Tag>
          <Tag>{metrics.assigned_project_count ?? 0} assigned</Tag>
          {riskTags}
          {diskTrend ? <Tag color="orange">Disk trend {diskTrend}</Tag> : null}
          {metadataTrend ? (
            <Tag color="blue">Metadata trend {metadataTrend}</Tag>
          ) : null}
        </Space>
        {riskSummary && (
          <Typography.Text
            type="secondary"
            style={{ display: "block", marginTop: 8 }}
          >
            {riskSummary}
            {history?.window_minutes
              ? ` over last ${history.window_minutes}m`
              : ""}
          </Typography.Text>
        )}
      </div>
    </div>
  );
};
