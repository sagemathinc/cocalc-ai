/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type {
  ProjectStorageHistory,
  ProjectStorageHistoryGrowth,
  ProjectStorageHistoryPoint,
  ProjectStorageOverview,
} from "@cocalc/conat/hub/api/projects";
import type { Pool } from "pg";

const SAMPLE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_WINDOW_MINUTES = 24 * 60;
const DEFAULT_MAX_POINTS = 96;
let schemaReady: Promise<void> | undefined;

type ProjectStorageHistorySampleRow = {
  project_id: string;
  collected_at: Date | string;
  quota_used_bytes: number | string | null;
  quota_size_bytes: number | string | null;
  home_visible_bytes: number | string | null;
  scratch_visible_bytes: number | string | null;
  environment_visible_bytes: number | string | null;
  snapshot_counted_bytes: number | string | null;
};

function pool(): Pool {
  return getPool();
}

function toInteger(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.floor(parsed));
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
  return Math.max(0, Math.min(100, (100 * numerator) / denominator));
}

function normalizeWindowMinutes(value?: number): number {
  const parsed = Number(value ?? DEFAULT_WINDOW_MINUTES);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WINDOW_MINUTES;
  }
  return Math.min(30 * 24 * 60, Math.max(60, Math.floor(parsed)));
}

function normalizeMaxPoints(value?: number): number {
  const parsed = Number(value ?? DEFAULT_MAX_POINTS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_POINTS;
  }
  return Math.min(1440, Math.max(24, Math.floor(parsed)));
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

function toPoint(
  row: ProjectStorageHistorySampleRow,
): ProjectStorageHistoryPoint {
  const quota_used_bytes = toInteger(row.quota_used_bytes);
  const quota_size_bytes = toInteger(row.quota_size_bytes);
  return {
    collected_at: new Date(row.collected_at).toISOString(),
    quota_used_bytes,
    quota_size_bytes,
    quota_used_percent: computePercent(quota_used_bytes, quota_size_bytes),
    home_visible_bytes: toInteger(row.home_visible_bytes),
    scratch_visible_bytes: toInteger(row.scratch_visible_bytes),
    environment_visible_bytes: toInteger(row.environment_visible_bytes),
    snapshot_counted_bytes: toInteger(row.snapshot_counted_bytes),
  };
}

function computeGrowth(
  points: ProjectStorageHistoryPoint[],
  window_minutes: number,
): ProjectStorageHistoryGrowth | undefined {
  const defined = points.filter(
    (point) =>
      point.quota_used_bytes != null &&
      Number.isFinite(point.quota_used_bytes) &&
      point.collected_at,
  );
  if (defined.length < 2) return undefined;
  const first = defined[0];
  const last = defined[defined.length - 1];
  const firstAt = Date.parse(first.collected_at);
  const lastAt = Date.parse(last.collected_at);
  if (
    !Number.isFinite(firstAt) ||
    !Number.isFinite(lastAt) ||
    lastAt <= firstAt
  ) {
    return undefined;
  }
  const hours = (lastAt - firstAt) / (60 * 60 * 1000);
  if (!(hours > 0)) return undefined;
  return {
    window_minutes,
    quota_used_bytes_per_hour:
      ((last.quota_used_bytes ?? 0) - (first.quota_used_bytes ?? 0)) / hours,
  };
}

function valueForKey(
  overview: ProjectStorageOverview,
  key: "home" | "scratch" | "environment",
): number | null {
  return (
    overview.visible.find((bucket) => bucket.key === key)?.summaryBytes ?? null
  );
}

export async function ensureProjectStorageHistorySamplesSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool().query(`
        CREATE TABLE IF NOT EXISTS project_storage_history_samples (
          project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
          collected_at TIMESTAMPTZ NOT NULL,
          quota_used_bytes BIGINT,
          quota_size_bytes BIGINT,
          home_visible_bytes BIGINT,
          scratch_visible_bytes BIGINT,
          environment_visible_bytes BIGINT,
          snapshot_counted_bytes BIGINT,
          PRIMARY KEY (project_id, collected_at)
        )
      `);
      await pool().query(
        "CREATE INDEX IF NOT EXISTS project_storage_history_samples_project_time_idx ON project_storage_history_samples(project_id, collected_at DESC)",
      );
    })().catch((err) => {
      schemaReady = undefined;
      throw err;
    });
  }
  await schemaReady;
}

export async function recordProjectStorageHistorySample({
  project_id,
  overview,
}: {
  project_id: string;
  overview?: ProjectStorageOverview | null;
}): Promise<void> {
  if (!project_id || !overview) return;
  await ensureProjectStorageHistorySamplesSchema();
  const quota = overview.quotas.find((entry) => entry.key === "project");
  const collected_at =
    overview.collected_at && Number.isFinite(Date.parse(overview.collected_at))
      ? new Date(overview.collected_at)
      : new Date();
  const snapshotBytes =
    overview.counted.find((entry) => entry.key === "snapshots")?.bytes ?? null;
  await pool().query(
    `
      INSERT INTO project_storage_history_samples (
        project_id,
        collected_at,
        quota_used_bytes,
        quota_size_bytes,
        home_visible_bytes,
        scratch_visible_bytes,
        environment_visible_bytes,
        snapshot_counted_bytes
      )
      SELECT
        $1,$2,$3,$4,$5,$6,$7,$8
      WHERE NOT EXISTS (
        SELECT 1
        FROM project_storage_history_samples
        WHERE project_id = $1
          AND collected_at >= $2::timestamptz - ($9::bigint * INTERVAL '1 millisecond')
      )
    `,
    [
      project_id,
      collected_at,
      quota?.used ?? null,
      quota?.size ?? null,
      valueForKey(overview, "home"),
      valueForKey(overview, "scratch"),
      valueForKey(overview, "environment"),
      snapshotBytes,
      SAMPLE_INTERVAL_MS,
    ],
  );
}

export async function clearProjectStorageHistory({
  project_id,
}: {
  project_id: string;
}): Promise<void> {
  if (!project_id) return;
  await ensureProjectStorageHistorySamplesSchema();
  await pool().query(
    `
      DELETE FROM project_storage_history_samples
      WHERE project_id = $1
    `,
    [project_id],
  );
}

export async function loadProjectStorageHistory({
  project_id,
  window_minutes,
  max_points,
}: {
  project_id: string;
  window_minutes?: number;
  max_points?: number;
}): Promise<ProjectStorageHistory> {
  const windowMinutes = normalizeWindowMinutes(window_minutes);
  const maxPoints = normalizeMaxPoints(max_points);
  if (!project_id) {
    return {
      window_minutes: windowMinutes,
      point_count: 0,
      points: [],
    };
  }
  await ensureProjectStorageHistorySamplesSchema();
  const { rows } = await pool().query<ProjectStorageHistorySampleRow>(
    `
      SELECT *
      FROM project_storage_history_samples
      WHERE project_id = $1
        AND collected_at >= now() - ($2::int * INTERVAL '1 minute')
      ORDER BY collected_at ASC
    `,
    [project_id, windowMinutes],
  );
  const allPoints = rows.map(toPoint);
  const points = compactPoints(allPoints, maxPoints);
  const growth = computeGrowth(allPoints, windowMinutes);
  return {
    window_minutes: windowMinutes,
    point_count: allPoints.length,
    points,
    ...(growth ? { growth } : {}),
  };
}
