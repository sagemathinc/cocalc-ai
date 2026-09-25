/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { UxLatencyEventInput } from "@cocalc/conat/hub/api/system";
import { uuid } from "@cocalc/util/misc";
import {
  ONBOARDING_METRICS as M,
  ONBOARDING_STALLED_MS,
  type OnboardingPhase,
} from "@cocalc/util/onboarding-metrics";
import { afterNextPaint } from "./ux-latency-trace";

const PREFIX = "cocalc:onboarding-metric:";
const queue = new Map<
  string,
  { accountId: string; event: UxLatencyEventInput }
>();
const attempts = new Set<OnboardingAttempt>();
const messages = new Map<string, OnboardingAttempt>();
let accountId: string | undefined;
let enabled = false;
let flushing = false;
let retryTimer: ReturnType<typeof setInterval> | undefined;
let listening = false;

function storedKeys(id: string): string[] {
  try {
    return Object.keys(localStorage).filter((key) =>
      key.startsWith(`${PREFIX}${id}:`),
    );
  } catch {
    return [];
  }
}

function removeStored(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* In-memory delivery still works. */
  }
}

/** Account-scoped outbox survives reloads; no prompt, name, path, or raw errors. */
function enqueue(id: string, event: UxLatencyEventInput) {
  if (!enabled || id !== accountId) return;
  const key = `${PREFIX}${id}:${event.client_event_id}:${event.metric}:${event.segment ?? ""}`;
  const item = { accountId: id, event };
  queue.set(key, item);
  try {
    localStorage.setItem(key, JSON.stringify(item));
  } catch {
    /* Retry in memory. */
  }
  void flushOnboardingMetrics();
}

export async function flushOnboardingMetrics(): Promise<void> {
  if (flushing || !enabled || !accountId) return;
  flushing = true;
  try {
    for (const [key, item] of queue) {
      if (
        !enabled ||
        item.accountId !== accountId ||
        webapp_client.account_id !== item.accountId
      )
        continue;
      try {
        await webapp_client.conat_client.hub.system.recordUxLatencyEvent({
          event: item.event,
        });
        if (queue.get(key) === item) {
          queue.delete(key);
          removeStored(key);
        }
      } catch {
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

export function configureOnboardingMonitoring(
  id: string | undefined,
  telemetryEnabled: boolean,
) {
  if (accountId !== id) {
    enabled = false;
    for (const attempt of attempts)
      attempt.finish("abandoned", "account_changed");
  }
  accountId = id;
  enabled = telemetryEnabled;
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = undefined;
  if (!id) return;
  for (const key of storedKeys(id)) {
    if (!enabled) {
      removeStored(key);
      queue.delete(key);
      continue;
    }
    try {
      const item = JSON.parse(localStorage.getItem(key) ?? "null");
      if (item?.accountId === id && item.event?.event_type === "onboarding")
        queue.set(key, item);
    } catch {
      removeStored(key);
    }
  }
  if (!enabled) return;
  if (!listening && typeof window !== "undefined") {
    listening = true;
    window.addEventListener("pagehide", () => {
      for (const attempt of attempts) attempt.finish("abandoned", "pagehide");
    });
  }
  retryTimer = setInterval(() => void flushOnboardingMetrics(), 5_000);
  (retryTimer as any).unref?.();
  void flushOnboardingMetrics();
}

export class OnboardingAttempt {
  readonly id = uuid();
  private started = Date.now();
  private marks: Record<string, number> = {};
  private phase: OnboardingPhase = "workspace";
  private done = false;
  private timer: ReturnType<typeof setTimeout>;
  private messageId?: string;
  private projectId?: string;

  constructor(private readonly owner: string) {
    attempts.add(this);
    this.record(M.started);
    this.timer = setTimeout(
      () => this.record(M.stalled),
      ONBOARDING_STALLED_MS,
    );
    (this.timer as any).unref?.();
  }

  private record(metric: string, reason?: string) {
    enqueue(this.owner, {
      event_type: "onboarding",
      metric,
      client_event_id: this.id,
      started_at: new Date(this.started).toISOString(),
      duration_ms: Math.max(0, Date.now() - this.started),
      sample_rate: 1,
      project_id: this.projectId,
      segment: metric === M.phase ? this.phase : undefined,
      details: {
        phase: this.phase,
        marks: { ...this.marks },
        reason,
        page_hidden: typeof document !== "undefined" && document.hidden,
      },
    });
  }

  mark(phase: OnboardingPhase, projectId?: string) {
    if (this.done) return;
    this.phase = phase;
    this.projectId = projectId ?? this.projectId;
    this.marks[phase] = Math.max(0, Date.now() - this.started);
    this.record(M.phase);
  }

  attach(messageId: string, projectId: string) {
    this.messageId = messageId;
    this.projectId = projectId;
    messages.set(messageId, this);
    this.mark("output");
  }

  finish(outcome: "visible" | "failed" | "abandoned", reason?: string) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    this.record(M[outcome], reason);
    attempts.delete(this);
    if (this.messageId) messages.delete(this.messageId);
  }
}

export function recordOnboardingOutput(
  messageId: string,
  failed = false,
): () => void {
  const attempt = messages.get(messageId);
  if (!attempt) return () => {};
  return afterNextPaint(() =>
    attempt.finish(
      failed ? "failed" : "visible",
      failed ? "agent_error" : undefined,
    ),
  );
}

export function failOnboardingMessage(messageId: string) {
  messages.get(messageId)?.finish("failed", "dispatch_error");
}

export function resetOnboardingMonitoringForTests() {
  for (const attempt of attempts) attempt.finish("abandoned");
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = undefined;
  queue.clear();
  messages.clear();
  attempts.clear();
  accountId = undefined;
  enabled = false;
}
