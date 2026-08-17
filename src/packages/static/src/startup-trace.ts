/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";

declare const BUILD_DATE: string;

const INCOMPLETE_AFTER_MS = 30_000;
const MAX_MARKS = 80;

export interface PreAppStartupTraceSnapshot {
  id: string;
  started_at: string;
  marks: Record<string, number>;
  details: Record<string, unknown>;
}

export interface PreAppStartupTrace {
  mark: (
    phase: string,
    details?: Record<string, string | number | boolean | null | undefined>,
  ) => void;
  complete: (phase?: string) => void;
  snapshot: () => PreAppStartupTraceSnapshot;
}

declare global {
  // This deliberately crosses the small load entry and the much larger app
  // entry without introducing a bundle dependency between them.
  var __COCALC_STARTUP_TRACE__: PreAppStartupTrace | undefined;
}

function elapsedMs(): number {
  return Math.max(0, Math.round(performance.now()));
}

function traceId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `startup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function startupRouteSegment(
  pathname = window.location.pathname,
): string {
  let path = pathname;
  if (appBasePath.length > 1 && path.startsWith(appBasePath)) {
    path = path.slice(appBasePath.length);
  }
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "projects" && parts[1]) return "project";
  if (parts[0] === "projects" || parts.length === 0) return "projects";
  if (parts[0] === "settings") return "account";
  return parts[0]?.slice(0, 40) || "unknown";
}

function navigationMarks(): Record<string, number> {
  const navigation = performance.getEntriesByType?.("navigation")?.[0] as
    | PerformanceNavigationTiming
    | undefined;
  const marks: Record<string, number> = { intent: 0 };
  const phases: Array<[string, number | undefined]> = [
    ["dns_done", navigation?.domainLookupEnd],
    ["connect_done", navigation?.connectEnd],
    ["request_started", navigation?.requestStart],
    ["response_started", navigation?.responseStart],
    ["response_done", navigation?.responseEnd],
    ["dom_interactive", navigation?.domInteractive],
    ["dom_content_loaded", navigation?.domContentLoadedEventEnd],
  ];
  for (const [phase, value] of phases) {
    if (typeof value === "number" && value > 0) {
      marks[phase] = Math.round(value);
    }
  }
  return marks;
}

function resourceDetails(): Record<string, unknown> {
  const resources = (performance.getEntriesByType?.("resource") ??
    []) as PerformanceResourceTiming[];
  const scripts = resources.filter((entry) => entry.initiatorType === "script");
  const connection = (navigator as any).connection;
  const navigation = performance.getEntriesByType?.("navigation")?.[0] as
    | PerformanceNavigationTiming
    | undefined;
  return {
    build_date: typeof BUILD_DATE === "undefined" ? undefined : BUILD_DATE,
    route_segment: startupRouteSegment(),
    document_hidden: document.hidden,
    document_was_discarded: (document as any).wasDiscarded === true,
    navigation_type: navigation?.type,
    script_count: scripts.length,
    script_transfer_size: scripts.reduce(
      (total, entry) => total + (entry.transferSize ?? 0),
      0,
    ),
    script_encoded_body_size: scripts.reduce(
      (total, entry) => total + (entry.encodedBodySize ?? 0),
      0,
    ),
    script_cache_hits: scripts.filter(
      (entry) => entry.transferSize === 0 && entry.decodedBodySize > 0,
    ).length,
    effective_connection_type:
      typeof connection?.effectiveType === "string"
        ? connection.effectiveType
        : undefined,
    save_data: connection?.saveData === true,
    rtt_ms: Number.isFinite(connection?.rtt) ? connection.rtt : undefined,
    downlink_mbps: Number.isFinite(connection?.downlink)
      ? connection.downlink
      : undefined,
    device_memory_gb: Number.isFinite((navigator as any).deviceMemory)
      ? (navigator as any).deviceMemory
      : undefined,
    hardware_concurrency: Number.isFinite(navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : undefined,
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
  };
}

function sendDiagnostic(
  metric: "signed_in_app_abandoned_v1" | "signed_in_app_incomplete_v1",
  snapshot: PreAppStartupTraceSnapshot,
): void {
  const payload = JSON.stringify({
    metric,
    duration_ms: elapsedMs(),
    client_event_id: snapshot.id,
    started_at: snapshot.started_at,
    segment: startupRouteSegment(),
    details: snapshot.details,
  });
  const url = joinUrlPath(appBasePath, "api/v2/monitoring/startup");
  try {
    const body = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon?.(url, body)) return;
  } catch {
    // Fall through to a keepalive fetch. Startup telemetry is best effort.
  }
  try {
    void fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Telemetry must never affect startup.
  }
}

export function initializeStartupTrace(): PreAppStartupTrace | undefined {
  if (document.body?.dataset.cocalcEntry !== "app") return;
  if (globalThis.__COCALC_STARTUP_TRACE__ != null) {
    return globalThis.__COCALC_STARTUP_TRACE__;
  }

  const id = traceId();
  const timeOrigin = Number.isFinite(performance.timeOrigin)
    ? performance.timeOrigin
    : Date.now() - performance.now();
  const started_at = new Date(timeOrigin).toISOString();
  const marks = navigationMarks();
  const phaseDetails: Record<
    string,
    Record<string, string | number | boolean | null | undefined>
  > = {};
  let completed = false;
  let diagnosticSent = false;
  let longTaskCount = 0;
  let longTaskTotalMs = 0;
  let longestTaskMs = 0;
  let observer: PerformanceObserver | undefined;

  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount += 1;
        longTaskTotalMs += entry.duration;
        longestTaskMs = Math.max(longestTaskMs, entry.duration);
      }
    });
    observer.observe({ type: "longtask", buffered: true } as any);
  } catch {
    observer = undefined;
  }

  const snapshot = (): PreAppStartupTraceSnapshot => {
    const currentMarks = { ...marks, ...navigationMarks() };
    return {
      id,
      started_at,
      marks: currentMarks,
      details: {
        trace_version: 3,
        marks: currentMarks,
        phase_details: { ...phaseDetails },
        long_task_count: longTaskCount,
        long_task_total_ms: Math.round(longTaskTotalMs),
        longest_task_ms: Math.round(longestTaskMs),
        ...resourceDetails(),
      },
    };
  };

  const mark = (
    phase: string,
    details?: Record<string, string | number | boolean | null | undefined>,
  ) => {
    if (!phase || Object.keys(marks).length >= MAX_MARKS) return;
    const safePhase = phase.slice(0, 80);
    marks[safePhase] = elapsedMs();
    if (details != null) {
      phaseDetails[safePhase] = details;
    }
  };

  const timeout = window.setTimeout(() => {
    if (completed || diagnosticSent) return;
    diagnosticSent = true;
    mark("startup_incomplete");
    sendDiagnostic("signed_in_app_incomplete_v1", snapshot());
  }, INCOMPLETE_AFTER_MS);

  const complete = (phase = "signed_in_app_ready") => {
    if (completed) return;
    completed = true;
    mark(phase);
    window.clearTimeout(timeout);
    observer?.disconnect();
  };

  window.addEventListener(
    "pagehide",
    () => {
      if (completed || diagnosticSent) return;
      diagnosticSent = true;
      mark("page_hidden_before_ready");
      sendDiagnostic("signed_in_app_abandoned_v1", snapshot());
    },
    { once: true },
  );

  const trace = { mark, complete, snapshot };
  globalThis.__COCALC_STARTUP_TRACE__ = trace;
  mark("load_entry_loaded");
  return trace;
}
