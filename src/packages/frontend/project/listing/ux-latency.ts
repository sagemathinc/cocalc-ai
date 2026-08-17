/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  UxLatencyTrace,
  type UxTracePhaseDetails,
  type UxTraceStart,
} from "@cocalc/frontend/monitoring/ux-latency-trace";
import { recordSignedInSurfaceReady } from "@cocalc/frontend/app/bootstrap-ux-latency";

const DIRECTORY_TRACE_INCOMPLETE_AFTER_MS = 45_000;
const DIRECTORY_TRACE_CLEANUP_DELAY_MS = 10_000;

export type DirectoryTraceSource =
  | "project_open"
  | "navigation"
  | "component_mount";

export type DirectoryListingDataSource =
  | "cache"
  | "retained"
  | "snapshot"
  | "watcher";

export interface DirectoryListingTelemetry {
  trace_id: string;
  revision: number;
  data_source: DirectoryListingDataSource;
  authoritative: boolean;
  cache_hit: boolean;
  entries: number;
  truncated: boolean;
  attempts?: number;
}

export interface DirectoryTraceEntry {
  trace: UxLatencyTrace;
  project_id: string;
  source: DirectoryTraceSource;
  path?: string;
  firstPainted: boolean;
  authoritativePainted: boolean;
  incompleteTimer: ReturnType<typeof setTimeout>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

const directoryTraces = new Map<string, DirectoryTraceEntry>();

function pathDepth(path: string | undefined): number | undefined {
  if (path == null) return;
  return path.split("/").filter(Boolean).length;
}

function recordIncomplete(
  entry: DirectoryTraceEntry,
  reason: "superseded" | "endpoint_timeout",
): void {
  entry.trace.record("directory_listing_incomplete_v2", {
    surface_visible: true,
    details: {
      reason,
      trace_source: entry.source,
      path_depth: pathDepth(entry.path),
      first_painted: entry.firstPainted,
      authoritative_painted: entry.authoritativePainted,
    },
  });
}

function createTrace({
  project_id,
  host_id,
  source,
  path,
  surface_visible,
  start,
}: {
  project_id: string;
  host_id?: string;
  source: DirectoryTraceSource;
  path?: string;
  surface_visible: boolean;
  start?: UxTraceStart;
}): DirectoryTraceEntry {
  const previous = directoryTraces.get(project_id);
  if (previous != null) {
    clearTimeout(previous.incompleteTimer);
    if (previous.cleanupTimer != null) clearTimeout(previous.cleanupTimer);
    if (!previous.authoritativePainted) {
      recordIncomplete(previous, "superseded");
    }
  }
  const entry = {
    trace: new UxLatencyTrace({
      event_type: "directory_listing",
      project_id,
      host_id,
      source,
      surface_visible,
      start,
    }),
    project_id,
    source,
    path,
    firstPainted: false,
    authoritativePainted: false,
    incompleteTimer: undefined as unknown as ReturnType<typeof setTimeout>,
  };
  entry.trace.mark("trace_created", { path_depth: pathDepth(path) });
  entry.incompleteTimer = setTimeout(() => {
    if (directoryTraces.get(project_id) !== entry) return;
    recordIncomplete(entry, "endpoint_timeout");
    directoryTraces.delete(project_id);
  }, DIRECTORY_TRACE_INCOMPLETE_AFTER_MS);
  directoryTraces.set(project_id, entry);
  return entry;
}

export function startProjectDirectoryOpenTrace({
  project_id,
  host_id,
  surface_visible,
  start,
}: {
  project_id: string;
  host_id?: string;
  surface_visible: boolean;
  start?: UxTraceStart;
}): void {
  createTrace({
    project_id,
    host_id,
    source: "project_open",
    surface_visible,
    start,
  });
}

export function cancelProjectDirectoryOpenTrace(project_id: string): void {
  const entry = directoryTraces.get(project_id);
  if (entry?.source !== "project_open") return;
  clearTimeout(entry.incompleteTimer);
  if (entry.cleanupTimer != null) clearTimeout(entry.cleanupTimer);
  directoryTraces.delete(project_id);
}

export function recordProjectDirectoryOpenIncomplete({
  project_id,
  reason,
}: {
  project_id: string;
  reason: string;
}): void {
  const entry = directoryTraces.get(project_id);
  if (entry?.source !== "project_open") return;
  entry.trace.record("directory_listing_incomplete_v2", {
    surface_visible: true,
    details: {
      reason,
      trace_source: entry.source,
      path_depth: pathDepth(entry.path),
      first_painted: entry.firstPainted,
      authoritative_painted: entry.authoritativePainted,
    },
  });
  cancelProjectDirectoryOpenTrace(project_id);
}

export function markProjectDirectoryOpenPhase({
  project_id,
  phase,
  details,
}: {
  project_id: string;
  phase: string;
  details?: UxTracePhaseDetails;
}): void {
  const entry = directoryTraces.get(project_id);
  if (entry?.source !== "project_open") return;
  entry.trace.mark(phase, details);
}

export function startDirectoryNavigationTrace({
  project_id,
  host_id,
  path,
  surface_visible = true,
}: {
  project_id: string;
  host_id?: string;
  path: string;
  surface_visible?: boolean;
}): void {
  const pending = directoryTraces.get(project_id);
  if (pending?.source === "project_open" && !pending.firstPainted) {
    pending.path = path;
    pending.trace.mark("path_selected", { path_depth: pathDepth(path) });
    return;
  }
  createTrace({
    project_id,
    host_id,
    source: "navigation",
    path,
    surface_visible,
  });
}

export function claimDirectoryListingTrace({
  project_id,
  host_id,
  path,
  surface_visible,
}: {
  project_id: string;
  host_id?: string;
  path: string;
  surface_visible: boolean;
}): DirectoryTraceEntry {
  let entry = directoryTraces.get(project_id);
  if (entry == null || (entry.path != null && entry.path !== path)) {
    entry = createTrace({
      project_id,
      host_id,
      source: "component_mount",
      path,
      surface_visible,
    });
  } else {
    entry.path = path;
  }
  if (entry.trace.marks.listing_hook_render == null) {
    entry.trace.mark("listing_hook_render", { path_depth: pathDepth(path) });
  }
  return entry;
}

export function markDirectoryListingPhase(
  entry: DirectoryTraceEntry | undefined,
  phase: string,
  details?: Record<string, string | number | boolean | null | undefined>,
): void {
  entry?.trace.mark(phase, details);
}

export function directoryListingTelemetry({
  entry,
  revision,
  data_source,
  authoritative,
  cache_hit,
  entries,
  truncated,
  attempts,
}: Omit<DirectoryListingTelemetry, "trace_id"> & {
  entry?: DirectoryTraceEntry;
}): DirectoryListingTelemetry | null {
  if (entry == null) return null;
  return {
    trace_id: entry.trace.id,
    revision,
    data_source,
    authoritative,
    cache_hit,
    entries,
    truncated,
    attempts,
  };
}

export function recordDirectoryListingPaint({
  project_id,
  path,
  telemetry,
  rendered_entries,
  surface_visible,
}: {
  project_id: string;
  path: string;
  telemetry: DirectoryListingTelemetry;
  rendered_entries: number;
  surface_visible: boolean;
}): void {
  const entry = directoryTraces.get(project_id);
  if (entry == null || entry.trace.id !== telemetry.trace_id) return;
  const details = {
    trace_source: entry.source,
    data_source: telemetry.data_source,
    authoritative: telemetry.authoritative,
    cache_hit: telemetry.cache_hit,
    entries: telemetry.entries,
    rendered_entries,
    truncated: telemetry.truncated,
    attempts: telemetry.attempts,
    path_depth: pathDepth(path),
    paint_observer: "react_commit_next_animation_frame",
  };
  if (!entry.firstPainted) {
    entry.firstPainted = true;
    if (surface_visible) {
      recordSignedInSurfaceReady("project-directory");
    }
    entry.trace.record(
      entry.source === "project_open"
        ? "project_directory_first_paint_v2"
        : entry.source === "navigation"
          ? "directory_navigation_first_paint_v2"
          : "directory_listing_first_paint_v2",
      {
        segment: `${entry.source}:${telemetry.data_source}`,
        surface_visible,
        details,
      },
    );
  }
  if (telemetry.authoritative && !entry.authoritativePainted) {
    entry.authoritativePainted = true;
    entry.trace.record("directory_authoritative_paint_v2", {
      segment: `${entry.source}:${telemetry.data_source}`,
      surface_visible,
      details,
    });
    clearTimeout(entry.incompleteTimer);
    entry.cleanupTimer = setTimeout(() => {
      if (directoryTraces.get(project_id) === entry) {
        directoryTraces.delete(project_id);
      }
    }, DIRECTORY_TRACE_CLEANUP_DELAY_MS);
  }
}
