/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { HistoryGapEvent } from "@cocalc/conat/sync/core-stream";

const MAX_PROJECTION_EVENTS = 200;

type ProjectionFeedState = {
  consumer: string;
  account_id?: string;
  stream_name?: string;
  stream_recovery_state?: string;
  connected?: boolean;
  is_closed?: boolean;
  attach_count: number;
  detach_count: number;
  event_count: number;
  history_gap_count: number;
  repair_count: number;
  repair_failure_count: number;
  ack_count: number;
  ack_failure_count: number;
  last_attach_at?: string;
  last_detach_at?: string;
  last_event_at?: string;
  last_event_type?: string;
  last_seq?: number;
  last_history_gap_at?: string;
  last_history_gap?: HistoryGapEvent;
  last_repair_at?: string;
  last_repair_reason?: string;
  last_repair_scope?: unknown;
  last_repair_error?: string;
  last_ack_at?: string;
  last_ack_name?: string;
  last_ack_state?: "pending" | "converged" | "failed";
  last_ack_error?: string;
  pending_acks: Record<string, { name: string; started_at: string }>;
};

type ProjectionEvent = {
  at: string;
  consumer: string;
  event: string;
  payload?: unknown;
};

const states: Record<string, ProjectionFeedState> = Object.create(null);
const recentEvents: ProjectionEvent[] = [];

function now(): string {
  return new Date().toISOString();
}

function stateFor(consumer: string): ProjectionFeedState {
  const key = `${consumer || "unknown"}`;
  states[key] ??= {
    consumer: key,
    attach_count: 0,
    detach_count: 0,
    event_count: 0,
    history_gap_count: 0,
    repair_count: 0,
    repair_failure_count: 0,
    ack_count: 0,
    ack_failure_count: 0,
    pending_acks: Object.create(null),
  };
  return states[key];
}

function pushEvent(consumer: string, event: string, payload?: unknown): void {
  recentEvents.push({ at: now(), consumer, event, payload });
  if (recentEvents.length > MAX_PROJECTION_EVENTS) {
    recentEvents.splice(0, recentEvents.length - MAX_PROJECTION_EVENTS);
  }
}

function streamSnapshot(stream: any) {
  return {
    stream_recovery_state: stream?.getRecoveryState?.(),
    connected: stream?.getRecoveryState?.() === "ready",
    is_closed: stream?.isClosed?.(),
  };
}

export function attachProjectionFeedDiagnostics({
  consumer,
  account_id,
  stream_name,
  stream,
}: {
  consumer: string;
  account_id?: string;
  stream_name?: string;
  stream: any;
}): () => void {
  const state = stateFor(consumer);
  Object.assign(state, {
    account_id,
    stream_name,
    ...streamSnapshot(stream),
    attach_count: state.attach_count + 1,
    last_attach_at: now(),
  });
  pushEvent(consumer, "feed.attach", {
    account_id,
    stream_name,
    ...streamSnapshot(stream),
  });

  const onRecoveryState = (stream_recovery_state: string) => {
    Object.assign(state, {
      stream_recovery_state,
      connected: stream_recovery_state === "ready",
      is_closed: stream?.isClosed?.(),
    });
    pushEvent(consumer, "feed.recovery-state", { stream_recovery_state });
  };
  const onClosed = () => {
    Object.assign(state, {
      stream_recovery_state: "closed",
      connected: false,
      is_closed: true,
    });
    pushEvent(consumer, "feed.closed");
  };

  stream?.on?.("recovery-state", onRecoveryState);
  stream?.once?.("closed", onClosed);

  return () => {
    stream?.removeListener?.("recovery-state", onRecoveryState);
    stream?.removeListener?.("closed", onClosed);
    Object.assign(state, {
      ...streamSnapshot(stream),
      detach_count: state.detach_count + 1,
      last_detach_at: now(),
    });
    pushEvent(consumer, "feed.detach", streamSnapshot(stream));
  };
}

export function recordProjectionFeedEvent({
  consumer,
  event,
  seq,
}: {
  consumer: string;
  event?: { type?: string };
  seq?: number;
}): void {
  const state = stateFor(consumer);
  Object.assign(state, {
    event_count: state.event_count + 1,
    last_event_at: now(),
    last_event_type: `${event?.type ?? "unknown"}`,
    last_seq: typeof seq === "number" ? seq : state.last_seq,
  });
  pushEvent(consumer, "feed.change", {
    type: event?.type,
    seq,
  });
}

export function recordProjectionHistoryGap({
  consumer,
  info,
}: {
  consumer: string;
  info?: HistoryGapEvent;
}): void {
  const state = stateFor(consumer);
  Object.assign(state, {
    history_gap_count: state.history_gap_count + 1,
    last_history_gap_at: now(),
    last_history_gap: info,
  });
  pushEvent(consumer, "feed.history-gap", info);
}

export function recordProjectionRepair({
  consumer,
  reason,
  scope,
}: {
  consumer: string;
  reason: string;
  scope?: unknown;
}): void {
  const state = stateFor(consumer);
  Object.assign(state, {
    repair_count: state.repair_count + 1,
    last_repair_at: now(),
    last_repair_reason: reason,
    last_repair_scope: scope,
    last_repair_error: undefined,
  });
  pushEvent(consumer, "repair", { reason, scope });
}

export function recordProjectionRepairFailure({
  consumer,
  reason,
  scope,
  error,
}: {
  consumer: string;
  reason: string;
  scope?: unknown;
  error: unknown;
}): void {
  const state = stateFor(consumer);
  Object.assign(state, {
    repair_failure_count: state.repair_failure_count + 1,
    last_repair_at: now(),
    last_repair_reason: reason,
    last_repair_scope: scope,
    last_repair_error: `${error}`,
  });
  pushEvent(consumer, "repair.failure", { reason, scope, error: `${error}` });
}

export function recordProjectionAckStart({
  consumer,
  id,
  name,
}: {
  consumer: string;
  id: string;
  name: string;
}): void {
  const state = stateFor(consumer);
  state.pending_acks[id] = { name, started_at: now() };
  Object.assign(state, {
    ack_count: state.ack_count + 1,
    last_ack_at: now(),
    last_ack_name: name,
    last_ack_state: "pending",
    last_ack_error: undefined,
  });
  pushEvent(consumer, "ack.start", { id, name });
}

export function recordProjectionAckConverged({
  consumer,
  id,
  name,
}: {
  consumer: string;
  id: string;
  name: string;
}): void {
  const state = stateFor(consumer);
  delete state.pending_acks[id];
  Object.assign(state, {
    last_ack_at: now(),
    last_ack_name: name,
    last_ack_state: "converged",
    last_ack_error: undefined,
  });
  pushEvent(consumer, "ack.converged", { id, name });
}

export function recordProjectionAckFailed({
  consumer,
  id,
  name,
  error,
}: {
  consumer: string;
  id: string;
  name: string;
  error: unknown;
}): void {
  const state = stateFor(consumer);
  delete state.pending_acks[id];
  Object.assign(state, {
    ack_failure_count: state.ack_failure_count + 1,
    last_ack_at: now(),
    last_ack_name: name,
    last_ack_state: "failed",
    last_ack_error: `${error}`,
  });
  pushEvent(consumer, "ack.failed", { id, name, error: `${error}` });
}

export function collectProjectionDiagnostics() {
  return {
    consumers: Object.fromEntries(
      Object.entries(states).map(([name, state]) => [
        name,
        {
          ...state,
          pending_acks: { ...state.pending_acks },
        },
      ]),
    ),
    recentEvents: recentEvents.slice(),
  };
}

export function resetProjectionDiagnosticsForTests(): void {
  for (const key of Object.keys(states)) {
    delete states[key];
  }
  recentEvents.length = 0;
}
