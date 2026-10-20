/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A mark on an agent's row when it can't take turns right now: its last
// turn hit a usage limit (until it resets) or its sign-in needs renewing.
// Busy and idle need no mark: the badge's running indicator shows those.

import { Icon } from "@cocalc/frontend/components";
import {
  agentTurnStatusText,
  type AgentTurnStatus,
} from "@cocalc/conat/agents/agent-status";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const localTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

export function AgentStatusMark({
  status,
  now = Date.now(),
}: {
  status?: AgentTurnStatus | null;
  now?: number;
}) {
  if (!status?.unavailable) return null;
  const text = agentTurnStatusText(status, now, localTime);
  // Stale, or a limit that has reset.
  if (!text?.startsWith("unavailable")) return null;
  const label = text.charAt(0).toUpperCase() + text.slice(1);
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
