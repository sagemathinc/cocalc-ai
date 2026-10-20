/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A mark on an agent's row when it can't take turns right now: its last
// turn hit a usage limit (until it resets) or its sign-in needs renewing.
// Busy and idle need no mark: the badge's running indicator shows those.

import { useEffect, useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import {
  AGENT_TURN_STATUS_TTL_MS,
  agentTurnStatusText,
  type AgentTurnStatus,
} from "@cocalc/conat/agents/agent-status";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const localTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

/** "Unavailable until … (usage limit)", or undefined when it is available
 * (or its status is too old to say). Also part of the row's accessible name. */
export function agentUnavailableLabel(
  status: AgentTurnStatus | null | undefined,
  now = Date.now(),
): string | undefined {
  if (!status?.unavailable) return;
  const text = agentTurnStatusText(status, now, localTime);
  // Stale, or a limit that has reset.
  if (!text?.startsWith("unavailable")) return;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The agent row button's accessible name, its status included. */
export function agentRowLabel(
  parts: { title: string; name: string; project: string },
  status: AgentTurnStatus | null | undefined,
  now = Date.now(),
): string {
  const unavailable = agentUnavailableLabel(status, now);
  return `${parts.title}, @${parts.name}, ${parts.project}${unavailable ? `, ${unavailable}` : ""}`;
}

/** When this status next changes what it says: the limit resets, or it
 * becomes too old to mean anything. */
function nextChange(
  status: AgentTurnStatus | null | undefined,
  now: number,
): number | undefined {
  if (!status?.unavailable) return;
  const times = [status.at + AGENT_TURN_STATUS_TTL_MS];
  if (status.unavailable.until) times.push(status.unavailable.until);
  const next = Math.min(...times.filter((t) => t > now));
  return Number.isFinite(next) ? next : undefined;
}

export function AgentStatusMark({
  status,
  now: fixedNow,
}: {
  status?: AgentTurnStatus | null;
  /** Tests only: a fixed time. */
  now?: number;
}) {
  const [tick, setTick] = useState(0);
  const now = fixedNow ?? Date.now();
  // Re-render when what it says changes, even if nothing else does.
  useEffect(() => {
    if (fixedNow != null) return;
    const next = nextChange(status, Date.now());
    if (next == null) return;
    const timer = setTimeout(
      () => setTick((n) => n + 1),
      Math.min(2 ** 31 - 1, Math.max(1_000, next - Date.now() + 1_000)),
    );
    return () => clearTimeout(timer);
  }, [status, fixedNow, tick]);
  const label = agentUnavailableLabel(status, now);
  if (!label) return null;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{ color: UI_COLORS.warning, flex: "0 0 auto" }}
    >
      <Icon name="clock" />
    </span>
  );
}
