/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { AgentNetwork, NamedAgent } from "@cocalc/conat/agents/personal";

export function agentNetworkLookupKey(projectId: string, agentId: string) {
  return `${projectId}:${agentId}`;
}

export function indexAgentNetworks(networks: AgentNetwork[]) {
  const byAgent = new Map<string, AgentNetwork[]>();
  for (const network of networks) {
    if (network.state === "closed") continue;
    for (const member of network.members) {
      if (member.kind !== "registered" || member.removed_at) continue;
      const key = agentNetworkLookupKey(
        member.endpoint.project_id,
        member.endpoint.agent_id,
      );
      const matches = byAgent.get(key) ?? [];
      if (!matches.includes(network)) matches.push(network);
      byAgent.set(key, matches);
    }
  }
  return byAgent;
}

export function matchesAgentSidebarSearch({
  agent,
  appearanceName,
  networks,
  query,
}: {
  agent: NamedAgent;
  appearanceName?: string;
  networks: AgentNetwork[];
  query: string;
}): boolean {
  const value = query.trim().toLocaleLowerCase();
  if (!value) return true;
  if (value.startsWith("tag:")) {
    const tag = value.slice(4).trim();
    return networks.some((network) =>
      network.title.toLocaleLowerCase().includes(tag),
    );
  }
  return [
    agent.name,
    appearanceName,
    agent.thread_title,
    agent.project_title,
    agent.description,
    ...networks.map((network) => network.title),
  ]
    .filter(Boolean)
    .some((part) => `${part}`.toLocaleLowerCase().includes(value));
}
