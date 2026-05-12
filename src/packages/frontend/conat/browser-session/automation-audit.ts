/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  BrowserAutomationAuditDecision,
  BrowserAutomationAuditEvent,
  BrowserAutomationAuditKind,
} from "@cocalc/conat/service/browser-session";

type PendingBrowserAutomationAuditEvent = Omit<
  BrowserAutomationAuditEvent,
  "seq" | "ts"
>;

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function createBrowserAutomationAuditBuffer(maxEvents = 2_000) {
  const events: BrowserAutomationAuditEvent[] = [];
  const max = normalizePositiveInteger(maxEvents, 2_000);
  let seq = 0;
  let dropped = 0;

  const append = (event: PendingBrowserAutomationAuditEvent): void => {
    seq += 1;
    events.push({
      ...event,
      seq,
      ts: new Date().toISOString(),
    });
    if (events.length <= max) return;
    const extra = events.length - max;
    events.splice(0, extra);
    dropped += extra;
  };

  const list = ({
    after_seq,
    limit,
    kinds,
    decisions,
  }: {
    after_seq?: number;
    limit?: number;
    kinds?: BrowserAutomationAuditKind[];
    decisions?: BrowserAutomationAuditDecision[];
  } = {}) => {
    const afterSeq = Math.max(0, Math.floor(Number(after_seq ?? 0) || 0));
    const rowLimit = Math.min(
      max,
      Math.max(1, Math.floor(Number(limit ?? 200) || 200)),
    );
    const kindSet = Array.isArray(kinds) ? new Set(kinds) : undefined;
    const decisionSet = Array.isArray(decisions)
      ? new Set(decisions)
      : undefined;
    const selected = events
      .filter((event) => event.seq > afterSeq)
      .filter((event) => !kindSet || kindSet.has(event.kind))
      .filter((event) => !decisionSet || decisionSet.has(event.decision))
      .slice(-rowLimit);
    return {
      events: selected,
      next_seq: seq,
      dropped,
      total_buffered: events.length,
    };
  };

  const clear = () => {
    const cleared = events.length;
    events.splice(0, events.length);
    return {
      ok: true as const,
      cleared,
      next_seq: seq,
    };
  };

  const reset = (): void => {
    events.splice(0, events.length);
    seq = 0;
    dropped = 0;
  };

  return { append, list, clear, reset };
}
