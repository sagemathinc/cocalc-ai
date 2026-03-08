/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  AppMetricsBucket,
  AppMetricsSummary,
} from "@cocalc/conat/project/api/apps";
import type { AppProxyExposureMode } from "@cocalc/backend/auth/app-proxy";

interface PersistedAppMetrics {
  last_hit_ms?: number;
  totals: {
    requests: number;
    bytes_sent: number;
    bytes_received: number;
    public_requests: number;
    private_requests: number;
    public_bytes_sent: number;
    private_bytes_sent: number;
    status_2xx: number;
    status_3xx: number;
    status_4xx: number;
    status_5xx: number;
    websocket_upgrades: number;
    wake_count: number;
    latency_count: number;
    latency_sum_ms: number;
    latency_max_ms: number;
    latency_histogram: number[];
  };
  history: AppMetricsBucket[];
}

interface MetricsStateV1 {
  version: 1;
  updated_at_ms: number;
  apps: Record<string, PersistedAppMetrics>;
}

const HISTORY_BUCKET_MS = 60_000;
const MAX_BUCKETS = 240;
const HISTOGRAM_BOUNDS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000];

const DEFAULT_STATE: MetricsStateV1 = {
  version: 1,
  updated_at_ms: 0,
  apps: {},
};

let loaded = false;
let flushTimer: NodeJS.Timeout | undefined;
let exitHooksInstalled = false;
let state: MetricsStateV1 = { ...DEFAULT_STATE, apps: {} };
const activeWebsocketCounts = new Map<string, number>();

function appsDir(): string {
  const home = process.env.HOME ?? ".";
  return join(home, ".local", "share", "cocalc", "apps");
}

function metricsStatePath(): string {
  return join(appsDir(), "metrics-state.json");
}

function defaultAppMetrics(): PersistedAppMetrics {
  return {
    totals: {
      requests: 0,
      bytes_sent: 0,
      bytes_received: 0,
      public_requests: 0,
      private_requests: 0,
      public_bytes_sent: 0,
      private_bytes_sent: 0,
      status_2xx: 0,
      status_3xx: 0,
      status_4xx: 0,
      status_5xx: 0,
      websocket_upgrades: 0,
      wake_count: 0,
      latency_count: 0,
      latency_sum_ms: 0,
      latency_max_ms: 0,
      latency_histogram: new Array(HISTOGRAM_BOUNDS_MS.length + 1).fill(0),
    },
    history: [],
  };
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  mkdirSync(appsDir(), { recursive: true });
  try {
    const raw = readFileSync(metricsStatePath(), "utf8");
    const parsed = JSON.parse(raw) as MetricsStateV1;
    if (parsed?.version === 1 && parsed.apps && typeof parsed.apps === "object") {
      state = {
        version: 1,
        updated_at_ms: Number(parsed.updated_at_ms) || 0,
        apps: {},
      };
      for (const [app_id, value] of Object.entries(parsed.apps)) {
        const existing = defaultAppMetrics();
        const totalsIn = (value as any)?.totals ?? {};
        const histIn = Array.isArray(totalsIn.latency_histogram)
          ? totalsIn.latency_histogram
          : [];
        existing.last_hit_ms = Number((value as any)?.last_hit_ms) || undefined;
        existing.totals = {
          ...existing.totals,
          ...totalsIn,
          latency_histogram: new Array(HISTOGRAM_BOUNDS_MS.length + 1)
            .fill(0)
            .map((_, idx) => Number(histIn[idx]) || 0),
        };
        existing.history = Array.isArray((value as any)?.history)
          ? (value as any).history
              .map((row: any) => ({
                minute_start_ms: Number(row?.minute_start_ms) || 0,
                requests: Number(row?.requests) || 0,
                bytes_sent: Number(row?.bytes_sent) || 0,
                bytes_received: Number(row?.bytes_received) || 0,
                public_requests: Number(row?.public_requests) || 0,
                private_requests: Number(row?.private_requests) || 0,
                websocket_upgrades: Number(row?.websocket_upgrades) || 0,
              }))
              .filter((row: AppMetricsBucket) => row.minute_start_ms > 0)
          : [];
        state.apps[app_id] = existing;
      }
    }
  } catch {
    state = { ...DEFAULT_STATE, apps: {} };
  }
  installExitHooks();
}

function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  const flush = () => {
    try {
      flushNow();
    } catch {
      // ignore best-effort flush failures on exit
    }
  };
  process.once("beforeExit", flush);
  process.once("exit", flush);
}

function scheduleFlush(): void {
  ensureLoaded();
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flushNow();
  }, 2000);
  flushTimer.unref?.();
}

function flushNow(): void {
  ensureLoaded();
  mkdirSync(appsDir(), { recursive: true });
  const path = metricsStatePath();
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const payload: MetricsStateV1 = {
    ...state,
    version: 1,
    updated_at_ms: Date.now(),
  };
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function appMetrics(app_id: string): PersistedAppMetrics {
  ensureLoaded();
  if (!state.apps[app_id]) {
    state.apps[app_id] = defaultAppMetrics();
  }
  return state.apps[app_id];
}

function currentMinuteStart(now = Date.now()): number {
  return Math.floor(now / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
}

function historyBucket(metrics: PersistedAppMetrics, minute_start_ms: number): AppMetricsBucket {
  const last = metrics.history[metrics.history.length - 1];
  if (last?.minute_start_ms === minute_start_ms) {
    return last;
  }
  const next: AppMetricsBucket = {
    minute_start_ms,
    requests: 0,
    bytes_sent: 0,
    bytes_received: 0,
    public_requests: 0,
    private_requests: 0,
    websocket_upgrades: 0,
  };
  metrics.history.push(next);
  if (metrics.history.length > MAX_BUCKETS) {
    metrics.history.splice(0, metrics.history.length - MAX_BUCKETS);
  }
  return next;
}

function recordLatencyHistogram(target: number[], duration_ms: number): void {
  const duration = Math.max(0, Math.round(duration_ms));
  let idx = HISTOGRAM_BOUNDS_MS.findIndex((bound) => duration <= bound);
  if (idx === -1) idx = target.length - 1;
  target[idx] = (target[idx] ?? 0) + 1;
}

function percentileFromHistogram(
  histogram: number[],
  percentile: number,
): number | undefined {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (total <= 0) return;
  const wanted = Math.ceil(total * percentile);
  let seen = 0;
  for (let i = 0; i < histogram.length; i += 1) {
    seen += histogram[i] ?? 0;
    if (seen >= wanted) {
      return HISTOGRAM_BOUNDS_MS[i] ?? HISTOGRAM_BOUNDS_MS[HISTOGRAM_BOUNDS_MS.length - 1];
    }
  }
  return HISTOGRAM_BOUNDS_MS[HISTOGRAM_BOUNDS_MS.length - 1];
}

function filterHistory(
  history: AppMetricsBucket[],
  minutes: number,
): AppMetricsBucket[] {
  const now = Date.now();
  const cutoff = now - Math.max(1, minutes) * HISTORY_BUCKET_MS;
  return history.filter((row) => row.minute_start_ms >= cutoff);
}

export function recordAppHttpMetric({
  app_id,
  exposure_mode,
  status_code,
  bytes_sent,
  bytes_received,
  duration_ms,
}: {
  app_id: string;
  exposure_mode: AppProxyExposureMode;
  status_code: number;
  bytes_sent: number;
  bytes_received: number;
  duration_ms: number;
}): void {
  const metrics = appMetrics(app_id);
  const now = Date.now();
  metrics.last_hit_ms = now;
  metrics.totals.requests += 1;
  metrics.totals.bytes_sent += Math.max(0, bytes_sent);
  metrics.totals.bytes_received += Math.max(0, bytes_received);
  if (exposure_mode === "public") {
    metrics.totals.public_requests += 1;
    metrics.totals.public_bytes_sent += Math.max(0, bytes_sent);
  } else {
    metrics.totals.private_requests += 1;
    metrics.totals.private_bytes_sent += Math.max(0, bytes_sent);
  }
  if (status_code >= 500) metrics.totals.status_5xx += 1;
  else if (status_code >= 400) metrics.totals.status_4xx += 1;
  else if (status_code >= 300) metrics.totals.status_3xx += 1;
  else metrics.totals.status_2xx += 1;
  metrics.totals.latency_count += 1;
  metrics.totals.latency_sum_ms += Math.max(0, duration_ms);
  metrics.totals.latency_max_ms = Math.max(
    metrics.totals.latency_max_ms,
    Math.max(0, duration_ms),
  );
  recordLatencyHistogram(metrics.totals.latency_histogram, duration_ms);

  const bucket = historyBucket(metrics, currentMinuteStart(now));
  bucket.requests += 1;
  bucket.bytes_sent += Math.max(0, bytes_sent);
  bucket.bytes_received += Math.max(0, bytes_received);
  if (exposure_mode === "public") bucket.public_requests += 1;
  else bucket.private_requests += 1;
  scheduleFlush();
}

export function recordAppWebsocketOpened({
  app_id,
}: {
  app_id: string;
}): void {
  const metrics = appMetrics(app_id);
  const now = Date.now();
  metrics.last_hit_ms = now;
  metrics.totals.websocket_upgrades += 1;
  const bucket = historyBucket(metrics, currentMinuteStart(now));
  bucket.websocket_upgrades += 1;
  activeWebsocketCounts.set(app_id, (activeWebsocketCounts.get(app_id) ?? 0) + 1);
  scheduleFlush();
}

export function recordAppWebsocketClosed(app_id: string): void {
  const current = activeWebsocketCounts.get(app_id) ?? 0;
  if (current <= 1) {
    activeWebsocketCounts.delete(app_id);
  } else {
    activeWebsocketCounts.set(app_id, current - 1);
  }
}

export function recordAppWake(app_id: string): void {
  const metrics = appMetrics(app_id);
  metrics.totals.wake_count += 1;
  scheduleFlush();
}

export function getAppMetrics(
  app_id: string,
  { minutes = 60 }: { minutes?: number } = {},
): AppMetricsSummary {
  const metrics = appMetrics(app_id);
  return {
    app_id,
    active_websockets: activeWebsocketCounts.get(app_id) ?? 0,
    last_hit_ms: metrics.last_hit_ms,
    totals: {
      ...metrics.totals,
      p50_ms: percentileFromHistogram(metrics.totals.latency_histogram, 0.5),
      p95_ms: percentileFromHistogram(metrics.totals.latency_histogram, 0.95),
    },
    history: filterHistory(metrics.history, minutes),
  };
}

export function listAppMetrics(
  { minutes = 60 }: { minutes?: number } = {},
): AppMetricsSummary[] {
  ensureLoaded();
  return Object.keys(state.apps)
    .sort()
    .map((app_id) => getAppMetrics(app_id, { minutes }));
}

export function deleteAppMetrics(app_id: string): void {
  ensureLoaded();
  if (state.apps[app_id] == null) return;
  delete state.apps[app_id];
  activeWebsocketCounts.delete(app_id);
  scheduleFlush();
}
