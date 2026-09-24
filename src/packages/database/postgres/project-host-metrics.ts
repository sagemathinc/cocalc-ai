import getPool from "@cocalc/database/pool";
import type {
  HostCurrentMetrics,
  HostMetricsDerived,
  HostMetricsHistory,
  HostMetricsHistoryGrowth,
  HostMetricsHistoryPoint,
  HostMetricsRiskLevel,
  HostMetricsRiskState,
  HostConatPersistMetrics,
  HostIoContainmentMetrics,
} from "@cocalc/conat/hub/api/hosts";
import type { Pool } from "pg";

const SAMPLE_INTERVAL_MS = 60_000;
const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_MAX_POINTS = 60;
const MAX_WINDOW_MINUTES = 7 * 24 * 60;
const DEFAULT_RETENTION_MINUTES = 8 * 24 * 60;
const DEFAULT_PRUNE_LIMIT = 25_000;
const GIB = 1024 * 1024 * 1024;
const DISK_WARNING_AVAILABLE_BYTES = bytesEnv(
  "COCALC_PROJECT_HOST_METRICS_DISK_WARNING_AVAILABLE_BYTES",
  25 * GIB,
);
const DISK_CRITICAL_AVAILABLE_BYTES = bytesEnv(
  "COCALC_PROJECT_HOST_METRICS_DISK_CRITICAL_AVAILABLE_BYTES",
  10 * GIB,
);
const DISK_WARNING_PERCENT = percentEnv(
  "COCALC_PROJECT_HOST_METRICS_DISK_WARNING_PERCENT",
  85,
);
const DISK_CRITICAL_PERCENT = percentEnv(
  "COCALC_PROJECT_HOST_METRICS_DISK_CRITICAL_PERCENT",
  93,
);
const SHARED_SCRATCH_MIN_USED_PERCENT_FOR_HEADROOM = 60;
const METADATA_WARNING_PERCENT = 80;
const METADATA_CRITICAL_PERCENT = 90;
const METADATA_WARNING_AVAILABLE_BYTES = 8 * GIB;
const METADATA_CRITICAL_AVAILABLE_BYTES = 2 * GIB;
const METADATA_WARNING_UNALLOCATED_BYTES = 20 * GIB;
const METADATA_CRITICAL_UNALLOCATED_BYTES = 8 * GIB;
const WARNING_HOURS_TO_EXHAUSTION = 24;
const CRITICAL_HOURS_TO_EXHAUSTION = 6;
const GROWTH_RECENT_INTERVALS = 15;
const GROWTH_MIN_POSITIVE_INTERVALS = 3;
const GROWTH_MIN_OBSERVATION_HOURS = 0.25;
let schemaReady: Promise<void> | undefined;

type ProjectHostMetricsSampleRow = {
  host_id: string;
  collected_at: Date | string;
  cpu_percent: number | string | null;
  load_1: number | string | null;
  load_5: number | string | null;
  load_15: number | string | null;
  memory_total_bytes: number | string | null;
  memory_used_bytes: number | string | null;
  memory_available_bytes: number | string | null;
  memory_used_percent: number | string | null;
  swap_total_bytes: number | string | null;
  swap_used_bytes: number | string | null;
  root_disk_total_bytes: number | string | null;
  root_disk_used_bytes: number | string | null;
  root_disk_available_bytes: number | string | null;
  root_disk_used_percent: number | string | null;
  disk_device_total_bytes: number | string | null;
  disk_device_used_bytes: number | string | null;
  disk_unallocated_bytes: number | string | null;
  shared_scratch_total_bytes: number | string | null;
  shared_scratch_used_bytes: number | string | null;
  shared_scratch_available_bytes: number | string | null;
  btrfs_data_total_bytes: number | string | null;
  btrfs_data_used_bytes: number | string | null;
  btrfs_metadata_total_bytes: number | string | null;
  btrfs_metadata_used_bytes: number | string | null;
  btrfs_system_total_bytes: number | string | null;
  btrfs_system_used_bytes: number | string | null;
  btrfs_global_reserve_total_bytes: number | string | null;
  btrfs_global_reserve_used_bytes: number | string | null;
  disk_available_conservative_bytes: number | string | null;
  disk_available_for_admission_bytes: number | string | null;
  reservation_bytes: number | string | null;
  assigned_project_count: number | string | null;
  running_project_count: number | string | null;
  starting_project_count: number | string | null;
  stopping_project_count: number | string | null;
  io_containment: HostIoContainmentMetrics | string | null;
  conat_persist: HostConatPersistMetrics | string | null;
};

function pool(): Pool {
  return getPool();
}

function bytesEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function percentEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, value));
}

function toFloat(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function toInteger(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.floor(parsed));
}

function toIoContainment(
  value: ProjectHostMetricsSampleRow["io_containment"],
): HostIoContainmentMetrics | undefined {
  if (value == null) return undefined;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toConatPersist(
  value: ProjectHostMetricsSampleRow["conat_persist"],
): HostConatPersistMetrics | undefined {
  if (value == null) return undefined;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeWindowMinutes(value?: number): number {
  const parsed = Number(value ?? DEFAULT_WINDOW_MINUTES);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WINDOW_MINUTES;
  }
  return Math.min(MAX_WINDOW_MINUTES, Math.max(5, Math.floor(parsed)));
}

function normalizeMaxPoints(value?: number): number {
  const parsed = Number(value ?? DEFAULT_MAX_POINTS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_POINTS;
  }
  return Math.min(1440, Math.max(10, Math.floor(parsed)));
}

function compactPoints<T>(points: T[], maxPoints: number): T[] {
  if (points.length <= maxPoints) return points;
  const result: T[] = [];
  const lastIndex = points.length - 1;
  for (let i = 0; i < maxPoints; i += 1) {
    const index = Math.round((i * lastIndex) / Math.max(1, maxPoints - 1));
    result.push(points[index]);
  }
  return result;
}

function computePercent(
  numerator: number | undefined,
  denominator: number | undefined,
): number | undefined {
  if (
    numerator == null ||
    denominator == null ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return undefined;
  }
  return Math.max(0, Math.min(100, (numerator / denominator) * 100));
}

function computeDiskDeviceAvailableBytes(
  point: HostCurrentMetrics,
): number | undefined {
  const total = point.disk_device_total_bytes;
  const used = point.disk_device_used_bytes;
  if (
    total == null ||
    used == null ||
    !Number.isFinite(total) ||
    !Number.isFinite(used) ||
    total <= 0 ||
    used < 0 ||
    used > total
  ) {
    return undefined;
  }
  return total - used;
}

function computeDiskAdmissionAvailableBytes(
  point: HostCurrentMetrics,
): number | undefined {
  const candidates = [
    point.disk_available_for_admission_bytes,
    point.disk_available_conservative_bytes,
    computeDiskDeviceAvailableBytes(point),
  ].filter((value): value is number => value != null && Number.isFinite(value));
  if (candidates.length === 0) return undefined;
  return Math.max(0, Math.max(...candidates));
}

function computeDiskUsedPercent(point: HostCurrentMetrics): number | undefined {
  const total = point.disk_device_total_bytes;
  const used = point.disk_device_used_bytes;
  if (total != null && !Number.isFinite(total)) {
    return undefined;
  }
  if (used != null && !Number.isFinite(used)) {
    return undefined;
  }
  if (total != null && used != null && total > 0 && used >= 0) {
    return Math.max(0, Math.min(100, (used / total) * 100));
  }
  const available = computeDiskAdmissionAvailableBytes(point);
  if (
    total == null ||
    available == null ||
    !Number.isFinite(total) ||
    !Number.isFinite(available) ||
    total <= 0
  ) {
    return undefined;
  }
  return Math.max(0, Math.min(100, ((total - available) / total) * 100));
}

function computeSharedScratchUsedPercent(
  point: HostCurrentMetrics,
): number | undefined {
  return computePercent(
    point.shared_scratch_used_bytes,
    point.shared_scratch_total_bytes,
  );
}

function toPoint(row: ProjectHostMetricsSampleRow): HostMetricsHistoryPoint {
  const point: HostMetricsHistoryPoint = {
    collected_at: new Date(row.collected_at).toISOString(),
    cpu_percent: toFloat(row.cpu_percent),
    load_1: toFloat(row.load_1),
    load_5: toFloat(row.load_5),
    load_15: toFloat(row.load_15),
    memory_total_bytes: toInteger(row.memory_total_bytes),
    memory_used_bytes: toInteger(row.memory_used_bytes),
    memory_available_bytes: toInteger(row.memory_available_bytes),
    memory_used_percent: toFloat(row.memory_used_percent),
    swap_total_bytes: toInteger(row.swap_total_bytes),
    swap_used_bytes: toInteger(row.swap_used_bytes),
    root_disk_total_bytes: toInteger(row.root_disk_total_bytes),
    root_disk_used_bytes: toInteger(row.root_disk_used_bytes),
    root_disk_available_bytes: toInteger(row.root_disk_available_bytes),
    root_disk_used_percent: toFloat(row.root_disk_used_percent),
    disk_device_total_bytes: toInteger(row.disk_device_total_bytes),
    disk_device_used_bytes: toInteger(row.disk_device_used_bytes),
    disk_unallocated_bytes: toInteger(row.disk_unallocated_bytes),
    shared_scratch_total_bytes: toInteger(row.shared_scratch_total_bytes),
    shared_scratch_used_bytes: toInteger(row.shared_scratch_used_bytes),
    shared_scratch_available_bytes: toInteger(
      row.shared_scratch_available_bytes,
    ),
    btrfs_data_total_bytes: toInteger(row.btrfs_data_total_bytes),
    btrfs_data_used_bytes: toInteger(row.btrfs_data_used_bytes),
    btrfs_metadata_total_bytes: toInteger(row.btrfs_metadata_total_bytes),
    btrfs_metadata_used_bytes: toInteger(row.btrfs_metadata_used_bytes),
    btrfs_system_total_bytes: toInteger(row.btrfs_system_total_bytes),
    btrfs_system_used_bytes: toInteger(row.btrfs_system_used_bytes),
    btrfs_global_reserve_total_bytes: toInteger(
      row.btrfs_global_reserve_total_bytes,
    ),
    btrfs_global_reserve_used_bytes: toInteger(
      row.btrfs_global_reserve_used_bytes,
    ),
    disk_available_conservative_bytes: toInteger(
      row.disk_available_conservative_bytes,
    ),
    disk_available_for_admission_bytes: toInteger(
      row.disk_available_for_admission_bytes,
    ),
    reservation_bytes: toInteger(row.reservation_bytes),
    assigned_project_count: toInteger(row.assigned_project_count),
    running_project_count: toInteger(row.running_project_count),
    starting_project_count: toInteger(row.starting_project_count),
    stopping_project_count: toInteger(row.stopping_project_count),
    io_containment: toIoContainment(row.io_containment),
    conat_persist: toConatPersist(row.conat_persist),
  };
  point.disk_used_percent = computeDiskUsedPercent(point);
  point.shared_scratch_used_percent = computeSharedScratchUsedPercent(point);
  point.metadata_used_percent = computePercent(
    point.btrfs_metadata_used_bytes,
    point.btrfs_metadata_total_bytes,
  );
  return point;
}

function computeGrowthRate(
  points: HostMetricsHistoryPoint[],
  field: keyof HostMetricsHistoryPoint,
): number | undefined {
  if (points.length < 2) return undefined;
  const intervalRates: number[] = [];
  let observedHours = 0;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const next = points[i];
    if (
      (prev.reservation_bytes ?? 0) > 0 ||
      (next.reservation_bytes ?? 0) > 0
    ) {
      continue;
    }
    const prevAt = Date.parse(prev.collected_at ?? "");
    const nextAt = Date.parse(next.collected_at ?? "");
    if (
      !Number.isFinite(prevAt) ||
      !Number.isFinite(nextAt) ||
      nextAt <= prevAt
    ) {
      continue;
    }
    const prevValue = toFloat(prev[field]);
    const nextValue = toFloat(next[field]);
    if (prevValue == null || nextValue == null) continue;
    const hours = (nextAt - prevAt) / (60 * 60 * 1000);
    if (!(hours > 0)) continue;
    observedHours += hours;
    intervalRates.push((nextValue - prevValue) / hours);
  }
  if (intervalRates.length === 0) return undefined;
  if (observedHours < GROWTH_MIN_OBSERVATION_HOURS) {
    return undefined;
  }
  if (intervalRates.length <= 2) {
    const positive = intervalRates.filter((rate) => rate > 0);
    return positive.length > 0 ? positive[positive.length - 1] : undefined;
  }
  const recent = intervalRates.slice(-GROWTH_RECENT_INTERVALS);
  const recentTail = recent.slice(-3);
  if (recentTail.length > 0 && recentTail.every((rate) => rate <= 0)) {
    return undefined;
  }
  const positive = recent.filter((rate) => rate > 0);
  if (
    positive.length < Math.min(GROWTH_MIN_POSITIVE_INTERVALS, recent.length) ||
    positive.length < Math.ceil(recent.length / 3)
  ) {
    return undefined;
  }
  const sorted = [...positive].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function computeGrowth(
  points: HostMetricsHistoryPoint[],
  window_minutes: number,
): HostMetricsHistoryGrowth | undefined {
  if (points.length < 2) return undefined;
  const disk = computeGrowthRate(points, "disk_device_used_bytes");
  const sharedScratch = computeGrowthRate(points, "shared_scratch_used_bytes");
  const metadata = computeGrowthRate(points, "btrfs_metadata_used_bytes");
  if (disk == null && sharedScratch == null && metadata == null) {
    return undefined;
  }
  return {
    window_minutes,
    ...(disk != null ? { disk_used_bytes_per_hour: disk } : {}),
    ...(sharedScratch != null
      ? { shared_scratch_used_bytes_per_hour: sharedScratch }
      : {}),
    ...(metadata != null ? { metadata_used_bytes_per_hour: metadata } : {}),
  };
}

function severity(level: HostMetricsRiskLevel): number {
  switch (level) {
    case "critical":
      return 2;
    case "warning":
      return 1;
    default:
      return 0;
  }
}

function worstLevel(
  a: HostMetricsRiskLevel,
  b: HostMetricsRiskLevel,
): HostMetricsRiskLevel {
  return severity(a) >= severity(b) ? a : b;
}

function computeHoursToExhaustion(
  remainingBytes: number | undefined,
  growthBytesPerHour: number | undefined,
): number | undefined {
  if (
    remainingBytes == null ||
    growthBytesPerHour == null ||
    !Number.isFinite(remainingBytes) ||
    !Number.isFinite(growthBytesPerHour)
  ) {
    return undefined;
  }
  if (remainingBytes <= 0) return 0;
  if (growthBytesPerHour <= 0) return undefined;
  return remainingBytes / growthBytesPerHour;
}

function riskState(opts: {
  used_percent?: number;
  available_bytes?: number;
  hours_to_exhaustion?: number;
  warning_percent: number;
  critical_percent: number;
  warning_available_bytes?: number;
  critical_available_bytes?: number;
  min_used_percent_for_available_bytes?: number;
  label: string;
}): HostMetricsRiskState {
  let level: HostMetricsRiskLevel = "healthy";
  const reasons: string[] = [];
  const availableThresholdEligible =
    opts.min_used_percent_for_available_bytes == null ||
    (opts.used_percent != null &&
      Number.isFinite(opts.used_percent) &&
      opts.used_percent >= opts.min_used_percent_for_available_bytes);
  if (
    availableThresholdEligible &&
    opts.critical_available_bytes != null &&
    opts.available_bytes != null &&
    opts.available_bytes <= opts.critical_available_bytes
  ) {
    level = worstLevel(level, "critical");
    reasons.push(`${opts.label} headroom is critically low`);
  } else if (
    availableThresholdEligible &&
    opts.warning_available_bytes != null &&
    opts.available_bytes != null &&
    opts.available_bytes <= opts.warning_available_bytes
  ) {
    level = worstLevel(level, "warning");
    reasons.push(`${opts.label} headroom is low`);
  }
  if (
    opts.used_percent != null &&
    Number.isFinite(opts.used_percent) &&
    opts.used_percent >= opts.critical_percent
  ) {
    level = worstLevel(level, "critical");
    reasons.push(`${opts.label} usage is critically high`);
  } else if (
    opts.used_percent != null &&
    Number.isFinite(opts.used_percent) &&
    opts.used_percent >= opts.warning_percent
  ) {
    level = worstLevel(level, "warning");
    reasons.push(`${opts.label} usage is high`);
  }
  if (
    opts.hours_to_exhaustion != null &&
    Number.isFinite(opts.hours_to_exhaustion) &&
    opts.hours_to_exhaustion <= CRITICAL_HOURS_TO_EXHAUSTION
  ) {
    level = worstLevel(level, "critical");
    reasons.push(
      `${opts.label} could exhaust within ${CRITICAL_HOURS_TO_EXHAUSTION}h`,
    );
  } else if (
    opts.hours_to_exhaustion != null &&
    Number.isFinite(opts.hours_to_exhaustion) &&
    opts.hours_to_exhaustion <= WARNING_HOURS_TO_EXHAUSTION
  ) {
    level = worstLevel(level, "warning");
    reasons.push(
      `${opts.label} could exhaust within ${WARNING_HOURS_TO_EXHAUSTION}h`,
    );
  }
  return {
    level,
    ...(opts.used_percent != null ? { used_percent: opts.used_percent } : {}),
    ...(opts.available_bytes != null
      ? { available_bytes: opts.available_bytes }
      : {}),
    ...(opts.hours_to_exhaustion != null
      ? { hours_to_exhaustion: opts.hours_to_exhaustion }
      : {}),
    ...(reasons.length ? { reason: reasons[0] } : {}),
  };
}

function computeMetadataAvailableBytes(
  current: HostMetricsHistoryPoint,
): number | undefined {
  const allocatedAvailable =
    current.btrfs_metadata_total_bytes != null &&
    current.btrfs_metadata_used_bytes != null
      ? current.btrfs_metadata_total_bytes - current.btrfs_metadata_used_bytes
      : undefined;
  const unallocated = current.disk_unallocated_bytes;
  if (unallocated != null && Number.isFinite(unallocated)) {
    return Math.max(0, (allocatedAvailable ?? 0) + unallocated);
  }
  const conservative = current.disk_available_conservative_bytes;
  if (conservative != null && Number.isFinite(conservative)) {
    return Math.max(allocatedAvailable ?? 0, conservative);
  }
  return allocatedAvailable;
}

function metadataPercentLevel(
  used_percent: number | undefined,
  allocation_headroom_bytes: number | undefined,
): HostMetricsRiskLevel {
  if (used_percent == null || !Number.isFinite(used_percent)) {
    return "healthy";
  }
  if (
    allocation_headroom_bytes == null ||
    !Number.isFinite(allocation_headroom_bytes)
  ) {
    if (used_percent >= METADATA_CRITICAL_PERCENT) return "critical";
    if (used_percent >= METADATA_WARNING_PERCENT) return "warning";
    return "healthy";
  }
  if (
    used_percent >= METADATA_CRITICAL_PERCENT &&
    allocation_headroom_bytes <= METADATA_CRITICAL_UNALLOCATED_BYTES
  ) {
    return "critical";
  }
  if (
    used_percent >= METADATA_WARNING_PERCENT &&
    allocation_headroom_bytes <= METADATA_WARNING_UNALLOCATED_BYTES
  ) {
    return "warning";
  }
  return "healthy";
}

function computeMetadataRisk(
  current: HostMetricsHistoryPoint,
  growth?: HostMetricsHistoryGrowth,
): HostMetricsRiskState {
  const allocationHeadroom = current.disk_unallocated_bytes;
  const effectiveAvailableBytes = computeMetadataAvailableBytes(current);
  const hoursToExhaustion = computeHoursToExhaustion(
    effectiveAvailableBytes,
    growth?.metadata_used_bytes_per_hour,
  );
  let level: HostMetricsRiskLevel = "healthy";
  const reasons: string[] = [];

  if (
    effectiveAvailableBytes != null &&
    effectiveAvailableBytes <= METADATA_CRITICAL_AVAILABLE_BYTES
  ) {
    level = worstLevel(level, "critical");
    reasons.push("Metadata growth headroom is critically low");
  } else if (
    effectiveAvailableBytes != null &&
    effectiveAvailableBytes <= METADATA_WARNING_AVAILABLE_BYTES
  ) {
    level = worstLevel(level, "warning");
    reasons.push("Metadata growth headroom is low");
  }

  const percentLevel = metadataPercentLevel(
    current.metadata_used_percent,
    allocationHeadroom,
  );
  if (percentLevel === "critical") {
    level = worstLevel(level, "critical");
    reasons.push(
      "Metadata usage is critically high and device unallocated headroom is low",
    );
  } else if (percentLevel === "warning") {
    level = worstLevel(level, "warning");
    reasons.push(
      "Metadata usage is high and device unallocated headroom is getting low",
    );
  }

  if (
    hoursToExhaustion != null &&
    Number.isFinite(hoursToExhaustion) &&
    hoursToExhaustion <= CRITICAL_HOURS_TO_EXHAUSTION
  ) {
    level = worstLevel(level, "critical");
    reasons.push(
      `Metadata could exhaust within ${CRITICAL_HOURS_TO_EXHAUSTION}h`,
    );
  } else if (
    hoursToExhaustion != null &&
    Number.isFinite(hoursToExhaustion) &&
    hoursToExhaustion <= WARNING_HOURS_TO_EXHAUSTION
  ) {
    level = worstLevel(level, "warning");
    reasons.push(
      `Metadata could exhaust within ${WARNING_HOURS_TO_EXHAUSTION}h`,
    );
  }

  return {
    level,
    ...(current.metadata_used_percent != null
      ? { used_percent: current.metadata_used_percent }
      : {}),
    ...(effectiveAvailableBytes != null
      ? { available_bytes: effectiveAvailableBytes }
      : {}),
    ...(hoursToExhaustion != null
      ? { hours_to_exhaustion: hoursToExhaustion }
      : {}),
    ...(reasons.length ? { reason: reasons[0] } : {}),
  };
}

function computeDerived(
  points: HostMetricsHistoryPoint[],
  window_minutes: number,
  growth?: HostMetricsHistoryGrowth,
): HostMetricsDerived | undefined {
  const current = points[points.length - 1];
  if (!current) return undefined;
  const diskAvailableBytes = computeDiskAdmissionAvailableBytes(current);
  const diskHoursToExhaustion = computeHoursToExhaustion(
    diskAvailableBytes,
    growth?.disk_used_bytes_per_hour,
  );
  const disk = riskState({
    label: "Disk",
    used_percent: current.disk_used_percent,
    available_bytes: diskAvailableBytes,
    hours_to_exhaustion: diskHoursToExhaustion,
    warning_percent: DISK_WARNING_PERCENT,
    critical_percent: DISK_CRITICAL_PERCENT,
    warning_available_bytes: DISK_WARNING_AVAILABLE_BYTES,
    critical_available_bytes: DISK_CRITICAL_AVAILABLE_BYTES,
  });
  const metadata = computeMetadataRisk(current, growth);
  const sharedScratchHoursToExhaustion = computeHoursToExhaustion(
    current.shared_scratch_available_bytes,
    growth?.shared_scratch_used_bytes_per_hour,
  );
  const sharedScratch =
    current.shared_scratch_total_bytes != null
      ? riskState({
          label: "Shared scratch",
          used_percent: current.shared_scratch_used_percent,
          available_bytes: current.shared_scratch_available_bytes,
          hours_to_exhaustion: sharedScratchHoursToExhaustion,
          warning_percent: DISK_WARNING_PERCENT,
          critical_percent: DISK_CRITICAL_PERCENT,
          warning_available_bytes: DISK_WARNING_AVAILABLE_BYTES,
          critical_available_bytes: DISK_CRITICAL_AVAILABLE_BYTES,
          min_used_percent_for_available_bytes:
            SHARED_SCRATCH_MIN_USED_PERCENT_FOR_HEADROOM,
        })
      : undefined;
  const alerts: HostMetricsDerived["alerts"] = [];
  if (disk.level !== "healthy") {
    alerts.push({
      kind: "disk",
      level: disk.level,
      message: disk.reason ?? "disk pressure is elevated",
    });
  }
  if (metadata.level !== "healthy") {
    alerts.push({
      kind: "metadata",
      level: metadata.level,
      message: metadata.reason ?? "metadata pressure is elevated",
    });
  }
  if (sharedScratch && sharedScratch.level !== "healthy") {
    alerts.push({
      kind: "shared_scratch",
      level: sharedScratch.level,
      message: sharedScratch.reason ?? "shared scratch pressure is elevated",
    });
  }
  return {
    window_minutes,
    disk,
    ...(sharedScratch ? { shared_scratch: sharedScratch } : {}),
    metadata,
    alerts,
    admission_allowed:
      disk.level !== "critical" && metadata.level !== "critical",
    auto_grow_recommended:
      disk.level === "critical" ||
      sharedScratch?.level === "critical" ||
      (disk.level === "warning" &&
        disk.hours_to_exhaustion != null &&
        disk.hours_to_exhaustion <= 12) ||
      (sharedScratch?.level === "warning" &&
        sharedScratch.hours_to_exhaustion != null &&
        sharedScratch.hours_to_exhaustion <= 12),
  };
}

export async function ensureProjectHostMetricsSamplesSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool().query(`
        CREATE TABLE IF NOT EXISTS project_host_metrics_samples (
          host_id UUID NOT NULL REFERENCES project_hosts(id) ON DELETE CASCADE,
          collected_at TIMESTAMPTZ NOT NULL,
          cpu_percent DOUBLE PRECISION,
          load_1 DOUBLE PRECISION,
          load_5 DOUBLE PRECISION,
          load_15 DOUBLE PRECISION,
          memory_total_bytes BIGINT,
          memory_used_bytes BIGINT,
          memory_available_bytes BIGINT,
          memory_used_percent DOUBLE PRECISION,
          swap_total_bytes BIGINT,
          swap_used_bytes BIGINT,
          root_disk_total_bytes BIGINT,
          root_disk_used_bytes BIGINT,
          root_disk_available_bytes BIGINT,
          root_disk_used_percent DOUBLE PRECISION,
          disk_device_total_bytes BIGINT,
          disk_device_used_bytes BIGINT,
          disk_unallocated_bytes BIGINT,
          shared_scratch_total_bytes BIGINT,
          shared_scratch_used_bytes BIGINT,
          shared_scratch_available_bytes BIGINT,
          btrfs_data_total_bytes BIGINT,
          btrfs_data_used_bytes BIGINT,
          btrfs_metadata_total_bytes BIGINT,
          btrfs_metadata_used_bytes BIGINT,
          btrfs_system_total_bytes BIGINT,
          btrfs_system_used_bytes BIGINT,
          btrfs_global_reserve_total_bytes BIGINT,
          btrfs_global_reserve_used_bytes BIGINT,
          disk_available_conservative_bytes BIGINT,
          disk_available_for_admission_bytes BIGINT,
          reservation_bytes BIGINT,
          assigned_project_count INTEGER,
          running_project_count INTEGER,
          starting_project_count INTEGER,
          stopping_project_count INTEGER,
          io_containment JSONB,
          conat_persist JSONB,
          storage_pressure_state TEXT,
          storage_admission_mode TEXT,
          storage_pressure_sample_failed BOOLEAN,
          PRIMARY KEY (host_id, collected_at)
        )
      `);
      await pool().query(
        "CREATE INDEX IF NOT EXISTS project_host_metrics_samples_host_time_idx ON project_host_metrics_samples(host_id, collected_at DESC)",
      );
      await pool().query(
        "ALTER TABLE project_host_metrics_samples ADD COLUMN IF NOT EXISTS shared_scratch_total_bytes BIGINT",
      );
      await pool().query(
        "ALTER TABLE project_host_metrics_samples ADD COLUMN IF NOT EXISTS shared_scratch_used_bytes BIGINT",
      );
      await pool().query(
        "ALTER TABLE project_host_metrics_samples ADD COLUMN IF NOT EXISTS shared_scratch_available_bytes BIGINT",
      );
      await pool().query(
        "ALTER TABLE project_host_metrics_samples ADD COLUMN IF NOT EXISTS io_containment JSONB",
      );
      await pool().query(
        "ALTER TABLE project_host_metrics_samples ADD COLUMN IF NOT EXISTS conat_persist JSONB",
      );
      await pool().query(
        "ALTER TABLE project_host_metrics_samples ADD COLUMN IF NOT EXISTS root_disk_total_bytes BIGINT",
      );
      await pool().query(
        "ALTER TABLE project_host_metrics_samples ADD COLUMN IF NOT EXISTS root_disk_used_bytes BIGINT",
      );
      await pool().query(
        "ALTER TABLE project_host_metrics_samples ADD COLUMN IF NOT EXISTS root_disk_available_bytes BIGINT",
      );
      await pool().query(
        "ALTER TABLE project_host_metrics_samples ADD COLUMN IF NOT EXISTS root_disk_used_percent DOUBLE PRECISION",
      );
      await pool().query(
        "ALTER TABLE project_host_metrics_samples ADD COLUMN IF NOT EXISTS storage_pressure_state TEXT",
      );
      await pool().query(
        "ALTER TABLE project_host_metrics_samples ADD COLUMN IF NOT EXISTS storage_admission_mode TEXT",
      );
      await pool().query(
        "ALTER TABLE project_host_metrics_samples ADD COLUMN IF NOT EXISTS storage_pressure_sample_failed BOOLEAN",
      );
    })().catch((err) => {
      schemaReady = undefined;
      throw err;
    });
  }
  await schemaReady;
}

export async function recordProjectHostMetricsSample({
  host_id,
  metrics,
}: {
  host_id: string;
  metrics?: HostCurrentMetrics | null;
}): Promise<void> {
  if (!host_id || !metrics) return;
  await ensureProjectHostMetricsSamplesSchema();
  const collected_at =
    metrics.collected_at && Number.isFinite(Date.parse(metrics.collected_at))
      ? new Date(metrics.collected_at)
      : new Date();
  await pool().query(
    `
      INSERT INTO project_host_metrics_samples (
        host_id,
        collected_at,
        cpu_percent,
        load_1,
        load_5,
        load_15,
        memory_total_bytes,
        memory_used_bytes,
        memory_available_bytes,
        memory_used_percent,
        swap_total_bytes,
        swap_used_bytes,
        root_disk_total_bytes,
        root_disk_used_bytes,
        root_disk_available_bytes,
        root_disk_used_percent,
        disk_device_total_bytes,
        disk_device_used_bytes,
        disk_unallocated_bytes,
        shared_scratch_total_bytes,
        shared_scratch_used_bytes,
        shared_scratch_available_bytes,
        btrfs_data_total_bytes,
        btrfs_data_used_bytes,
        btrfs_metadata_total_bytes,
        btrfs_metadata_used_bytes,
        btrfs_system_total_bytes,
        btrfs_system_used_bytes,
        btrfs_global_reserve_total_bytes,
        btrfs_global_reserve_used_bytes,
        disk_available_conservative_bytes,
        disk_available_for_admission_bytes,
        reservation_bytes,
        assigned_project_count,
        running_project_count,
        starting_project_count,
        stopping_project_count,
        io_containment,
        conat_persist,
        storage_pressure_state,
        storage_admission_mode,
        storage_pressure_sample_failed
      )
      SELECT
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42
      WHERE NOT EXISTS (
        SELECT 1
        FROM project_host_metrics_samples
        WHERE host_id = $1
          AND collected_at >= $2::timestamptz - ($43::bigint * INTERVAL '1 millisecond')
      )
    `,
    [
      host_id,
      collected_at,
      metrics.cpu_percent ?? null,
      metrics.load_1 ?? null,
      metrics.load_5 ?? null,
      metrics.load_15 ?? null,
      metrics.memory_total_bytes ?? null,
      metrics.memory_used_bytes ?? null,
      metrics.memory_available_bytes ?? null,
      metrics.memory_used_percent ?? null,
      metrics.swap_total_bytes ?? null,
      metrics.swap_used_bytes ?? null,
      metrics.root_disk_total_bytes ?? null,
      metrics.root_disk_used_bytes ?? null,
      metrics.root_disk_available_bytes ?? null,
      metrics.root_disk_used_percent ?? null,
      metrics.disk_device_total_bytes ?? null,
      metrics.disk_device_used_bytes ?? null,
      metrics.disk_unallocated_bytes ?? null,
      metrics.shared_scratch_total_bytes ?? null,
      metrics.shared_scratch_used_bytes ?? null,
      metrics.shared_scratch_available_bytes ?? null,
      metrics.btrfs_data_total_bytes ?? null,
      metrics.btrfs_data_used_bytes ?? null,
      metrics.btrfs_metadata_total_bytes ?? null,
      metrics.btrfs_metadata_used_bytes ?? null,
      metrics.btrfs_system_total_bytes ?? null,
      metrics.btrfs_system_used_bytes ?? null,
      metrics.btrfs_global_reserve_total_bytes ?? null,
      metrics.btrfs_global_reserve_used_bytes ?? null,
      metrics.disk_available_conservative_bytes ?? null,
      metrics.disk_available_for_admission_bytes ?? null,
      metrics.reservation_bytes ?? null,
      metrics.assigned_project_count ?? null,
      metrics.running_project_count ?? null,
      metrics.starting_project_count ?? null,
      metrics.stopping_project_count ?? null,
      metrics.io_containment ?? null,
      metrics.conat_persist ?? null,
      metrics.storage_admission?.pressure_state ?? null,
      metrics.storage_admission?.mode ?? null,
      metrics.storage_admission == null
        ? null
        : metrics.storage_admission.sample_error != null,
      SAMPLE_INTERVAL_MS,
    ],
  );
}

export interface ProjectHostStoragePressureWindow {
  host_id: string;
  host_name: string;
  latest_sample_at: string | null;
  latest_valid_sample_at: string | null;
  sample_count: number;
  sampled_seconds: number;
  normal_seconds: number;
  contended_seconds: number;
  emergency_seconds: number;
  recovery_seconds: number;
  unavailable_seconds: number;
}

export async function getProjectHostStoragePressureWindows({
  bay_id,
}: {
  bay_id: string;
}): Promise<ProjectHostStoragePressureWindow[]> {
  await ensureProjectHostMetricsSamplesSchema();
  const { rows } = await pool().query<{
    host_id: string;
    host_name: string;
    latest_sample_at: Date | string | null;
    latest_valid_sample_at: Date | string | null;
    sample_count: string | number;
    sampled_seconds: string | number;
    normal_seconds: string | number;
    contended_seconds: string | number;
    emergency_seconds: string | number;
    recovery_seconds: string | number;
    unavailable_seconds: string | number;
  }>(
    `WITH relevant_hosts AS (
       SELECT h.id, h.name
       FROM project_hosts h
       WHERE h.bay_id = $1
         AND h.deleted IS NULL
         AND EXISTS (
           SELECT 1 FROM projects p
           WHERE p.host_id = h.id AND p.deleted IS NULL AND p.provisioned
         )
     ), ordered AS (
       SELECT s.host_id, s.collected_at,
              s.storage_pressure_state, s.storage_admission_mode,
              s.storage_pressure_sample_failed,
              lead(s.collected_at) OVER (
                PARTITION BY s.host_id ORDER BY s.collected_at
              ) AS next_at
       FROM project_host_metrics_samples s
       JOIN relevant_hosts h ON h.id = s.host_id
       WHERE s.collected_at >= now() - interval '24 hours'
     ), spans AS (
       SELECT host_id, collected_at,
              CASE
                WHEN storage_pressure_sample_failed IS TRUE
                  OR storage_admission_mode NOT IN ('observe', 'enforce')
                  OR storage_admission_mode IS NULL
                  OR storage_pressure_state NOT IN
                    ('normal', 'contended', 'emergency', 'recovery')
                  OR storage_pressure_state IS NULL
                THEN 'unavailable'
                ELSE storage_pressure_state
              END AS pressure_state,
              least(180, greatest(0,
                extract(epoch FROM least(coalesce(next_at, now()), now()) - collected_at)
              )) AS span_seconds
       FROM ordered
     )
     SELECT h.id AS host_id, h.name AS host_name,
            max(s.collected_at) AS latest_sample_at,
            max(s.collected_at) FILTER
              (WHERE s.pressure_state <> 'unavailable') AS latest_valid_sample_at,
            count(s.collected_at) AS sample_count,
            coalesce(sum(s.span_seconds), 0) AS sampled_seconds,
            coalesce(sum(s.span_seconds) FILTER (WHERE s.pressure_state = 'normal'), 0) AS normal_seconds,
            coalesce(sum(s.span_seconds) FILTER (WHERE s.pressure_state = 'contended'), 0) AS contended_seconds,
            coalesce(sum(s.span_seconds) FILTER (WHERE s.pressure_state = 'emergency'), 0) AS emergency_seconds,
            coalesce(sum(s.span_seconds) FILTER (WHERE s.pressure_state = 'recovery'), 0) AS recovery_seconds,
            coalesce(sum(s.span_seconds) FILTER (WHERE s.pressure_state = 'unavailable'), 0) AS unavailable_seconds
       FROM relevant_hosts h
       LEFT JOIN spans s ON s.host_id = h.id
      GROUP BY h.id, h.name
      ORDER BY h.name`,
    [bay_id],
  );
  return rows.map((row) => ({
    host_id: row.host_id,
    host_name: row.host_name,
    latest_sample_at: row.latest_sample_at
      ? new Date(row.latest_sample_at).toISOString()
      : null,
    latest_valid_sample_at: row.latest_valid_sample_at
      ? new Date(row.latest_valid_sample_at).toISOString()
      : null,
    sample_count: Number(row.sample_count),
    sampled_seconds: Number(row.sampled_seconds),
    normal_seconds: Number(row.normal_seconds),
    contended_seconds: Number(row.contended_seconds),
    emergency_seconds: Number(row.emergency_seconds),
    recovery_seconds: Number(row.recovery_seconds),
    unavailable_seconds: Number(row.unavailable_seconds),
  }));
}

export async function clearProjectHostMetrics({
  host_id,
}: {
  host_id: string;
}): Promise<void> {
  if (!host_id) return;
  await ensureProjectHostMetricsSamplesSchema();
  await pool().query(
    `
      DELETE FROM project_host_metrics_samples
      WHERE host_id = $1
    `,
    [host_id],
  );
}

export async function pruneProjectHostMetricsSamples({
  before = new Date(Date.now() - DEFAULT_RETENTION_MINUTES * 60_000),
  limit = DEFAULT_PRUNE_LIMIT,
}: {
  before?: Date;
  limit?: number;
} = {}): Promise<number> {
  await ensureProjectHostMetricsSamplesSchema();
  const boundedLimit = Math.max(
    1,
    Math.min(100_000, Math.floor(Number(limit) || DEFAULT_PRUNE_LIMIT)),
  );
  const result = await pool().query(
    `
      WITH expired AS (
        SELECT ctid
        FROM project_host_metrics_samples
        WHERE collected_at < $1
        LIMIT $2
      )
      DELETE FROM project_host_metrics_samples AS samples
      USING expired
      WHERE samples.ctid = expired.ctid
    `,
    [before, boundedLimit],
  );
  return result.rowCount ?? 0;
}

export async function loadProjectHostMetricsHistory({
  host_ids,
  window_minutes,
  max_points,
}: {
  host_ids: string[];
  window_minutes?: number;
  max_points?: number;
}): Promise<Map<string, HostMetricsHistory>> {
  const hostIds = [...new Set(host_ids.filter(Boolean))];
  if (!hostIds.length) return new Map();
  await ensureProjectHostMetricsSamplesSchema();
  const windowMinutes = normalizeWindowMinutes(window_minutes);
  const maxPoints = normalizeMaxPoints(max_points);
  const { rows } = await pool().query<ProjectHostMetricsSampleRow>(
    `
      SELECT *
      FROM project_host_metrics_samples
      WHERE host_id = ANY($1)
        AND collected_at >= now() - ($2::int * INTERVAL '1 minute')
      ORDER BY host_id ASC, collected_at ASC
    `,
    [hostIds, windowMinutes],
  );
  const grouped = new Map<string, HostMetricsHistoryPoint[]>();
  for (const row of rows) {
    const points = grouped.get(row.host_id) ?? [];
    points.push(toPoint(row));
    grouped.set(row.host_id, points);
  }
  const result = new Map<string, HostMetricsHistory>();
  for (const host_id of hostIds) {
    const allPoints = grouped.get(host_id) ?? [];
    const points = compactPoints(allPoints, maxPoints);
    const growth = computeGrowth(allPoints, windowMinutes);
    result.set(host_id, {
      window_minutes: windowMinutes,
      point_count: allPoints.length,
      points,
      growth,
      derived: computeDerived(allPoints, windowMinutes, growth),
    });
  }
  return result;
}
