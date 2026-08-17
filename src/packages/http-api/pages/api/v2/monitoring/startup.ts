/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import isPost from "@cocalc/http-api/lib/api/is-post";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { recordUxLatencyEvent } from "@cocalc/server/monitoring/ux-latency";
import { to_bool } from "@cocalc/util/db-schema/site-defaults";

const ALLOWED_METRICS = new Set([
  "signed_in_app_abandoned_v1",
  "signed_in_app_incomplete_v1",
  "constrained_surface_ready_v1",
  "constrained_outcome_v1",
]);

const CONSTRAINED_SURFACES = new Set([
  "shell",
  "projects",
  "project",
  "files",
  "file",
  "editor",
  "notebook",
  "notebook_execute",
  "kernel",
  "chat",
  "vms",
  "apps",
  "cli",
]);
const CONSTRAINED_OUTCOMES = new Set([
  "project_open",
  "file_open",
  "file_save",
  "notebook_execute",
  "codex_prompt",
  "full_cocalc",
  "timeout",
  "chunk_failure",
  "auth_failure",
  "routing_failure",
  "save_conflict",
  "unsupported_file",
]);
const CONSTRAINED_NUMBER_FIELDS = new Set([
  "trace_version",
  "downlink_mbps",
  "rtt_ms",
  "hardware_concurrency",
  "device_memory_gb",
  "js_heap_used_bytes",
  "viewport_width",
  "viewport_height",
  "request_count",
  "transfer_size",
  "encoded_body_size",
  "decoded_body_size",
  "script_count",
  "style_count",
  "backend_duration_ms",
  "route_chunk_duration_ms",
  "project_host_connect_duration_ms",
  "chat_service_open_duration_ms",
  "chat_stream_open_duration_ms",
]);
const CONSTRAINED_BOOLEAN_FIELDS = new Set(["save_data", "document_hidden"]);
const CONSTRAINED_TEXT_FIELDS = new Set([
  "client",
  "build_date",
  "git_revision",
  "navigation_type",
  "protocol",
  "effective_connection_type",
  "cache_class",
]);

function constrainedDetails(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const input = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of CONSTRAINED_NUMBER_FIELDS) {
    const number = Number(input[key]);
    if (Number.isFinite(number) && number >= 0) result[key] = number;
  }
  for (const key of CONSTRAINED_BOOLEAN_FIELDS) {
    if (typeof input[key] === "boolean") result[key] = input[key];
  }
  for (const key of CONSTRAINED_TEXT_FIELDS) {
    if (typeof input[key] === "string") result[key] = input[key].slice(0, 120);
  }
  if (CONSTRAINED_SURFACES.has(`${input.surface ?? ""}`)) {
    result.surface = input.surface;
  }
  if (CONSTRAINED_OUTCOMES.has(`${input.outcome ?? ""}`)) {
    result.outcome = input.outcome;
  }
  return result;
}

export default async function recordStartupDiagnostic(req, res) {
  if (!isPost(req, res)) return;
  if (req.header("Authorization")) {
    res.json({ error: "API keys are not allowed to record browser startup" });
    return;
  }

  try {
    const settings = await getServerSettings();
    if (!to_bool(settings.ux_latency_telemetry_enabled)) {
      res.status(204).end();
      return;
    }
    if (!getRememberMeHash(req)) {
      res.status(204).end();
      return;
    }
    const account_id = await getAccountId(req);
    const metric = `${req.body?.metric ?? ""}`;
    if (!account_id || !ALLOWED_METRICS.has(metric)) {
      res.status(204).end();
      return;
    }
    const constrained = metric.startsWith("constrained_");
    const requestedSegment = `${req.body?.segment ?? ""}`;
    await recordUxLatencyEvent({
      account_id,
      event: {
        event_type: constrained ? "constrained_client" : "app_bootstrap",
        metric,
        duration_ms: req.body?.duration_ms,
        client_event_id: req.body?.client_event_id,
        started_at: req.body?.started_at,
        sample_rate: 1,
        segment:
          constrained && !CONSTRAINED_SURFACES.has(requestedSegment)
            ? undefined
            : req.body?.segment,
        details: constrained
          ? constrainedDetails(req.body?.details)
          : req.body?.details,
      },
    });
  } catch {
    // Startup diagnostics are best effort and must not create UI errors.
  }
  res.status(204).end();
}
