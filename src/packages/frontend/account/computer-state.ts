/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What a computer is now, in one word, the same everywhere (settings, the
// @ picker, the composer's Connectors menu, the send check). Design:
// src/.agents/computers-lifecycle-ui-2026-10-12.md.

import type { ComputerSummary } from "@cocalc/util/computers/api";

export type ComputerState = "connected" | "offline" | "ended";

/** Ended computers stay listed this long, so they can be reconnected. */
export const SHOW_ENDED_MS = 24 * 60 * 60 * 1000;

/** When it ended (disconnected, or its time ran out), if it has. */
export function endedAt(c: ComputerSummary, now = Date.now()): number | null {
  if (c.revoked_at != null) return c.revoked_at;
  if (c.deadline != null && c.deadline <= now) return c.deadline;
  return null;
}

export function computerState(
  c: ComputerSummary,
  now = Date.now(),
): ComputerState {
  if (endedAt(c, now) != null) return "ended";
  return c.connected ? "connected" : "offline";
}

export const STATE_LABEL: Record<ComputerState, string> = {
  connected: "Connected",
  offline: "Offline",
  ended: "Ended",
};

export const STATE_COLOR: Record<ComputerState, string | undefined> = {
  connected: "green",
  offline: "orange",
  ended: undefined,
};

/** Worth showing: everything but computers that ended over a day ago. */
export function isListed(c: ComputerSummary, now = Date.now()): boolean {
  const ended = endedAt(c, now);
  return ended == null || ended > now - SHOW_ENDED_MS;
}

/** With a time limit its key lives only in its connector: it can't resume. */
export function hasTimeLimit(c: ComputerSummary): boolean {
  return c.effective_policy?.duration != null;
}

/**
 * How to get it connected again: a computer without a time limit resumes by
 * running its connector again; any other is paired again.
 */
export function reconnectKind(
  c: ComputerSummary,
  now = Date.now(),
): "resume" | "pair" {
  return computerState(c, now) === "offline" && !hasTimeLimit(c)
    ? "resume"
    : "pair";
}
