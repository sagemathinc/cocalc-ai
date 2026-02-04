import { requireSignedIn } from "./util";

export const reflect = {
  listSessionsUI: requireSignedIn,
  listForwardsUI: requireSignedIn,
  createSessionUI: requireSignedIn,
  createForwardUI: requireSignedIn,
  terminateForwardUI: requireSignedIn,
  listSessionLogsUI: requireSignedIn,
  listDaemonLogsUI: requireSignedIn,
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

export type ReflectLogRow = {
  id: number;
  ts: number;
  level: string;
  scope?: string | null;
  message: string;
  meta?: any;
};

export type ReflectSessionLogRow = ReflectLogRow & {
  session_id: number;
};

export interface ReflectApi {
  listSessionsUI: (opts?: {
    selectors?: string[];
    target?: string;
  }) => Promise<ReflectSessionRow[]>;
  listForwardsUI: () => Promise<ReflectForwardRow[]>;
  createSessionUI: (opts: {
    alpha?: string;
    beta?: string;
    localPath?: string;
    remotePath?: string;
    name?: string;
    labels?: string[];
    prefer?: "alpha" | "beta";
    ignore?: string[];
    useGitignore?: boolean;
    target?: string;
  }) => Promise<void>;
  createForwardUI: (opts: {
    target: string;
    localPort: number;
    remotePort?: number;
    direction?: "remote_to_local" | "local_to_remote";
    name?: string;
  }) => Promise<void>;
  terminateForwardUI: (opts: { id: number }) => Promise<void>;
  listSessionLogsUI: (opts: {
    idOrName: string;
    limit?: number;
    sinceTs?: number;
    afterId?: number;
    order?: "asc" | "desc";
    minLevel?: string;
    scope?: string;
    message?: string;
  }) => Promise<ReflectSessionLogRow[]>;
  listDaemonLogsUI: (opts?: {
    limit?: number;
    sinceTs?: number;
    afterId?: number;
    order?: "asc" | "desc";
    minLevel?: string;
    scope?: string;
    message?: string;
  }) => Promise<ReflectLogRow[]>;
}
