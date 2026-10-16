/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What a computer is now, in one word, the same everywhere (settings, the
// @ picker, the composer's Connectors menu, the send check).

import type { ComputerSummary } from "@cocalc/util/computers/api";

export type ComputerState = "connected" | "offline" | "ended";

/** Revoked computers stay listed this long, so the owner sees what happened. */
export const SHOW_ENDED_MS = 24 * 60 * 60 * 1000;

export function computerState(c: ComputerSummary): ComputerState {
  if (c.revoked_at != null) return "ended";
  return c.online ? "connected" : "offline";
}

export const STATE_LABEL: Record<ComputerState, string> = {
  connected: "Connected",
  offline: "Offline",
  ended: "Revoked",
};

export const STATE_COLOR: Record<ComputerState, string | undefined> = {
  connected: "green",
  offline: "orange",
  ended: undefined,
};

/** Worth showing: everything but computers revoked over a day ago. */
export function isListed(c: ComputerSummary, now = Date.now()): boolean {
  return c.revoked_at == null || c.revoked_at > now - SHOW_ENDED_MS;
}
