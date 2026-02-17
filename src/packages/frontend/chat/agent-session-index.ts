import type { DKV } from "@cocalc/conat/sync/dkv";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const AGENT_SESSION_STORE = "cocalc-agent-sessions-v1";

export type AgentSessionStatus =
  | "active"
  | "idle"
  | "running"
  | "archived"
  | "failed";

export type AgentSessionEntrypoint =
  | "global"
  | "file"
  | "notebook"
  | "error-button"
  | "command-palette"
  | "api";

export interface AgentSessionRecord {
  session_id: string;
  project_id: string;
  account_id: string;
  chat_path: string;
  thread_key: string;
  title: string;
  created_at: string;
  updated_at: string;
  status: AgentSessionStatus;
  entrypoint: AgentSessionEntrypoint;
  working_directory?: string;
  mode?: "read-only" | "workspace-write" | "full-access";
  model?: string;
  reasoning?: string;
  last_error?: string;
}

type SessionListListener = (records: AgentSessionRecord[]) => void;

let kv: DKV<AgentSessionRecord> | null = null;
let kvAccountId: string | null = null;
let kvInFlight: Promise<DKV<AgentSessionRecord>> | null = null;

function sessionKey(project_id: string, session_id: string): string {
  return `${project_id}::${session_id}`;
}

async function getStore(account_id: string): Promise<DKV<AgentSessionRecord>> {
  if (kv && kvAccountId === account_id) {
    return kv;
  }
  if (kvInFlight && kvAccountId === account_id) {
    return await kvInFlight;
  }
  kvAccountId = account_id;
  kvInFlight = webapp_client.conat_client
    .dkv<AgentSessionRecord>({
      account_id,
      name: AGENT_SESSION_STORE,
    })
    .then((store) => {
      kv = store;
      kvInFlight = null;
      return store;
    })
    .catch((err) => {
      kvInFlight = null;
      throw err;
    });
  return await kvInFlight;
}

export async function upsertAgentSessionRecord(
  record: AgentSessionRecord,
): Promise<void> {
  const store = await getStore(record.account_id);
  const key = sessionKey(record.project_id, record.session_id);
  const prev = store.get(key);
  store.set(key, prev ? { ...prev, ...record } : record);
}

export async function deleteAgentSessionRecord(opts: {
  account_id: string;
  project_id: string;
  session_id: string;
}): Promise<void> {
  const store = await getStore(opts.account_id);
  store.delete(sessionKey(opts.project_id, opts.session_id));
}

export async function listAgentSessionsForProject(opts: {
  account_id: string;
  project_id: string;
}): Promise<AgentSessionRecord[]> {
  const store = await getStore(opts.account_id);
  return getProjectSessions(store.getAll(), opts.project_id);
}

function getProjectSessions(
  entries: Record<string, AgentSessionRecord>,
  project_id: string,
): AgentSessionRecord[] {
  const prefix = `${project_id}::`;
  return Object.entries(entries)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, value]) => value as AgentSessionRecord)
    .sort((a, b) => {
      const ta = new Date(a.updated_at).valueOf();
      const tb = new Date(b.updated_at).valueOf();
      return tb - ta;
    });
}

export async function watchAgentSessionsForProject(
  opts: { account_id: string; project_id: string },
  listener: SessionListListener,
): Promise<() => void> {
  const store = await getStore(opts.account_id);
  const prefix = `${opts.project_id}::`;
  const emit = () => {
    listener(getProjectSessions(store.getAll(), opts.project_id));
  };
  const onChange = (changeEvent?: { key?: string }) => {
    const key = changeEvent?.key;
    if (typeof key !== "string" || key.startsWith(prefix)) {
      emit();
    }
  };
  store.on("change", onChange);
  emit();
  return () => store.removeListener("change", onChange);
}
