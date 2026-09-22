import type { ExternalAgentSource } from "./external";
import type { AgentEndpoint, AgentRpcSource } from "./rpc";

export type PersonalAgentDenialCode =
  | "approval_required"
  | "network_paused"
  | "network_closed"
  | "network_stale"
  | "not_a_member"
  | "principal_mismatch"
  | "account_disabled"
  | "agent_unavailable";

export interface PersonalAgentDenial {
  denied: PersonalAgentDenialCode;
}

/** Local exception only. Trusted inter-bay checks return denial data instead. */
export class PersonalAgentAuthorizationError extends Error {
  constructor(readonly denial: PersonalAgentDenialCode) {
    super(denial);
  }
}

export interface NamedAgent {
  account_id: string;
  name: string;
  endpoint: AgentEndpoint;
  path: string;
  thread_id: string;
  project_title?: string;
  thread_title?: string;
  description?: string;
  available: boolean;
  updated_at: string;
}

export interface PersonalMessagingControls {
  /** Blocks subsequent authority checks, not already admitted work. */
  paused: boolean;
  generation: number;
}

export interface NamedAgentDirectory {
  enabled: boolean;
  agents: NamedAgent[];
  usage?: { active: number; limit: number };
  controls?: PersonalMessagingControls;
}

export interface NameAgentOptions {
  endpoint: AgentEndpoint;
  name: string;
  description?: string;
  project_title?: string;
  thread_title?: string;
}

export interface RetireNamedAgentOptions {
  endpoint: AgentEndpoint;
}

export type AgentNetworkState = "active" | "paused" | "closed";
export type AgentNetworkDeliveryMode = "queued" | "live";

export interface RegisteredAgentNetworkMember {
  kind: "registered";
  member_id: string;
  endpoint: AgentEndpoint;
  name?: string;
  project_title?: string;
  thread_title?: string;
  available: boolean;
  added_at: string;
  removed_at?: string | null;
}

export interface ExternalAgentNetworkMember {
  kind: "external";
  member_id: string;
  source: ExternalAgentSource;
  label: string;
  available: boolean;
  added_at: string;
  removed_at?: string | null;
}

export type AgentNetworkMember =
  | RegisteredAgentNetworkMember
  | ExternalAgentNetworkMember;

export type AgentNetworkMemberLocator =
  | { kind: "registered"; endpoint: AgentEndpoint }
  | {
      kind: "external";
      agent_id: string;
      installation_id: string;
    };

export interface AgentNetwork {
  agent_network_id: string;
  account_id: string;
  title: string;
  state: AgentNetworkState;
  delivery_mode: AgentNetworkDeliveryMode;
  generation: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  members: AgentNetworkMember[];
}

export interface AgentNetworkDirectory {
  enabled: boolean;
  networks: AgentNetwork[];
  usage: {
    active_networks: number;
    network_limit: number;
    member_limit: number;
  };
  controls: PersonalMessagingControls;
  next_cursor?: string;
}

export interface CreateAgentNetworkOptions {
  request_id: string;
  title: string;
  delivery_mode?: AgentNetworkDeliveryMode;
  members: AgentNetworkMemberLocator[];
}

export type UpdateAgentNetworkOptions =
  | {
      request_id: string;
      agent_network_id: string;
      action: "pause" | "resume" | "close";
    }
  | {
      request_id: string;
      agent_network_id: string;
      action: "set-delivery";
      delivery_mode: AgentNetworkDeliveryMode;
    }
  | {
      request_id: string;
      agent_network_id: string;
      action: "add-member" | "remove-member";
      member: AgentNetworkMemberLocator;
    }
  | {
      request_id: string;
      agent_network_id: string;
      action: "set-title";
      title: string;
    };

export interface SetPersonalMessagingStateOptions {
  action: "pause" | "resume" | "revoke_all";
}

export interface AgentNetworkAuthorization {
  agent_network_id: string;
  network_title: string;
  network_generation: string;
  account_generation: number;
  account_id: string;
  delivery_mode: AgentNetworkDeliveryMode;
  source: AgentNetworkMember;
  target: AgentNetworkMember;
}

export interface AgentNetworkPeer {
  member: AgentNetworkMember;
  networks: Array<
    Pick<
      AgentNetwork,
      "agent_network_id" | "title" | "delivery_mode" | "generation"
    >
  >;
}

export interface AgentNetworkDiscovery {
  peers: AgentNetworkPeer[];
}

export interface AgentNetworkActivity {
  attempt_id: string;
  agent_network_id: string;
  network_generation: string;
  source_member_id: string;
  target_member_id: string;
  configured_delivery: AgentNetworkDeliveryMode;
  effective_delivery?:
    | "idle-wake"
    | "queued"
    | "live-guidance"
    | "queued-fallback"
    | "external-inbox";
  outcome?: "accepted" | "rejected" | "unknown";
  observed_at: string;
}

export interface AgentNetworkProposal {
  proposal_id: string;
  account_id: string;
  source: AgentRpcSource;
  title: string;
  delivery_mode: AgentNetworkDeliveryMode;
  members: AgentNetworkMemberLocator[];
  reason?: string | null;
  state: "pending" | "approved" | "rejected" | "expired";
  created_at: string;
  expires_at: string;
  resolved_at?: string | null;
  agent_network_id?: string | null;
}

export interface ProposeAgentNetworkOptions {
  proposal_id: string;
  title: string;
  delivery_mode?: AgentNetworkDeliveryMode;
  members: AgentNetworkMemberLocator[];
  reason?: string;
}

export interface ResolveAgentNetworkProposalOptions {
  proposal_id: string;
  action: "approve" | "reject";
  request_id: string;
}

export function normalizeAgentName(value: string): string {
  if (typeof value !== "string") throw new Error("invalid agent name");
  const name = value.trim().toLowerCase();
  if (
    !/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(name) ||
    ["all", "everyone", "agents", "me"].includes(name)
  )
    throw new Error(
      "agent name must be 1-32 ASCII letters, digits or internal hyphens, start with a letter, and not be reserved",
    );
  return name;
}
