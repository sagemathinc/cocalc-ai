import getPool from "@cocalc/database/pool";
import type {
  HostCurrentMetrics,
  HostMetricsHistory,
  HostMetricsHistoryGrowth,
  HostMetricsHistoryPoint,
} from "@cocalc/conat/hub/api/hosts";
import type { Pool } from "pg";

const SAMPLE_INTERVAL_MS = 60_000;
const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_MAX_POINTS = 60;
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
  disk_device_total_bytes: number | string | null;
  disk_device_used_bytes: number | string | null;
  disk_unallocated_bytes: number | string | null;
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
};

function pool(): Pool {
  return getPool();
}

function toFloat(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function toInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.floor(parsed));
}

function normalizeWindowMinutes(value?: number): number {
  const parsed = Number(value ?? DEFAULT_WINDOW_MINUTES);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WINDOW_MINUTES;
  }
  return Math.min(7 * 24 * 60, Math.max(5, Math.floor(parsed)));
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

function computeDiskUsedPercent(point: HostCurrentMetrics): number | undefined {
  const total = point.disk_device_total_bytes;
  const available = point.disk_available_conservative_bytes;
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
    disk_device_total_bytes: toInteger(row.disk_device_total_bytes),
    disk_device_used_bytes: toInteger(row.disk_device_used_bytes),
    disk_unallocated_bytes: toInteger(row.disk_unallocated_bytes),
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
  };
  point.disk_used_percent = computeDiskUsedPercent(point);
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
  const first = points[0];
  const last = points[points.length - 1];
  const firstAt = Date.parse(first.collected_at ?? "");
  const lastAt = Date.parse(last.collected_at ?? "");
  if (
    !Number.isFinite(firstAt) ||
    !Number.isFinite(lastAt) ||
    lastAt <= firstAt
  ) {
    return undefined;
  }
  const firstValue = toFloat(first[field]);
  const lastValue = toFloat(last[field]);
  if (firstValue == null || lastValue == null) return undefined;
  const hours = (lastAt - firstAt) / (60 * 60 * 1000);
  if (!(hours > 0)) return undefined;
  return (lastValue - firstValue) / hours;
}

function computeGrowth(
  points: HostMetricsHistoryPoint[],
  window_minutes: number,
): HostMetricsHistoryGrowth | undefined {
  if (points.length < 2) return undefined;
  const disk = computeGrowthRate(points, "disk_device_used_bytes");
  const metadata = computeGrowthRate(points, "btrfs_metadata_used_bytes");
  if (disk == null && metadata == null) return undefined;
  return {
    window_minutes,
    ...(disk != null ? { disk_used_bytes_per_hour: disk } : {}),
    ...(metadata != null ? { metadata_used_bytes_per_hour: metadata } : {}),
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
          disk_device_total_bytes BIGINT,
          disk_device_used_bytes BIGINT,
          disk_unallocated_bytes BIGINT,
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
          PRIMARY KEY (host_id, collected_at)
        )
      `);
      await pool().query(
        "CREATE INDEX IF NOT EXISTS project_host_metrics_samples_host_time_idx ON project_host_metrics_samples(host_id, collected_at DESC)",
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
        disk_device_total_bytes,
        disk_device_used_bytes,
        disk_unallocated_bytes,
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
        stopping_project_count
      )
      SELECT
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30
      WHERE NOT EXISTS (
        SELECT 1
        FROM project_host_metrics_samples
        WHERE host_id = $1
          AND collected_at >= $2::timestamptz - ($31::bigint * INTERVAL '1 millisecond')
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
      metrics.disk_device_total_bytes ?? null,
      metrics.disk_device_used_bytes ?? null,
      metrics.disk_unallocated_bytes ?? null,
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
      SAMPLE_INTERVAL_MS,
    ],
  );
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
    result.set(host_id, {
      window_minutes: windowMinutes,
      point_count: allPoints.length,
      points,
      growth: computeGrowth(allPoints, windowMinutes),
    });
  }
  return result;
}
