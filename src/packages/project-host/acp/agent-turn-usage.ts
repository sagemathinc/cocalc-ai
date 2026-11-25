/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Send what each agent turn used (Claude and Codex) to the hub, which keeps
// it on the account's home bay for usage by agent. Batched, bounded and best
// effort: a lost report only loses one turn's numbers.

import callHub from "@cocalc/conat/hub/call-hub";
import getLogger from "@cocalc/backend/logger";
import { isValidUUID } from "@cocalc/util/misc";
import {
  parseAgentTurnUsage,
  type AgentTurnUsage,
} from "@cocalc/util/ai/agent-turn-usage";
import { getMasterConatClient } from "../master-conat-client";
import { getLocalHostId } from "../sqlite/hosts";

const logger = getLogger("project-host:acp:agent-turn-usage");

export const MAX_TURN_USAGE_BATCH = 50;
const MAX_QUEUED = 1_000;
const FLUSH_MS = 10_000;

export type TurnUsageReport = { owner_account_id: string; usage: AgentTurnUsage };

type Write = (reports: TurnUsageReport[]) => Promise<void>;

const writeToHub: Write = async (reports) => {
  const client = getMasterConatClient();
  const host_id = getLocalHostId();
  if (!client || !host_id) return;
  await callHub({
    client,
    host_id,
    name: "hosts.recordAgentTurnUsage",
    // The hub reserves account_id for the caller; name each owner explicitly.
    args: [{ reports }],
    timeout: 15_000,
  });
};

export function createAgentTurnUsageRecorder({
  write = writeToHub,
  flushMs = FLUSH_MS,
}: { write?: Write; flushMs?: number } = {}) {
  let queue: TurnUsageReport[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    timer = undefined;
    while (queue.length) {
      const batch = queue.slice(0, MAX_TURN_USAGE_BATCH);
      queue = queue.slice(batch.length);
      try {
        await write(batch);
      } catch (error) {
        logger.debug("agent turn usage not saved", {
          turns: batch.length,
          error: `${error}`,
        });
      }
    }
  };
  const record = (owner_account_id: string, usage: AgentTurnUsage): void => {
    if (!isValidUUID(owner_account_id)) return;
    const parsed = parseAgentTurnUsage(usage);
    if (!parsed) return;
    // Bounded: if the hub is unreachable for long, the oldest turns go.
    if (queue.length >= MAX_QUEUED) queue.shift();
    queue.push({ owner_account_id, usage: parsed });
    if (!timer) {
      timer = setTimeout(() => void flush(), flushMs);
      timer.unref?.();
    }
  };
  return Object.assign(record, { flush, size: () => queue.length });
}

export const recordAgentTurnUsageOnHub = createAgentTurnUsageRecorder();
