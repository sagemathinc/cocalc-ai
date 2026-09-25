/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  afterNextPaint,
  UxLatencyTrace,
} from "@cocalc/frontend/monitoring/ux-latency-trace";
import { failOnboardingMessage } from "@cocalc/frontend/monitoring/onboarding";

const CODEX_RESPONSE_TIMEOUT_MS = 10 * 60_000;

interface CodexTraceEntry {
  trace: UxLatencyTrace;
  timeout: ReturnType<typeof setTimeout>;
  acknowledged: boolean;
}

const traces = new Map<string, CodexTraceEntry>();

function finish(messageId: string): void {
  const entry = traces.get(messageId);
  if (entry == null) return;
  clearTimeout(entry.timeout);
  traces.delete(messageId);
}

export function startCodexResponseTrace({
  message_id,
  project_id,
  send_mode,
}: {
  message_id: string;
  project_id?: string;
  send_mode?: "immediate";
}): void {
  const previous = traces.get(message_id);
  if (previous != null) {
    previous.trace.record("codex_response_incomplete_v2", {
      segment: send_mode ?? "queued",
      surface_visible: true,
      details: {
        reason: "superseded",
        acknowledged: previous.acknowledged,
      },
    });
    finish(message_id);
  }
  const trace = new UxLatencyTrace({
    event_type: "codex_turn",
    project_id,
    source: "frontend_dispatch",
    surface_visible: true,
    stale_after_ms: CODEX_RESPONSE_TIMEOUT_MS,
    sample_successes: true,
  });
  trace.mark("dispatch_started", { send_mode: send_mode ?? "queued" });
  const entry: CodexTraceEntry = {
    trace,
    acknowledged: false,
    timeout: undefined as unknown as ReturnType<typeof setTimeout>,
  };
  entry.timeout = setTimeout(() => {
    trace.record("codex_response_incomplete_v2", {
      segment: send_mode ?? "queued",
      surface_visible: true,
      details: {
        reason: "endpoint_timeout",
        acknowledged: entry.acknowledged,
      },
    });
    finish(message_id);
  }, CODEX_RESPONSE_TIMEOUT_MS);
  (entry.timeout as any).unref?.();
  traces.set(message_id, entry);
}

export function markCodexResponseTrace(
  messageId: string,
  phase: string,
  details?: Record<string, string | number | boolean | null | undefined>,
): void {
  traces.get(messageId)?.trace.mark(phase, details);
}

export function recordCodexBackendAcknowledged({
  message_id,
  state,
}: {
  message_id: string;
  state: string;
}): void {
  const entry = traces.get(message_id);
  if (entry == null || entry.acknowledged) return;
  entry.acknowledged = true;
  entry.trace.record("codex_backend_ack_v2", {
    segment: state,
    surface_visible: true,
  });
}

export function recordCodexResponseFailed({
  message_id,
  error_name,
  acknowledged,
}: {
  message_id: string;
  error_name: string;
  acknowledged: boolean;
}): void {
  failOnboardingMessage(message_id);
  const entry = traces.get(message_id);
  if (entry == null) return;
  entry.trace.record("codex_response_failed_v2", {
    segment: acknowledged ? "after_ack" : "before_ack",
    surface_visible: true,
    details: { error_name, acknowledged },
  });
  finish(message_id);
}

export function recordCodexFirstResponseVisible(
  parentMessageId: string,
): () => void {
  const entry = traces.get(parentMessageId);
  if (entry == null) return () => {};
  return afterNextPaint(() => {
    const current = traces.get(parentMessageId);
    if (current == null) return;
    current.trace.record("codex_first_response_visible_v2", {
      segment: current.acknowledged ? "acknowledged" : "before_ack",
      surface_visible: true,
      details: {
        paint_observer: "react_commit_next_animation_frame",
      },
    });
    finish(parentMessageId);
  });
}

export function resetCodexUxLatencyForTests(): void {
  for (const entry of traces.values()) {
    clearTimeout(entry.timeout);
  }
  traces.clear();
}
