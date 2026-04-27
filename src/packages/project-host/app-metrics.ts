/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import { getMountPoint } from "./file-server";
import type { AppProxyExposureMode } from "@cocalc/backend/auth/app-proxy";

const logger = getLogger("project-host:app-metrics");

const HISTORY_BUCKET_MS = 60_000;
const MAX_BUCKETS = 240;

interface HostAppMetricsBucket {
  minute_start_ms: number;
  websocket_bytes_sent: number;
}

interface HostPersistedAppMetrics {
  last_hit_ms?: number;
  totals: {
    websocket_bytes_sent: number;
    public_websocket_bytes_sent: number;
    private_websocket_bytes_sent: number;
  };
  history: HostAppMetricsBucket[];
}

interface HostMetricsStateV1 {
  version: 1;
  updated_at_ms: number;
  apps: Record<string, HostPersistedAppMetrics>;
}

const DEFAULT_STATE: HostMetricsStateV1 = {
  version: 1,
  updated_at_ms: 0,
  apps: {},
};

const updateQueues = new Map<string, Promise<void>>();

function appsDir(project_id: string): string {
  return join(
    getMountPoint(),
    `project-${project_id}`,
    ".local",
    "share",
    "cocalc",
    "apps",
  );
}

function hostMetricsStatePath(project_id: string): string {
  return join(appsDir(project_id), "host-metrics-state.json");
}

function runtimeStatePath(project_id: string): string {
  return join(appsDir(project_id), "runtime-state.json");
}

function defaultAppMetrics(): HostPersistedAppMetrics {
  return {
    totals: {
      websocket_bytes_sent: 0,
      public_websocket_bytes_sent: 0,
      private_websocket_bytes_sent: 0,
    },
    history: [],
  };
}

function currentMinuteStart(now = Date.now()): number {
  return Math.floor(now / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
}

function historyBucket(
  metrics: HostPersistedAppMetrics,
  minute_start_ms: number,
): HostAppMetricsBucket {
  const last = metrics.history[metrics.history.length - 1];
  if (last?.minute_start_ms === minute_start_ms) {
    return last;
  }
  const next: HostAppMetricsBucket = {
    minute_start_ms,
    websocket_bytes_sent: 0,
  };
  metrics.history.push(next);
  if (metrics.history.length > MAX_BUCKETS) {
    metrics.history.splice(0, metrics.history.length - MAX_BUCKETS);
  }
  return next;
}

async function readState(project_id: string): Promise<HostMetricsStateV1> {
  try {
    const raw = await readFile(hostMetricsStatePath(project_id), "utf8");
    const parsed = JSON.parse(raw) as HostMetricsStateV1;
    if (
      parsed?.version === 1 &&
      parsed.apps &&
      typeof parsed.apps === "object"
    ) {
      return parsed;
    }
  } catch {}
  return { ...DEFAULT_STATE, apps: {} };
}

async function writeState(
  project_id: string,
  state: HostMetricsStateV1,
): Promise<void> {
  const dir = appsDir(project_id);
  await mkdir(dir, { recursive: true });
  const target = hostMetricsStatePath(project_id);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

export async function recordHostAppWebsocketTraffic({
  project_id,
  app_id,
  bytes_sent,
  exposure_mode,
}: {
  project_id: string;
  app_id: string;
  bytes_sent: number;
  exposure_mode: AppProxyExposureMode;
}): Promise<void> {
  const bytes = Math.floor(Number(bytes_sent) || 0);
  if (!(bytes > 0)) return;
  const previous = updateQueues.get(project_id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const state = await readState(project_id);
      const metrics = state.apps[app_id] ?? defaultAppMetrics();
      const now = Date.now();
      metrics.last_hit_ms = now;
      metrics.totals.websocket_bytes_sent += bytes;
      if (exposure_mode === "public") {
        metrics.totals.public_websocket_bytes_sent += bytes;
      } else {
        metrics.totals.private_websocket_bytes_sent += bytes;
      }
      historyBucket(metrics, currentMinuteStart(now)).websocket_bytes_sent +=
        bytes;
      state.apps[app_id] = metrics;
      state.updated_at_ms = now;
      await writeState(project_id, state);
    })
    .catch((err) => {
      logger.warn("unable to record host websocket app metrics", {
        project_id,
        app_id,
        bytes,
        exposure_mode,
        err: `${err}`,
      });
    })
    .finally(() => {
      if (updateQueues.get(project_id) === next) {
        updateQueues.delete(project_id);
      }
    });
  updateQueues.set(project_id, next);
  await next;
}

export async function getHostAppIdForRunningServicePort({
  project_id,
  port,
}: {
  project_id: string;
  port: number;
}): Promise<string | undefined> {
  const targetPort = Math.floor(Number(port) || 0);
  if (!(targetPort > 0)) return;
  try {
    const raw = await readFile(runtimeStatePath(project_id), "utf8");
    const parsed = JSON.parse(raw) as {
      running_services?: Record<string, { port?: number }>;
    };
    for (const [app_id, value] of Object.entries(
      parsed?.running_services ?? {},
    )) {
      if (Math.floor(Number(value?.port) || 0) === targetPort) {
        return app_id;
      }
    }
  } catch (err) {
    logger.debug("unable to resolve app id for running service port", {
      project_id,
      port: targetPort,
      err: `${err}`,
    });
  }
}
