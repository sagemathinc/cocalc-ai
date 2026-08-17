/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  afterNextPaint,
  UxLatencyTrace,
  type UxTraceStart,
} from "@cocalc/frontend/monitoring/ux-latency-trace";
import { markSignedInSurfaceReady } from "./surface-ready-state";
import { getStartupPerformancePolicy } from "./startup-performance-policy";
import { markStartupPhase, type StartupPhaseDetails } from "./startup-phase";

declare const BUILD_DATE: string;

let trace: UxLatencyTrace | undefined;
let appReadyRecorded = false;
let failed = false;
let surfaceRecorded = false;
const entrySurface =
  typeof window !== "undefined" && window.location.pathname.includes("/auth/")
    ? "auth"
    : "application";

function navigationEntry(): PerformanceNavigationTiming | undefined {
  if (typeof performance === "undefined") return;
  return performance.getEntriesByType?.("navigation")?.[0] as
    | PerformanceNavigationTiming
    | undefined;
}

function navigationStart(): UxTraceStart | undefined {
  if (typeof performance === "undefined") return;
  const wall = Number(performance.timeOrigin);
  if (!Number.isFinite(wall) || wall <= 0) return;
  return {
    wall_ms: wall,
    ux_ms: 0,
    page_hidden: typeof document !== "undefined" && document.hidden,
    visibility_epoch: 0,
  };
}

interface PreAppStartupTrace {
  mark: (phase: string, details?: StartupPhaseDetails) => void;
  complete: (phase?: string) => void;
  snapshot: () => {
    id: string;
    started_at: string;
    marks: Record<string, number>;
    details: Record<string, unknown>;
  };
}

function preAppTrace(): PreAppStartupTrace | undefined {
  return (globalThis as any).__COCALC_STARTUP_TRACE__;
}

function getTrace(): UxLatencyTrace {
  if (trace != null) return trace;
  const navigation = navigationEntry();
  const early = preAppTrace()?.snapshot();
  trace = new UxLatencyTrace({
    event_type: "app_bootstrap",
    client_event_id: early?.id,
    source: "document_navigation",
    surface_visible: true,
    stale_after_ms: 120_000,
    start: navigationStart(),
  });
  markNavigationPhases(trace, navigation);
  mergePreAppMarks(trace, early);
  markStartupPhase("bootstrap_module_loaded");
  trace.mark("bootstrap_module_loaded");
  return trace;
}

function mergePreAppMarks(
  target: UxLatencyTrace,
  snapshot = preAppTrace()?.snapshot(),
): void {
  const details = snapshot?.details?.phase_details as
    | Record<string, StartupPhaseDetails>
    | undefined;
  for (const [phase, elapsed] of Object.entries(snapshot?.marks ?? {})) {
    target.markAt(phase, elapsed, details?.[phase]);
  }
}

function markNavigationPhases(
  target: UxLatencyTrace,
  navigation = navigationEntry(),
): void {
  if (typeof performance === "undefined") return;
  const phases: Array<[string, number | undefined]> = [
    ["dns_done", navigation?.domainLookupEnd],
    ["connect_done", navigation?.connectEnd],
    ["request_started", navigation?.requestStart],
    ["response_started", navigation?.responseStart],
    ["response_done", navigation?.responseEnd],
    ["dom_interactive", navigation?.domInteractive],
    ["dom_content_loaded", navigation?.domContentLoadedEventEnd],
    ["window_loaded", navigation?.loadEventEnd],
  ];
  for (const [phase, elapsed] of phases) {
    if (typeof elapsed === "number" && elapsed > 0) {
      target.markAt(phase, elapsed);
    }
  }
  for (const paint of performance.getEntriesByType?.("paint") ?? []) {
    if (
      paint.name === "first-paint" ||
      paint.name === "first-contentful-paint"
    ) {
      target.markAt(paint.name.replace(/-/g, "_"), paint.startTime);
    }
  }
}

export function markAppBootstrapPhase(
  phase: string,
  details?: StartupPhaseDetails,
): void {
  if (failed) return;
  markStartupPhase(phase, details);
  getTrace().mark(phase, details);
}

function connectionDetails(): Record<string, unknown> {
  if (typeof navigator === "undefined") return {};
  const connection = (navigator as any).connection;
  return {
    effective_connection_type:
      typeof connection?.effectiveType === "string"
        ? connection.effectiveType
        : undefined,
    save_data: connection?.saveData === true,
    rtt_ms: Number.isFinite(connection?.rtt) ? connection.rtt : undefined,
    downlink_mbps: Number.isFinite(connection?.downlink)
      ? connection.downlink
      : undefined,
    device_memory_gb: Number.isFinite((navigator as any)?.deviceMemory)
      ? (navigator as any).deviceMemory
      : undefined,
    hardware_concurrency: Number.isFinite(navigator?.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : undefined,
    startup_performance_policy: getStartupPerformancePolicy(),
  };
}

function timingDetails(): Record<string, unknown> {
  const navigation = navigationEntry();
  const resources = (performance.getEntriesByType?.("resource") ??
    []) as PerformanceResourceTiming[];
  const resourceSummary = (initiatorType: string) => {
    const selected = resources.filter(
      (entry) => entry.initiatorType === initiatorType,
    );
    return {
      count: selected.length,
      transfer_size: selected.reduce(
        (total, entry) => total + (entry.transferSize ?? 0),
        0,
      ),
      encoded_body_size: selected.reduce(
        (total, entry) => total + (entry.encodedBodySize ?? 0),
        0,
      ),
      cache_hits: selected.filter(
        (entry) => entry.transferSize === 0 && entry.decodedBodySize > 0,
      ).length,
      last_response_end_ms: selected.reduce(
        (latest, entry) => Math.max(latest, entry.responseEnd ?? 0),
        0,
      ),
    };
  };
  return {
    build_date: typeof BUILD_DATE === "undefined" ? undefined : BUILD_DATE,
    navigation_type: navigation?.type,
    protocol: navigation?.nextHopProtocol,
    transfer_size: navigation?.transferSize,
    encoded_body_size: navigation?.encodedBodySize,
    decoded_body_size: navigation?.decodedBodySize,
    redirect_count: navigation?.redirectCount,
    entry_surface: entrySurface,
    pre_app: preAppTrace()?.snapshot().details,
    scripts: resourceSummary("script"),
    stylesheets: resourceSummary("link"),
    ...connectionDetails(),
  };
}

export function recordSignedInAppBootstrapReady(): () => void {
  if (appReadyRecorded || failed) return () => {};
  const current = getTrace();
  current.mark("account_and_site_ready");
  return afterNextPaint(() => {
    if (appReadyRecorded || failed) return;
    appReadyRecorded = true;
    mergePreAppMarks(current);
    markNavigationPhases(current);
    current.record("signed_in_app_ready_v2", {
      segment: `${navigationEntry()?.type ?? "unknown"}:${entrySurface}`,
      surface_visible: true,
      details: {
        ...timingDetails(),
        paint_observer: "react_commit_next_animation_frame",
      },
    });
  });
}

export function recordSignedInSurfaceReady(segment: string): () => void {
  if (surfaceRecorded || failed) return () => {};
  const current = getTrace();
  current.mark("requested_surface_committed", { segment });
  return afterNextPaint(() => {
    if (surfaceRecorded || failed) return;
    surfaceRecorded = true;
    mergePreAppMarks(current);
    current.record("signed_in_surface_ready_v1", {
      segment,
      surface_visible: true,
      details: {
        ...timingDetails(),
        useful_surface: segment,
        paint_observer: "route_data_ready_next_animation_frame",
      },
    });
    markSignedInSurfaceReady(segment);
    preAppTrace()?.complete("signed_in_surface_ready");
  });
}

export function recordAppBootstrapFailed(
  phase: string,
  errorName: string,
): void {
  if (appReadyRecorded || failed) return;
  failed = true;
  const current = getTrace();
  mergePreAppMarks(current);
  current.record("app_bootstrap_failed_v2", {
    surface_visible: true,
    details: { phase, error_name: errorName },
  });
  preAppTrace()?.complete("app_bootstrap_failed");
}
