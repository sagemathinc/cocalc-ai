/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Where finished agent turns report what they used (util/ai/agent-turn-usage).
// The process running turns installs a recorder: the project host sends each
// one to the account's home bay. Recording is best effort and never fails or
// delays a turn.

import { randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import type { AgentTurnUsage } from "@cocalc/util/ai/agent-turn-usage";

const logger = getLogger("ai:acp:turn-usage");

export type AgentTurnUsageRecorder = (
  account_id: string,
  usage: AgentTurnUsage,
) => void | Promise<void>;

let recorder: AgentTurnUsageRecorder | undefined;

export function setAgentTurnUsageRecorder(next?: AgentTurnUsageRecorder): void {
  recorder = next;
}

export function recordAgentTurnUsage(
  account_id: string | undefined,
  usage: AgentTurnUsage,
): void {
  if (!recorder || !account_id || !usage.models.length) return;
  try {
    // One identity per turn, so a report the host resends is stored once.
    const report = usage.turn_id ? usage : { ...usage, turn_id: randomUUID() };
    void Promise.resolve(recorder(account_id, report)).catch((error) =>
      logger.debug("turn usage not recorded", { error: `${error}` }),
    );
  } catch (error) {
    logger.debug("turn usage not recorded", { error: `${error}` });
  }
}
