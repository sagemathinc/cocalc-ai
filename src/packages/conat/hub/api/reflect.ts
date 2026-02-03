import { requireSignedIn } from "./util";

export const reflect = {
  listSessionsUI: requireSignedIn,
  listForwardsUI: requireSignedIn,
  createSessionUI: requireSignedIn,
};

export type ReflectSessionRow = {
  id: number;
  name?: string | null;
  alpha_root: string;
  beta_root: string;
  alpha_host?: string | null;
  beta_host?: string | null;
  alpha_port?: number | null;
  beta_port?: number | null;
  prefer: string;
  desired_state: string;
  actual_state: string;
  last_heartbeat?: number | null;
  last_clean_sync_at?: number | null;
  ignore_rules?: string | null;
  merge_strategy?: string | null;
};

export type ReflectForwardRow = {
  id: number;
  name?: string | null;
  direction: string;
  ssh_host: string;
  ssh_port?: number | null;
  local_host: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
  desired_state: string;
  actual_state: string;
  monitor_pid?: number | null;
  last_error?: string | null;
  ssh_args?: string | null;
};

export interface ReflectApi {
  listSessionsUI: (opts?: {
    selectors?: string[];
    target?: string;
  }) => Promise<ReflectSessionRow[]>;
  listForwardsUI: () => Promise<ReflectForwardRow[]>;
  createSessionUI: (opts: {
    alpha: string;
    beta: string;
    name?: string;
    labels?: string[];
    target?: string;
  }) => Promise<void>;
}
