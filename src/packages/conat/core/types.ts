interface User {
  account_id?: string;
  project_id?: string;
  hub_id?: string;
  host_id?: string;
  auth_actor?: "account" | "agent";
  auth_scopes?: string[];
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
  subs: number;
  connected?: number; // time connected
  active?: number;
  // ip address
  address?: string;
  // Optional browser session identifier provided during socket handshake auth.
  browser_id?: string;
}
