import { readFile } from "node:fs/promises";
import {
  agentRpcSourceKey,
  validateAgentEndpoint,
  type AgentEndpoint,
  type AgentRpcTarget,
} from "@cocalc/conat/agents/rpc";
import type { AgentNetworkDiscovery } from "@cocalc/conat/agents/personal";
import { readIdentityCredential, sendIdentityMessage } from "./agent-message";

export interface AgentNameBinding {
  name: string;
  target: AgentEndpoint;
}

export interface ResolvedAgentDestination {
  target: AgentRpcTarget;
  agent_network_id: string;
  agent_network_title: string;
}

export function matchesAgentNetwork(
  network: AgentNetworkDiscovery["peers"][number]["networks"][number],
  selector?: string,
): boolean {
  return (
    selector === undefined ||
    network.agent_network_id === selector ||
    network.title === selector
  );
}

export function selectAgentNetwork(
  networks: AgentNetworkDiscovery["peers"][number]["networks"],
  selector?: string,
) {
  const matches = networks.filter((network) =>
    matchesAgentNetwork(network, selector),
  );
  if (selector !== undefined && matches.length !== 1) return;
  return [...matches].sort(
    (a, b) =>
      Number(b.delivery_mode === "live") - Number(a.delivery_mode === "live") ||
      a.title.localeCompare(b.title) ||
      a.agent_network_id.localeCompare(b.agent_network_id),
  )[0];
}

export function resolveAgentName(
  input: string,
  directory: AgentNetworkDiscovery,
  references: AgentNameBinding[] = [],
  requestedNetwork?: string,
): ResolvedAgentDestination {
  const name = input.trim().replace(/^@/, "");
  if (!/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(name))
    throw new Error("Use an exact lowercase agent name, such as reviewer");
  // A selected mention remains pinned even if the account directory changes.
  const selected = references.filter((ref) => ref.name === name);
  if (!selected.length) {
    // Names are resolved from the current account-home network directory.
  }
  const peers = directory.peers.filter(({ member }) =>
    member.kind === "registered"
      ? member.name === name
      : member.label.trim().toLowerCase() === name,
  );
  const pinned = selected.map((ref) => ref.target);
  const matches = pinned.length
    ? peers.filter(
        ({ member }) =>
          member.kind === "registered" &&
          pinned.some(
            (target) =>
              target.agent_id === member.endpoint.agent_id &&
              target.project_id === member.endpoint.project_id,
          ),
      )
    : peers;
  if (!matches.length)
    throw new Error(
      `No approved destination or current-turn mention named @${name}. Discover destinations or select the agent in the human composer; no message was sent.`,
    );
  for (const { member } of matches)
    if (member.kind === "registered") validateAgentEndpoint(member.endpoint);
  const first = matches[0];
  const target =
    first.member.kind === "registered"
      ? first.member.endpoint
      : first.member.source;
  if (
    matches.some(({ member }) => {
      const candidate =
        member.kind === "registered" ? member.endpoint : member.source;
      return agentRpcSourceKey(candidate) !== agentRpcSourceKey(target);
    })
  )
    throw new Error(`Ambiguous agent reference @${name}; no message was sent`);
  const network = selectAgentNetwork(first.networks, requestedNetwork);
  if (!network)
    throw new Error(
      requestedNetwork === undefined
        ? `No active Agent Network includes @${name}; no message was sent`
        : `@${name} is not in one unambiguous Agent Network named ${JSON.stringify(requestedNetwork)}; no message was sent`,
    );
  return {
    target,
    agent_network_id: network.agent_network_id,
    agent_network_title: network.title,
  };
}

export async function readTurnAgentReferences(): Promise<AgentNameBinding[]> {
  const path = process.env.COCALC_AGENT_MENTION_REFERENCES_FILE;
  if (!path) return [];
  const credential = await readIdentityCredential();
  const value = JSON.parse(await readFile(path, "utf8"));
  if (
    value?.agent_id !== credential.agent_id ||
    value?.run_id !== credential.run_id ||
    !Array.isArray(value.references) ||
    value.references.length > 100
  )
    throw new Error("Agent mention references do not match this runtime turn");
  for (const ref of value.references) {
    if (typeof ref?.name !== "string")
      throw new Error("Invalid runtime agent name reference");
    validateAgentEndpoint(ref.target);
  }
  return value.references;
}

export async function resolveRuntimeAgentName(
  name: string,
  apiUrl?: string,
  requestedNetwork?: string,
): Promise<ResolvedAgentDestination> {
  const references = await readTurnAgentReferences();
  const destinations = (await sendIdentityMessage(
    { version: 3, action: "destinations" },
    apiUrl,
  )) as AgentNetworkDiscovery;
  return resolveAgentName(name, destinations, references, requestedNetwork);
}
