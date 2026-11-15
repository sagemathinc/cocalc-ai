/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { HostConatPersistMetrics } from "@cocalc/conat/hub/api/hosts";
import {
  isProjectHostExternalConatPersistEnabled,
  resolveProjectHostConatPersistHealthHost,
  resolveProjectHostConatPersistHealthPort,
} from "./conat-persist";
import { PROJECT_HOST_PERSIST_DIAGNOSTICS_PATH } from "./persist-diagnostics";

const DEFAULT_TIMEOUT_MS = Math.max(
  250,
  Number(
    process.env.COCALC_PROJECT_HOST_CONAT_PERSIST_DIAGNOSTICS_TIMEOUT_MS ??
      2_000,
  ),
);

type FetchLike = typeof fetch;

function finiteNonNegative(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function localFetchHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!normalized || normalized === "0.0.0.0") return "127.0.0.1";
  if (normalized === "::" || normalized === "[::]") return "[::1]";
  if (normalized.includes(":") && !normalized.startsWith("[")) {
    return `[${normalized}]`;
  }
  return normalized;
}

function errorMessage(err: unknown): string {
  return `${err}`.replace(/\s+/g, " ").trim().slice(0, 500);
}

function largeObjectSpaceUsedBytes(value: any): number | undefined {
  if (!Array.isArray(value)) return undefined;
  let total = 0;
  let found = false;
  for (const item of value) {
    if (!`${item?.space_name ?? ""}`.includes("large_object_space")) continue;
    const used = finiteNonNegative(item?.space_used_size);
    if (used == null) continue;
    total += used;
    found = true;
  }
  return found ? total : undefined;
}

export type MaintenanceErrorClass =
  | "unproven"
  | "fsync"
  | "checkpoint-incomplete"
  | "refused"
  | "timeout"
  | "other";

// the class of a maintenance error's text, from a closed set
export function maintenanceErrorClass(text: string): MaintenanceErrorClass {
  if (/not proven complete/.test(text)) return "unproven";
  if (/checkpoint incomplete|WAL is still present/.test(text)) {
    return "checkpoint-incomplete";
  }
  if (/\bfsync\b/.test(text)) return "fsync";
  if (/timed out/.test(text)) return "timeout";
  if (/\brefused\b/.test(text)) return "refused";
  return "other";
}

export function summarizeConatPersistDiagnostics(
  diagnostics: any,
  durationMs: number,
): HostConatPersistMetrics {
  const memory = diagnostics?.process?.memory ?? {};
  const heap = diagnostics?.v8?.heap ?? {};
  const eventLoop = diagnostics?.process?.event_loop_utilization ?? {};
  const streams = diagnostics?.conat?.persistence?.local_streams ?? {};
  const maintenance = diagnostics?.conat?.persistence?.maintenance ?? {};
  return {
    schema_version: finiteNonNegative(diagnostics?.schema_version) ?? 1,
    collected_at:
      typeof diagnostics?.collected_at === "string"
        ? diagnostics.collected_at
        : new Date().toISOString(),
    available: true,
    ready: diagnostics?.ready === true,
    server_id:
      typeof diagnostics?.server_id === "string"
        ? diagnostics.server_id
        : undefined,
    pid: finiteNonNegative(diagnostics?.process?.pid),
    uptime_seconds: finiteNonNegative(diagnostics?.process?.uptime_seconds),
    rss_bytes: finiteNonNegative(memory.rss),
    heap_total_bytes: finiteNonNegative(memory.heapTotal),
    heap_used_bytes: finiteNonNegative(memory.heapUsed),
    external_bytes: finiteNonNegative(memory.external),
    array_buffers_bytes: finiteNonNegative(memory.arrayBuffers),
    v8_heap_limit_bytes: finiteNonNegative(heap.heap_size_limit),
    v8_large_object_space_used_bytes: largeObjectSpaceUsedBytes(
      diagnostics?.v8?.heap_spaces,
    ),
    event_loop_utilization: finiteNonNegative(eventLoop.utilization),
    local_client_subscriptions: finiteNonNegative(
      diagnostics?.conat?.local_client_subscriptions,
    ),
    opened_streams_total: finiteNonNegative(streams.opened_total),
    closed_streams_total: finiteNonNegative(streams.closed_total),
    open_streams: finiteNonNegative(streams.open_total),
    open_ephemeral_streams: finiteNonNegative(streams.open_ephemeral),
    open_disk_streams: finiteNonNegative(streams.open_disk),
    cached_streams: finiteNonNegative(streams.cached_streams),
    cached_references: finiteNonNegative(streams.cached_references),
    max_cached_references: finiteNonNegative(streams.max_cached_references),
    maintenance_enabled:
      typeof maintenance.enabled === "boolean"
        ? maintenance.enabled
        : undefined,
    maintenance_catalog_healthy:
      typeof maintenance.catalog_healthy === "boolean"
        ? maintenance.catalog_healthy
        : undefined,
    maintenance_tracking_coverage:
      typeof maintenance.tracking_coverage === "boolean"
        ? maintenance.tracking_coverage
        : undefined,
    maintenance_open_paths: finiteNonNegative(maintenance.open_paths),
    maintenance_present_databases: finiteNonNegative(
      maintenance.present_databases,
    ),
    maintenance_missing_databases: finiteNonNegative(
      maintenance.missing_databases,
    ),
    maintenance_unverified_databases: finiteNonNegative(
      maintenance.unverified_databases,
    ),
    maintenance_present_file_bytes: finiteNonNegative(
      maintenance.present_file_bytes,
    ),
    maintenance_present_wal_bytes: finiteNonNegative(
      maintenance.present_wal_bytes,
    ),
    maintenance_last_scan_completed_at_ms: finiteNonNegative(
      maintenance.last_scan_completed_at_ms,
    ),
    maintenance_scanned_files: finiteNonNegative(maintenance.scanned_files),
    maintenance_pause_reason:
      typeof maintenance.pause_reason === "string"
        ? maintenance.pause_reason.slice(0, 500)
        : undefined,
    // host metrics reach clients that can list the host: a fixed class only,
    // never the error's text (it names stream paths, so project ids); the
    // text stays in the persist server's log and its loopback diagnostics
    maintenance_last_error:
      typeof maintenance.last_error === "string"
        ? maintenanceErrorClass(maintenance.last_error)
        : undefined,
    diagnostics_duration_ms: Math.max(0, Math.round(durationMs)),
  };
}

export async function readConatPersistMetrics({
  enabled = isProjectHostExternalConatPersistEnabled(),
  host = resolveProjectHostConatPersistHealthHost(),
  port = resolveProjectHostConatPersistHealthPort(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}: {
  enabled?: boolean;
  host?: string;
  port?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
} = {}): Promise<HostConatPersistMetrics | undefined> {
  if (!enabled) return undefined;
  const started = Date.now();
  if (port == null) {
    return {
      schema_version: 1,
      collected_at: new Date().toISOString(),
      available: false,
      error: "conat-persist diagnostics port is not configured",
      diagnostics_duration_ms: Date.now() - started,
    };
  }
  try {
    const response = await fetchImpl(
      `http://${localFetchHost(host)}:${port}${PROJECT_HOST_PERSIST_DIAGNOSTICS_PATH}`,
      {
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) {
      throw new Error(`diagnostics returned HTTP ${response.status}`);
    }
    return summarizeConatPersistDiagnostics(
      await response.json(),
      Date.now() - started,
    );
  } catch (err) {
    return {
      schema_version: 1,
      collected_at: new Date().toISOString(),
      available: false,
      error: errorMessage(err),
      diagnostics_duration_ms: Date.now() - started,
    };
  }
}
