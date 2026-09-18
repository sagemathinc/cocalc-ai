import type { AgentEndpoint, AgentRpcLink } from "./rpc";

export type PersonalAgentDenialCode =
  | "approval_required"
  | "grant_expired"
  | "grant_paused"
  | "grant_revoked"
  | "principal_mismatch"
  | "account_disabled"
  | "agent_unavailable";
export interface PersonalAgentDenial {
  denied: PersonalAgentDenialCode;
}
/** Local exception only. Trusted inter-bay checks return PersonalAgentDenial
 * data instead: RPC error messages are decorated and are not a protocol. */
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
  controls?: PersonalMessagingControls;
}
export interface NameAgentOptions {
  endpoint: AgentEndpoint;
  name: string;
  description?: string;
  project_title?: string;
  thread_title?: string;
}
export type PersonalConnectionStatus =
  | "active"
  | "expired"
  | "paused"
  | "revoked";
export interface PersonalConnection extends AgentRpcLink {
  principal_account_id: string;
  direction_group_id: string;
  approval_request_id: string;
  generation: number;
  paused: boolean;
  status: PersonalConnectionStatus;
  created_at: string;
  last_attempt_at?: string | null;
  last_accepted_at?: string | null;
}
export interface PersonalConnectionDirectory {
  enabled: boolean;
  connections: PersonalConnection[];
  controls?: PersonalMessagingControls;
}
export interface GrantPersonalConnectionOptions {
  source: AgentEndpoint;
  target: AgentEndpoint;
  /** Stable UUID for safe inspection/retry of approval, never send replay. */
  approval_request_id: string;
  /** Omitted: one day. Null: never expires. Maximum: 30 days. */
  ttl_seconds?: number | null;
  both_directions?: boolean;
  allow_guidance?: boolean;
  reason: string;
}
export interface SetPersonalConnectionStateOptions {
  direction_group_id: string;
  state: "paused" | "active" | "revoked";
}
export interface SetPersonalMessagingStateOptions {
  action: "pause" | "resume" | "revoke_all";
}
export interface PersonalConnectionRequestOptions {
  request_id: string;
  target: AgentEndpoint;
  reason: string;
  ttl_seconds?: number | null;
  both_directions?: boolean;
  allow_guidance?: boolean;
}
export type AgentConnectionRequest = PersonalConnectionRequest;
export interface PersonalConnectionRequest extends PersonalConnectionRequestOptions {
  /** On inspection of a coalesced submitted ID, identifies its sole authority. */
  canonical_request_id?: string;
  generation: number;
  request_id: string;
  account_id: string;
  source: AgentEndpoint;
  run_id: string;
  created_at: string;
  expires_at: string;
  state: "pending" | "approved" | "denied" | "expired" | "invalidated";
  direction_group_id?: string;
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
