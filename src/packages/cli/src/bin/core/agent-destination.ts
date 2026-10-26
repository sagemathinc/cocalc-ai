import { readFile } from "node:fs/promises";
import {
  agentRpcSourceKey,
  validateAgentEndpoint,
  validateAgentRpcTarget,
  type AgentRpcTarget,
} from "@cocalc/conat/agents/rpc";
import { externalAgentHandle } from "@cocalc/conat/agents/external";
import type { AgentNetworkDiscovery } from "@cocalc/conat/agents/personal";
import { readIdentityCredential, sendIdentityMessage } from "./agent-message";

/** A current-turn mention: a registered agent, or one on another site. */
export interface AgentNameBinding {
  name: string;
  target: AgentRpcTarget;
}

export interface ResolvedAgentDestination {
  target: AgentRpcTarget;
  agent_network_id: string;
  agent_network_title: string;
  delivery_mode?: AgentNetworkDiscovery["peers"][number]["networks"][number]["delivery_mode"];
  project_title?: string;
}

const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

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

/**
 * The peers in the requested network, when one is requested and any are: an
 * explicit network disambiguates peers sharing a name in different networks
 * (external labels need not be unique). Otherwise all of them, so the
 * network check reports the mismatch.
 */
function inRequestedNetwork<
  T extends { networks: AgentNetworkDiscovery["peers"][number]["networks"] },
>(peers: T[], requestedNetwork?: string): T[] {
  if (requestedNetwork === undefined) return peers;
  const inside = peers.filter(({ networks }) =>
    networks.some((network) => matchesAgentNetwork(network, requestedNetwork)),
  );
  return inside.length ? inside : peers;
}

export function resolveAgentName(
  input: string,
  directory: AgentNetworkDiscovery,
  references: AgentNameBinding[] = [],
  requestedNetwork?: string,
): ResolvedAgentDestination {
  // An external label is free text and may itself start with "@": it is
  // compared as typed; "@" is only dropped for names, handles and ids.
  const raw = input.trim();
  const name = raw.replace(/^@/, "");
  const isLabel = (label: string) => {
    const value = label.trim().toLowerCase();
    return value === raw.toLowerCase() || value === name.toLowerCase();
  };
  // A peer's member id, or an external agent's full label (what discovery
  // shows for it), name it too.
  const byId: boolean = isUuid(name as unknown);
  const byLabel =
    !byId &&
    directory.peers.some(
      ({ member }) => member.kind === "external" && isLabel(member.label),
    );
  if (!byId && !byLabel && !/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(name))
    throw new Error("Use an exact lowercase agent name, such as reviewer");
  // A selected mention remains pinned even if the account directory changes.
  const selected = references.filter((ref) => ref.name === name);
  if (!selected.length) {
    // Names are resolved from the current account-home network directory.
  }
  // Every peer the input could name, by any of these: two different ones
  // are ambiguous below, never a silent pick.
  const peers = directory.peers.filter(({ member }) =>
    member.kind === "registered"
      ? member.name === name ||
        (byId &&
          (member.member_id === name || member.endpoint.agent_id === name))
      : externalAgentHandle(member.label) === name ||
        isLabel(member.label) ||
        (byId && member.member_id === name),
  );
  // Either kind, by its exact identity (UUIDs in any case).
  const pinned = new Set(selected.map((ref) => targetKey(ref.target)));
  const candidates = inRequestedNetwork(peers, requestedNetwork);
  const matches = pinned.size
    ? candidates.filter((peer) => pinned.has(targetKey(peerTarget(peer))))
    : candidates;
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
    delivery_mode: network.delivery_mode,
    ...(first.member.kind === "registered" && first.member.project_title
      ? { project_title: first.member.project_title }
      : {}),
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
    validateAgentRpcTarget(ref.target);
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

type Peer = AgentNetworkDiscovery["peers"][number];

function peerTarget({ member }: Peer): AgentRpcTarget {
  return member.kind === "registered" ? member.endpoint : member.source;
}

function targetKey(target: AgentRpcTarget): string {
  return agentRpcSourceKey(target).toLowerCase();
}

function peerName({ member }: Peer): string {
  return (member.kind === "registered" ? member.name : member.label) ?? "";
}

/** The @name to send to: a registered agent's name, an external's handle. */
export function peerHandle({ member }: Peer): string | undefined {
  return member.kind === "registered"
    ? member.name
    : externalAgentHandle(member.label);
}

/**
 * Read one --targets entry: a peer name, or the target in any of the shapes
 * discovery prints (an endpoint, a member with an endpoint, a peer with a
 * member). Returns a name to look up, or an explicit target.
 */
export function parseBroadcastTarget(
  entry: unknown,
  index: number,
):
  | { name: string }
  | { member_id: string; name?: string }
  | { target: AgentRpcTarget } {
  const where = `--targets[${index}]`;
  if (typeof entry === "string") {
    // Kept as typed: a full external label may start with "@".
    const name = entry.trim();
    const bare = name.replace(/^@/, "");
    // A UUID typed as a string may be a member id, or a peer's free-text
    // label that happens to look like one: both are candidates, and two
    // different peers are ambiguous below, as agent send refuses them.
    return isUuid(bare) ? { member_id: bare, name } : { name };
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    throw new Error(
      `${where}: expected a peer name or an object with project_id and agent_id`,
    );
  let value: any = entry;
  if (value.member && typeof value.member === "object") value = value.member;
  if (value.kind === "external" && value.source) value = value.source;
  if (value.endpoint && typeof value.endpoint === "object")
    value = value.endpoint;
  let target: AgentRpcTarget;
  if (value.kind === "external") {
    target = value;
  } else if (value.project_id !== undefined || value.agent_id !== undefined) {
    target = { project_id: value.project_id, agent_id: value.agent_id };
  } else if (isUuid(value.member_id)) {
    return { member_id: value.member_id };
  } else if (typeof value.name === "string") {
    return { name: value.name };
  } else {
    throw new Error(
      `${where}: expected a peer name or an object with project_id and agent_id`,
    );
  }
  try {
    validateAgentRpcTarget(target);
  } catch (error) {
    throw new Error(`${where}: ${(error as Error).message}`);
  }
  return { target };
}

/**
 * Turn --targets (or --to names) into explicit targets and the one Agent
 * Network they all share. The directory is only needed for names, member
 * ids, a network given by title, or no network at all.
 */
export function resolveBroadcastTargets(
  entries: unknown[],
  directory: AgentNetworkDiscovery | undefined,
  requestedNetwork?: string,
): {
  targets: AgentRpcTarget[];
  names: (string | undefined)[];
  agent_network_id: string;
  agent_network_title?: string;
} {
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error("--targets must be a non-empty JSON array");
  const parsed = entries.map(parseBroadcastTarget);
  if (!directory) {
    if (!isUuid(requestedNetwork) || parsed.some((p) => !("target" in p)))
      throw new Error("Agent discovery is required to resolve these targets");
    return {
      targets: parsed.map((p) => (p as { target: AgentRpcTarget }).target),
      names: parsed.map(() => undefined),
      agent_network_id: requestedNetwork as string,
    };
  }
  const peers = parsed.map((p, index) => {
    const where = `--targets[${index}]`;
    const named = directory.peers.filter((peer) =>
      "target" in p
        ? agentRpcSourceKey(peerTarget(peer)) === agentRpcSourceKey(p.target)
        : "member_id" in p
          ? peer.member.member_id === p.member_id ||
            (peer.member.kind === "registered" &&
              peer.member.endpoint.agent_id === p.member_id) ||
            (p.name != null &&
              [p.name, p.name.replace(/^@/, "")].some(
                (name) =>
                  peerName(peer).trim().toLowerCase() === name.toLowerCase(),
              ))
          : [p.name, p.name.replace(/^@/, "")].some(
              (name) =>
                peerName(peer).trim().toLowerCase() === name.toLowerCase(),
            ) || peerHandle(peer) === p.name.replace(/^@/, "").toLowerCase(),
    );
    const matches = inRequestedNetwork(named, requestedNetwork);
    if (matches.length === 0)
      throw new Error(
        `${where}: no network peer ${"name" in p ? `named @${p.name}` : "matches this target"}; run agent destinations. No message was sent.`,
      );
    if (
      new Set(matches.map((peer) => agentRpcSourceKey(peerTarget(peer)))).size >
      1
    )
      throw new Error(`${where}: ambiguous peer; no message was sent`);
    return matches[0];
  });
  const shared = peers[0].networks.filter((network) =>
    peers.every((peer) =>
      peer.networks.some(
        (other) => other.agent_network_id === network.agent_network_id,
      ),
    ),
  );
  const network = selectAgentNetwork(shared, requestedNetwork);
  if (!network)
    throw new Error(
      shared.length === 0
        ? "No single Agent Network includes all of these targets; no message was sent"
        : `None of the shared Agent Networks (${shared
            .map(({ title }) => JSON.stringify(title))
            .join(
              ", ",
            )}) matches --agent-network ${JSON.stringify(requestedNetwork)}; no message was sent`,
    );
  return {
    targets: peers.map(peerTarget),
    names: peers.map(peerName),
    agent_network_id: network.agent_network_id,
    agent_network_title: network.title,
  };
}
