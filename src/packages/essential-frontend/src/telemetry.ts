/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { siteUrl } from "./urls";

declare const BUILD_DATE: string;
declare const COCALC_GIT_REVISION: string;

export type UltraliteSurface =
  | "shell"
  | "projects"
  | "project"
  | "files"
  | "file"
  | "editor"
  | "notebook"
  | "notebooks"
  | "notebook_execute"
  | "kernel"
  | "chat"
  | "terminal"
  | "vms"
  | "apps"
  | "cli";

export type UltraliteOutcome =
  | "project_open"
  | "file_open"
  | "file_save"
  | "create_file"
  | "create_folder"
  | "notebook_execute"
  | "codex_prompt"
  | "terminal_connect"
  | "full_cocalc"
  | "timeout"
  | "chunk_failure"
  | "auth_failure"
  | "routing_failure"
  | "save_conflict"
  | "unsupported_file";

const sent = new Set<string>();
const startedAt = new Date(
  Number.isFinite(performance.timeOrigin)
    ? performance.timeOrigin
    : Date.now() - performance.now(),
).toISOString();
const clientEventId =
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `ultralite-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function backendDuration(surface: UltraliteSurface): number | undefined {
  const start = performance
    .getEntriesByName?.(`cocalc-ultralite:${surface}:backend-start`)
    ?.at(-1);
  const end = performance
    .getEntriesByName?.(`cocalc-ultralite:${surface}:backend-end`)
    ?.at(-1);
  if (!start || !end || end.startTime < start.startTime) return;
  return Math.round(end.startTime - start.startTime);
}

function phaseDuration(
  surface: UltraliteSurface,
  phase: string,
): number | undefined {
  const start = performance
    .getEntriesByName?.(`cocalc-ultralite:${surface}:${phase}-start`)
    ?.at(-1);
  const end = performance
    .getEntriesByName?.(`cocalc-ultralite:${surface}:${phase}-end`)
    ?.at(-1);
  if (!start || !end || end.startTime < start.startTime) return;
  return Math.round(end.startTime - start.startTime);
}

function resourceSummary() {
  const entries = (performance.getEntriesByType?.("resource") ??
    []) as PerformanceResourceTiming[];
  const scripts = entries.filter(
    ({ initiatorType }) => initiatorType === "script",
  );
  const styles = entries.filter(
    ({ initiatorType }) => initiatorType === "link",
  );
  const sum = (field: "decodedBodySize" | "encodedBodySize" | "transferSize") =>
    entries.reduce((total, entry) => total + (entry[field] ?? 0), 0);
  const transferSize = sum("transferSize");
  const decodedBodySize = sum("decodedBodySize");
  return {
    request_count: entries.length,
    transfer_size: transferSize,
    encoded_body_size: sum("encodedBodySize"),
    decoded_body_size: decodedBodySize,
    script_count: scripts.length,
    style_count: styles.length,
    cache_class:
      transferSize === 0 && decodedBodySize > 0 ? "warm" : "cold_or_mixed",
  };
}

export function ultraliteTelemetryDetails(
  surface: UltraliteSurface,
  outcome?: UltraliteOutcome,
): Record<string, unknown> {
  const navigation = performance.getEntriesByType?.("navigation")?.[0] as
    | PerformanceNavigationTiming
    | undefined;
  const connection = (navigator as any).connection;
  const memory = (performance as any).memory;
  return {
    trace_version: 1,
    client: "ultralite",
    build_date: typeof BUILD_DATE === "undefined" ? undefined : BUILD_DATE,
    git_revision:
      typeof COCALC_GIT_REVISION === "undefined"
        ? undefined
        : COCALC_GIT_REVISION,
    surface,
    outcome,
    navigation_type: navigation?.type,
    protocol: navigation?.nextHopProtocol,
    effective_connection_type:
      typeof connection?.effectiveType === "string"
        ? connection.effectiveType
        : undefined,
    downlink_mbps: Number.isFinite(connection?.downlink)
      ? connection.downlink
      : undefined,
    rtt_ms: Number.isFinite(connection?.rtt) ? connection.rtt : undefined,
    save_data: connection?.saveData === true,
    hardware_concurrency: Number.isFinite(navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : undefined,
    device_memory_gb: Number.isFinite((navigator as any).deviceMemory)
      ? (navigator as any).deviceMemory
      : undefined,
    js_heap_used_bytes: Number.isFinite(memory?.usedJSHeapSize)
      ? memory.usedJSHeapSize
      : undefined,
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
    document_hidden: document.hidden,
    backend_duration_ms: backendDuration(surface),
    route_chunk_duration_ms: phaseDuration(surface, "route-chunks"),
    project_host_connect_duration_ms: phaseDuration(
      surface,
      "project-host-connect",
    ),
    chat_service_open_duration_ms: phaseDuration(surface, "chat-service-open"),
    chat_stream_open_duration_ms: phaseDuration(surface, "chat-stream-open"),
    ...resourceSummary(),
  };
}

export function markUltraliteBackend(
  surface: UltraliteSurface,
  phase: "start" | "end",
): void {
  const name = `cocalc-ultralite:${surface}:backend-${phase}`;
  performance.clearMarks?.(name);
  performance.mark?.(name);
}

export function markUltralitePhase(
  surface: UltraliteSurface,
  phase: string,
  boundary: "start" | "end",
): void {
  const name = `cocalc-ultralite:${surface}:${phase}-${boundary}`;
  performance.clearMarks?.(name);
  performance.mark?.(name);
}

function send(
  metric: "constrained_surface_ready_v1" | "constrained_outcome_v1",
  surface: UltraliteSurface,
  outcome?: UltraliteOutcome,
) {
  const key = `${metric}:${surface}:${outcome ?? "ready"}`;
  if (sent.has(key)) return;
  sent.add(key);
  const payload = JSON.stringify({
    metric,
    duration_ms: Math.max(0, Math.round(performance.now())),
    client_event_id: clientEventId,
    started_at: startedAt,
    segment: surface,
    details: ultraliteTelemetryDetails(surface, outcome),
  });
  const url = siteUrl("api/v2/monitoring/startup");
  try {
    const body = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon?.(url, body)) return;
  } catch {
    // Fall through to best-effort fetch.
  }
  try {
    void fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Telemetry must never affect the constrained client.
  }
}

export function recordUltraliteSurfaceReady(surface: UltraliteSurface): void {
  performance.mark?.(`cocalc-ultralite:${surface}:ready`);
  send("constrained_surface_ready_v1", surface);
}

export function recordUltraliteOutcome(
  surface: UltraliteSurface,
  outcome: UltraliteOutcome,
): void {
  performance.mark?.(`cocalc-ultralite:${surface}:${outcome}`);
  send("constrained_outcome_v1", surface, outcome);
}

export function recordUltraliteFailure(
  surface: UltraliteSurface,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : `${error ?? ""}`;
  if (/timed?\s*out|timeout/i.test(message)) {
    recordUltraliteOutcome(surface, "timeout");
  }
}
