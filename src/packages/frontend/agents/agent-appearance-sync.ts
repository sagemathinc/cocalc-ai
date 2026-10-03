/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Agent themes live in .chat thread metadata; each agent's identity record
// keeps a copy so lists show the right badge and title before the chat loads.

import type { NamedAgent } from "@cocalc/conat/agents/personal";
import {
  normalizeAgentAppearance,
  type AgentAppearance,
} from "@cocalc/util/agent-appearance";
import type { AgentHeaderAppearance } from "./workspace-header-theme";

// The stored copy, overridden by themes read from loaded chats.
export function mergeAgentAppearances(
  agents: NamedAgent[],
  loaded: Map<string, AgentHeaderAppearance>,
): Map<string, AgentHeaderAppearance> {
  const merged = new Map<string, AgentHeaderAppearance>();
  for (const agent of agents)
    if (agent.appearance) merged.set(agent.endpoint.agent_id, agent.appearance);
  for (const [id, appearance] of loaded) merged.set(id, appearance);
  return merged;
}

// Loaded themes that differ from the stored copy and were not already sent
// (`sent` maps agent_id to the last value sent).
export function appearanceWrites(
  agents: NamedAgent[],
  loaded: Map<string, AgentHeaderAppearance>,
  sent: Map<string, string>,
): {
  project_id: string;
  agent_id: string;
  appearance: AgentAppearance | null;
  key: string;
}[] {
  const writes: ReturnType<typeof appearanceWrites> = [];
  for (const [agent_id, value] of loaded) {
    const agent = agents.find(({ endpoint }) => endpoint.agent_id === agent_id);
    if (!agent) continue;
    let appearance: AgentAppearance | null;
    try {
      appearance = normalizeAgentAppearance(value);
    } catch {
      continue; // Too long to store; the chat still shows it.
    }
    const key = JSON.stringify(appearance);
    if (
      key === JSON.stringify(normalizeAgentAppearance(agent.appearance)) ||
      sent.get(agent_id) === key
    )
      continue;
    writes.push({
      project_id: agent.endpoint.project_id,
      agent_id,
      appearance,
      key,
    });
  }
  return writes;
}
