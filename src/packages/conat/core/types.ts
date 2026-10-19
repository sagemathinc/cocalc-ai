import type { ProjectHostApiKeyBinding } from "../auth/project-host-token";
import type { ComputerPrincipal } from "../computers/principal";

/** An authenticated principal: an account/project/hub/host, or a computer. */
type User = PersonUser | ComputerPrincipal;

interface PersonUser {
  account_id?: string;
  // Cookie-authenticated session reference supplied by the server for hub RPCs.
  auth_session_hash?: string;
  project_id?: string;
  hub_id?: string;
  host_id?: string;
  auth_actor?: "account" | "agent";
  auth_agent_id?: string;
  auth_agent_run_id?: string;
  auth_external_installation_id?: string;
  auth_scopes?: string[];
  auth_project_id?: string;
  auth_token_fingerprint?: string;
  auth_iat_s?: number;
  auth_exp_s?: number;
  auth_api_key_reply_prefix?: string;
  auth_api_key?: ProjectHostApiKeyBinding;
  error?: string;
}

export interface ServerInfo {
  max_payload: number;
  id?: string;
  clusterName?: string;
  user?: User;
}

export interface ConnectionStats {
  user?: User;
  send: { messages: number; bytes: number };
  recv: { messages: number; bytes: number };
  egress?: { messages: number; bytes: number };
  // egress bytes by normalized subject (see core/egress-attribution.ts)
  egress_by_subject?: Record<string, number>;
  subs: number;
  connected?: number; // time connected
  active?: number;
  // ip address
  address?: string;
  // Optional browser session identifier provided during socket handshake auth.
  browser_id?: string;
}
