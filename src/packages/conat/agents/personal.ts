import type { ExternalAgentSource } from "./external";
import type { AgentEndpoint, AgentRpcSource } from "./rpc";

export type PersonalAgentDenialCode =
  | "approval_required"
  | "session_paused"
  | "session_closed"
  | "session_stale"
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

export type AgentSessionState = "active" | "paused" | "closed";
export type AgentSessionDeliveryMode = "queued" | "live";

export interface RegisteredAgentSessionMember {
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

export interface ExternalAgentSessionMember {
  kind: "external";
  member_id: string;
  source: ExternalAgentSource;
  label: string;
  available: boolean;
  added_at: string;
  removed_at?: string | null;
}

export type AgentSessionMember =
  | RegisteredAgentSessionMember
  | ExternalAgentSessionMember;

export type AgentSessionMemberLocator =
  | { kind: "registered"; endpoint: AgentEndpoint }
  | {
      kind: "external";
      agent_id: string;
      installation_id: string;
    };

export interface AgentSession {
  agent_session_id: string;
  account_id: string;
  title?: string | null;
  state: AgentSessionState;
  delivery_mode: AgentSessionDeliveryMode;
  generation: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  members: AgentSessionMember[];
}

export interface AgentSessionDirectory {
  enabled: boolean;
  sessions: AgentSession[];
  usage: {
    active_sessions: number;
    session_limit: number;
    member_limit: number;
  };
  controls: PersonalMessagingControls;
  next_cursor?: string;
}

export interface CreateAgentSessionOptions {
  request_id: string;
  title?: string;
  delivery_mode?: AgentSessionDeliveryMode;
  members: AgentSessionMemberLocator[];
}

export type UpdateAgentSessionOptions =
  | {
      request_id: string;
      agent_session_id: string;
      action: "pause" | "resume" | "close";
    }
  | {
      request_id: string;
      agent_session_id: string;
      action: "set-delivery";
      delivery_mode: AgentSessionDeliveryMode;
    }
  | {
      request_id: string;
      agent_session_id: string;
      action: "add-member" | "remove-member";
      member: AgentSessionMemberLocator;
    }
  | {
      request_id: string;
      agent_session_id: string;
      action: "set-title";
      title?: string;
    };

export interface SetPersonalMessagingStateOptions {
  action: "pause" | "resume" | "revoke_all";
}

export interface AgentSessionAuthorization {
  agent_session_id: string;
  session_generation: string;
  account_generation: number;
  account_id: string;
  delivery_mode: AgentSessionDeliveryMode;
  source: AgentSessionMember;
  target: AgentSessionMember;
}

export interface AgentSessionPeer {
  member: AgentSessionMember;
  sessions: Array<
    Pick<
      AgentSession,
      "agent_session_id" | "title" | "delivery_mode" | "generation"
    >
  >;
}

export interface AgentSessionDiscovery {
  peers: AgentSessionPeer[];
}

export interface AgentSessionActivity {
  attempt_id: string;
  agent_session_id: string;
  session_generation: string;
  source_member_id: string;
  target_member_id: string;
  configured_delivery: AgentSessionDeliveryMode;
  effective_delivery?:
    | "idle-wake"
    | "queued"
    | "live-guidance"
    | "queued-fallback"
    | "external-inbox";
  outcome?: "accepted" | "rejected" | "unknown";
  observed_at: string;
}

export interface AgentSessionProposal {
  proposal_id: string;
  account_id: string;
  source: AgentRpcSource;
  title?: string | null;
  delivery_mode: AgentSessionDeliveryMode;
  members: AgentSessionMemberLocator[];
  reason?: string | null;
  state: "pending" | "approved" | "rejected" | "expired";
  created_at: string;
  expires_at: string;
  resolved_at?: string | null;
  agent_session_id?: string | null;
}

export interface ProposeAgentSessionOptions {
  proposal_id: string;
  title?: string;
  delivery_mode?: AgentSessionDeliveryMode;
  members: AgentSessionMemberLocator[];
  reason?: string;
}

export interface ResolveAgentSessionProposalOptions {
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
