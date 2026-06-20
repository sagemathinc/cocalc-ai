import { authFirstRequireAccount } from "./util";

export type AiSessionState =
  | "queued"
  | "running"
  | "interrupting"
  | "completed"
  | "failed"
  | "interrupted"
  | "canceled"
  | "host_stopped"
  | "possibly_active"
  | "orphaned"
  | "unknown";

export interface AiSessionRecord {
  session_key: string;
  session_id?: string | null;
  op_id?: string | null;
  project_id: string;
  account_id?: string | null;
  approver_account_id?: string | null;
  host_id?: string | null;
  path?: string | null;
  thread_id?: string | null;
  message_id?: string | null;
  parent_message_id?: string | null;
  state: AiSessionState;
  terminal: boolean | 0 | 1;
  payment_source_kind?: string | null;
  payment_source_id?: string | null;
  payment_source_label?: string | null;
  payment_source_owner_account_id?: string | null;
  model?: string | null;
  agent_kind?: string | null;
  run_kind?: string | null;
  title?: string | null;
  prompt_snippet?: string | null;
  queued_at?: number | string | Date | null;
  started_at?: number | string | Date | null;
  updated_at?: number | string | Date | null;
  last_heartbeat_at?: number | string | Date | null;
  finished_at?: number | string | Date | null;
  error?: string | null;
  metadata_json?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AiSessionsListOptions {
  account_id?: string;
  project_id?: string;
  host_id?: string;
  activeOnly?: boolean;
  limit?: number;
}

export interface AiSessionIdentity {
  session_key?: string;
  session_id?: string;
  op_id?: string;
}

export type AiSessionInterruptState =
  | "interrupted"
  | "repaired"
  | "queued"
  | "missing"
  | "not_authorized"
  | "transport_failed"
  | "already_terminal";

export interface AiSessionInterruptOptions extends AiSessionIdentity {
  account_id?: string;
  note?: string;
}

export interface AiSessionInterruptResponse {
  ok: boolean;
  state: AiSessionInterruptState;
  terminal: boolean;
  session_key?: string | null;
  session_id?: string | null;
  op_id?: string | null;
  project_id?: string | null;
  message?: string;
}

export interface AiSessionInterruptAllOptions {
  account_id?: string;
  limit?: number;
  note?: string;
}

export interface AiSessionInterruptAllResponse {
  total: number;
  terminal: number;
  uncertain: number;
  results: AiSessionInterruptResponse[];
}

export interface AiSessionsApi {
  upsertProjectHostSession: (record: AiSessionRecord) => Promise<void>;
  list: (opts?: AiSessionsListOptions) => Promise<AiSessionRecord[]>;
  interrupt: (
    opts: AiSessionInterruptOptions,
  ) => Promise<AiSessionInterruptResponse>;
  interruptAll: (
    opts?: AiSessionInterruptAllOptions,
  ) => Promise<AiSessionInterruptAllResponse>;
}

function authForSessionPublication({
  args,
  account_id,
  project_id,
  host_id,
}: {
  args: any[];
  account_id?: string;
  project_id?: string;
  host_id?: string;
}) {
  if (args[0] == null) {
    args[0] = {} as any;
  }
  if (host_id) {
    args[0].authenticated_host_id = host_id;
  } else if (project_id) {
    args[0].authenticated_project_id = project_id;
  } else if (account_id) {
    args[0].authenticated_account_id = account_id;
  } else {
    throw Error("must be signed in as an account, project, or host");
  }
  return args;
}

export const aiSessions = {
  upsertProjectHostSession: authForSessionPublication,
  list: authFirstRequireAccount,
  interrupt: authFirstRequireAccount,
  interruptAll: authFirstRequireAccount,
};
