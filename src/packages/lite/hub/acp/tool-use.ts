/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Whether a turn acted (ran a command, wrote a file, ...), from its stream,
// for the turn's outcome: a sender told nothing ran may safely resend.

import type { AcpStreamPayload } from "@cocalc/conat/ai/acp/types";

/** Events that mean the agent acted, except terminals (see the tracker). */
function isToolEvent(payload: AcpStreamPayload): boolean {
  if (payload.type !== "event") return false;
  const event = payload.event;
  switch (event.type) {
    case "file":
    case "diff":
    case "image":
    case "subagent":
    case "peerMessage":
      return true;
    case "harness": {
      // A tool call counts once it runs, not while it waits for permission
      // (which may be refused or canceled). "failed" ran too: it may have
      // changed something before it failed, and an agent need not report
      // in_progress first.
      const data = event.data as { sessionUpdate?: unknown; status?: unknown };
      return (
        (data?.sessionUpdate === "tool_call" ||
          data?.sessionUpdate === "tool_call_update") &&
        (data.status === "in_progress" ||
          data.status === "completed" ||
          data.status === "failed")
      );
    }
    default:
      return false;
  }
}

/**
 * A command announced (terminal start) may still be declined, which ends it
 * without running; output or any other exit means it ran. A command still
 * announced when the turn ends counts as run: it may have been cut off while
 * running, and "check before resending" is the safe mistake.
 */
export function toolUseTracker() {
  let ran = false;
  const announced = new Set<string>();
  return {
    observe(payload?: AcpStreamPayload | null): void {
      if (!payload || ran) return;
      if (payload.type === "event" && payload.event.type === "terminal") {
        const { terminalId, phase } = payload.event;
        if (phase === "start") announced.add(terminalId);
        else if (phase === "exit" && payload.event.declined)
          announced.delete(terminalId);
        else ran = true;
        return;
      }
      if (isToolEvent(payload)) ran = true;
    },
    get ran(): boolean {
      return ran || announced.size > 0;
    },
  };
}
