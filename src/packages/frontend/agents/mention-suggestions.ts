import type {
  AgentNetwork,
  ExternalAgentNetworkMember,
  NamedAgent,
} from "@cocalc/conat/agents/personal";
import { externalAgentHandle } from "@cocalc/conat/agents/external";

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

export interface ExternalMentionCandidate {
  member: ExternalAgentNetworkMember;
  /** The @name it is mentioned and sent to by (from its label). */
  handle: string;
  /** The network owner's account: the naming account of its reference. */
  account_id: string;
  connected: boolean;
  paused: boolean;
  group: string;
}

/**
 * Agents on other sites, from the person's own Agent Networks: each external
 * member once, under the handle `cocalc agent send` resolves it by. Like
 * named agents, only connected ones (or the selected network's) show until
 * the person searches or asks for all.
 */
export function externalAgentMentionSuggestions({
  networks,
  sourceEndpoint,
  selectedNetworkId,
  query,
  expanded = false,
  paused = false,
}: {
  networks: AgentNetwork[];
  /** The current agent's endpoint, when it has a name. */
  sourceEndpoint?: { project_id: string; agent_id: string };
  selectedNetworkId?: string;
  query: string;
  expanded?: boolean;
  paused?: boolean;
}): { rows: ExternalMentionCandidate[]; hasMore: boolean } {
  const hasSource = (network: AgentNetwork) =>
    !!sourceEndpoint &&
    network.members.some(
      (member) =>
        member.kind === "registered" &&
        !member.removed_at &&
        member.endpoint.agent_id === sourceEndpoint.agent_id &&
        member.endpoint.project_id === sourceEndpoint.project_id,
    );
  const key = (member: ExternalAgentNetworkMember) =>
    externalMemberKey(member.source);
  const rows = new Map<string, ExternalMentionCandidate & { rank: number }>();
  for (const network of networks)
    for (const member of network.members) {
      if (member.kind !== "external" || member.removed_at) continue;
      const handle = externalAgentHandle(member.label);
      if (!handle) continue;
      if (!`${handle} ${member.label}`.toLowerCase().includes(query)) continue;
      const shared = hasSource(network);
      const connected = !paused && shared && network.state === "active";
      const inSelected = network.agent_network_id === selectedNetworkId;
      const rank = inSelected ? 0 : connected ? 1 : 2;
      const previous = rows.get(key(member));
      if (previous && previous.rank <= rank) continue;
      rows.set(key(member), {
        member,
        handle,
        account_id: network.account_id,
        connected: connected || !!previous?.connected,
        paused:
          !connected && (paused || (shared && network.state === "paused")),
        rank,
        group: inSelected
          ? `${network.title} · Selected network`
          : "Agents on other sites",
      });
    }
  const all = [...rows.values()].sort(
    (a, b) =>
      Number(b.handle === query) - Number(a.handle === query) ||
      a.rank - b.rank ||
      a.handle.localeCompare(b.handle),
  );
  const visible =
    query || expanded ? all : all.filter((row) => row.rank < 2).slice(0, 8);
  return {
    rows: visible.map(({ rank: _rank, ...row }) => row),
    hasMore: visible.length < all.length,
  };
}

export function externalMemberKey(source: {
  account_id: string;
  agent_id: string;
  installation_id: string;
}): string {
  return `${source.account_id}/${source.agent_id}/${source.installation_id}`.toLowerCase();
}
