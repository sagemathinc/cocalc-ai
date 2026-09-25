import type { AgentNetwork, NamedAgent } from "@cocalc/conat/agents/personal";

export function agentMentionSuggestions({
  agents,
  networks,
  source,
  selectedNetworkId,
  query,
  activity = {},
  expanded = false,
  paused = false,
}: {
  agents: NamedAgent[];
  networks: AgentNetwork[];
  source?: { projectId: string; path: string; threadId?: string };
  selectedNetworkId?: string;
  query: string;
  activity?: Record<string, number>;
  expanded?: boolean;
  paused?: boolean;
}) {
  const current = agents.find(
    (agent) =>
      agent.endpoint.project_id === source?.projectId &&
      agent.path === source?.path &&
      agent.thread_id === source?.threadId,
  );
  const belongs = (network: AgentNetwork, agent: NamedAgent) =>
    network.members.some(
      (member) =>
        member.kind === "registered" &&
        !member.removed_at &&
        member.endpoint.agent_id === agent.endpoint.agent_id &&
        member.endpoint.project_id === agent.endpoint.project_id,
    );
  const selected = networks.find(
    (network) => network.agent_network_id === selectedNetworkId,
  );
  const connectedNetworks = current
    ? networks.filter(
        (network) => network.state === "active" && belongs(network, current),
      )
    : [];
  const rows = agents
    .filter(
      (agent) =>
        agent !== current &&
        `${agent.name} ${agent.description ?? ""} ${agent.thread_title ?? ""} ${agent.project_title ?? ""}`
          .toLowerCase()
          .includes(query),
    )
    .map((agent) => {
      const pausedConnection =
        paused ||
        networks.some(
          (network) =>
            current &&
            network.state === "paused" &&
            belongs(network, current) &&
            belongs(network, agent),
        );
      const connected =
        !paused && connectedNetworks.some((network) => belongs(network, agent));
      const inSelected = selected && belongs(selected, agent);
      return {
        agent,
        connected,
        paused: !connected && pausedConnection,
        rank: inSelected ? 0 : connected ? 1 : 2,
        group: inSelected
          ? `${selected.title} · Selected network`
          : connected
            ? "Connected agents"
            : "Other agents",
      };
    })
    .sort(
      (a, b) =>
        Number(b.agent.name.toLowerCase() === query) -
          Number(a.agent.name.toLowerCase() === query) ||
        a.rank - b.rank ||
        (activity[b.agent.endpoint.agent_id] ?? 0) -
          (activity[a.agent.endpoint.agent_id] ?? 0) ||
        a.agent.name.localeCompare(b.agent.name),
    );
  const visible =
    query || expanded ? rows : rows.filter((row) => row.rank < 2).slice(0, 8);
  return { rows: visible, hasMore: visible.length < rows.length };
}
