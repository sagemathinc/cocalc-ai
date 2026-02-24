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
  thread_color?: string;
  thread_icon?: string;
  thread_image?: string;
  thread_pin?: boolean;
  last_error?: string;
}

type SessionListListener = (records: AgentSessionRecord[]) => void;

let kv: DKV<AgentSessionRecord> | null = null;
let kvProjectId: string | null = null;
let kvInFlight: Promise<DKV<AgentSessionRecord>> | null = null;

function sessionKey(project_id: string, session_id: string): string {
  return `${project_id}::${session_id}`;
}

function dateMs(value?: string): number {
  if (!value) return 0;
  const ms = new Date(value).valueOf();
  return Number.isFinite(ms) ? ms : 0;
}

function threadIdentity(record?: Partial<AgentSessionRecord>): string {
  if (!record?.chat_path || !record?.thread_key) return "";
  return `${record.chat_path}::${record.thread_key}`;
}

async function getStore(project_id: string): Promise<DKV<AgentSessionRecord>> {
  if (kv && kvProjectId === project_id) {
    return kv;
  }
  if (kvInFlight && kvProjectId === project_id) {
    return await kvInFlight;
  }
  kvProjectId = project_id;
  kvInFlight = webapp_client.conat_client
    .dkv<AgentSessionRecord>({
      project_id,
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
  const key = sessionKey(record.project_id, record.session_id);
  try {
    const store = await getStore(record.project_id);
    const prefix = `${record.project_id}::`;
    const identity = threadIdentity(record);
    const all = store.getAll();
    const duplicates = identity
      ? Object.entries(all)
          .filter(([entryKey, value]) => {
            if (!entryKey.startsWith(prefix)) return false;
            if (!value) return false;
            return threadIdentity(value) === identity;
          })
          .map(([entryKey]) => entryKey)
      : [key];

    let merged: AgentSessionRecord = record;
    for (const dupKey of duplicates) {
      const existing = store.get(dupKey);
      if (!existing) continue;
      merged = { ...existing, ...merged };
    }
    const created = [merged.created_at, record.created_at]
      .filter((x): x is string => typeof x === "string" && x.length > 0)
      .reduce((best: string | undefined, next) => {
        if (!best) return next;
        return dateMs(next) < dateMs(best) ? next : best;
      }, undefined);
    if (created) {
      merged.created_at = created;
    }

    store.set(key, merged);
    for (const dupKey of duplicates) {
      if (dupKey !== key) {
        store.delete(dupKey);
      }
    }
  } catch (err) {
    throw err;
  }
}

export async function deleteAgentSessionRecord(opts: {
  project_id: string;
  session_id: string;
}): Promise<void> {
  const store = await getStore(opts.project_id);
  store.delete(sessionKey(opts.project_id, opts.session_id));
}

export async function listAgentSessionsForProject(opts: {
  project_id: string;
}): Promise<AgentSessionRecord[]> {
  const store = await getStore(opts.project_id);
  return getProjectSessions(store.getAll(), opts.project_id);
}

function getProjectSessions(
  entries: Record<string, AgentSessionRecord>,
  project_id: string,
): AgentSessionRecord[] {
  const prefix = `${project_id}::`;
  const byThread = new Map<string, AgentSessionRecord>();
  for (const [, value] of Object.entries(entries).filter(([key]) =>
    key.startsWith(prefix),
  )) {
    const record = value as AgentSessionRecord;
    const identity = threadIdentity(record);
    const dedupeKey = identity || sessionKey(record.project_id, record.session_id);
    const prev = byThread.get(dedupeKey);
    if (!prev) {
      byThread.set(dedupeKey, record);
      continue;
    }
    if (dateMs(record.updated_at) >= dateMs(prev.updated_at)) {
      byThread.set(dedupeKey, { ...prev, ...record });
    } else {
      byThread.set(dedupeKey, { ...record, ...prev });
    }
  }
  return Array.from(byThread.values())
    .sort((a, b) => {
      const ta = new Date(a.updated_at).valueOf();
      const tb = new Date(b.updated_at).valueOf();
      return tb - ta;
    });
}

export async function watchAgentSessionsForProject(
  opts: { project_id: string },
  listener: SessionListListener,
): Promise<() => void> {
  const store = await getStore(opts.project_id);
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
