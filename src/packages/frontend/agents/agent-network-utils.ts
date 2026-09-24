import type { AgentNetwork } from "@cocalc/conat/agents/personal";

const COLORS = [
  "blue",
  "cyan",
  "green",
  "gold",
  "orange",
  "magenta",
  "volcano",
  "geekblue",
  "lime",
] as const;

function hash(value: string): number {
  let result = 0;
  for (let i = 0; i < value.length; i += 1) {
    result = (result * 31 + value.charCodeAt(i)) >>> 0;
  }
  return result;
}

export function networkColor(network: AgentNetwork) {
  return COLORS[hash(network.agent_network_id) % COLORS.length];
}

export function duplicateNetworkTitle(
  networks: AgentNetwork[],
  title: string,
  exceptId?: string,
): boolean {
  const normalized = title.trim().toLocaleLowerCase();
  return (
    !!normalized &&
    networks.some(
      (network) =>
        network.agent_network_id !== exceptId &&
        network.title.trim().toLocaleLowerCase() === normalized,
    )
  );
}

export function networkProjectCount(network: AgentNetwork): number {
  return new Set(
    network.members.flatMap((member) =>
      member.kind === "registered" ? [member.endpoint.project_id] : [],
    ),
  ).size;
}
