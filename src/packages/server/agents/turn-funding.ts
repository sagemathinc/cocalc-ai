/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { AgentApi } from "@cocalc/conat/hub/api/agent";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import {
  parseAgentTurnFunding,
  type AgentTurnFunding,
} from "@cocalc/util/ai/agent-turn-funding";
import getLogger from "@cocalc/backend/logger";
import { assertActor } from "./access";
import { withAgentIdentityOwner } from "./identity-routing";
import { agentStore } from "./store";

const logger = getLogger("server:agents:turn-funding");

// A human send records how that account pays for the agent's turns; agent
// messages to the agent then reuse it. Writes come only from the account's own
// session (agent credentials are not on the agent hub allowlist).
export const setNextTurnFunding: AgentApi["setNextTurnFunding"] = async (
  opts,
) => {
  requireUuid(opts.account_id, "account_id");
  const request = {
    account_id: opts.account_id,
    project_id: opts.project_id,
    path: opts.path,
    thread_id: opts.thread_id,
    funding: opts.funding,
  };
  return withAgentIdentityOwner({
    project_id: opts.project_id,
    local: () => setNextTurnFundingLocal(request),
    remote: (api, route) => api.setNextTurnFunding({ ...request, route }),
  });
};

export const setNextTurnFundingLocal: AgentApi["setNextTurnFunding"] = async (
  opts,
) => {
  requireUuid(opts.account_id, "account_id");
  requireUuid(opts.project_id, "project_id");
  if (
    typeof opts.thread_id !== "string" ||
    !opts.thread_id ||
    opts.thread_id.length > 200
  )
    throw new Error("invalid thread_id");
  const funding = parseAgentTurnFunding(opts.funding);
  await assertActor(opts.account_id!, opts.project_id);
  const agent = await agentStore().find(
    opts.project_id,
    opts.path,
    opts.thread_id,
  );
  // Only registered agents can receive agent messages.
  if (!agent) return { recorded: false };
  await agentStore().query(
    `INSERT INTO agent_turn_funding(agent_id,account_id,project_id,funding,updated_at)
     VALUES($1,$2,$3,$4::jsonb,now())
     ON CONFLICT(agent_id,account_id)
     DO UPDATE SET funding=EXCLUDED.funding,updated_at=now()`,
    [
      agent.agent_id,
      opts.account_id,
      agent.project_id,
      JSON.stringify(funding),
    ],
  );
  return { recorded: true };
};

// Owner-bay read used during agent-message admission. A record that no longer
// parses is treated as absent, so admission asks for a fresh human send.
export async function getNextTurnFunding({
  agent_id,
  account_id,
}: {
  agent_id: string;
  account_id: string;
}): Promise<AgentTurnFunding | undefined> {
  const row = (
    await agentStore().query<{ funding: unknown }>(
      "SELECT funding FROM agent_turn_funding WHERE agent_id=$1 AND account_id=$2",
      [agent_id, account_id],
    )
  ).rows[0];
  if (!row) return;
  try {
    return parseAgentTurnFunding(row.funding);
  } catch (err) {
    logger.warn("ignoring invalid agent turn funding", {
      agent_id,
      err: `${err}`,
    });
    return;
  }
}
