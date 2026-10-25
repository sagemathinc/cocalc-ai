/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Agent memory lives on the account's home bay. Whichever bay receives a
// memory request (an agent turn's CLI, a project host loading the turn index,
// or the owner's settings page) runs it there.

import type { AgentMemoryHomeRequest } from "@cocalc/conat/agents/memory";
import {
  createAgentRpcControlClient,
  type AgentRpcControlApi,
} from "@cocalc/conat/inter-bay/agent-rpc";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { isValidUUID } from "@cocalc/util/misc";
import { agentMemory } from "./memory";

function validate(account_id: string, request: AgentMemoryHomeRequest) {
  if (!isValidUUID(account_id)) throw new Error("invalid account");
  if (
    (request?.kind === "agent" || request?.kind === "turn-index") &&
    isValidUUID(request.project_id)
  )
    return;
  if (request?.kind === "owner") return;
  if (request?.kind === "agent-retired" && isValidUUID(request.agent_id))
    return;
  throw new Error("invalid agent memory request");
}

export async function withMemoryHome(
  account_id: string,
  request: AgentMemoryHomeRequest,
): Promise<any> {
  validate(account_id, request);
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  if (!home_bay_id) throw new Error("account home unavailable");
  if (home_bay_id === getConfiguredBayId())
    return await memoryHomeControl({ account_id, home_bay_id, request });
  return await createAgentRpcControlClient(
    getInterBayFabricClient(),
    home_bay_id,
  ).memory({ account_id, home_bay_id, request });
}

/** Runs on the account's home bay; refuses a request routed anywhere else. */
export const memoryHomeControl: AgentRpcControlApi["memory"] = async ({
  account_id,
  home_bay_id,
  request,
}) => {
  validate(account_id, request);
  const home = await resolveAccountHomeBay({ account_id });
  if (
    home.home_bay_id !== getConfiguredBayId() ||
    home_bay_id !== home.home_bay_id
  )
    throw new Error("stale agent memory home route");
  const memory = agentMemory();
  switch (request.kind) {
    case "agent":
      return await memory.agent(
        account_id,
        request.project_id,
        request.request,
        request.agent,
      );
    case "turn-index":
      return (
        (await memory.turnIndex(account_id, request.project_id, request.agent, {
          reportOff: request.report_off === true,
        })) ?? null
      );
    case "owner":
      return await memory.owner(account_id, request.request);
    case "agent-retired":
      return await memory.agentRetired(account_id, request.agent_id);
  }
};
