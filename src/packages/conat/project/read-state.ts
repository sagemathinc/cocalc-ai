import { cloneDeep } from "lodash";
import type { Client } from "@cocalc/conat/core/client";
import { dkv } from "@cocalc/conat/sync/dkv";

export const PROJECT_READ_STATE_STORE_VERSION = 1;
export const PROJECT_READ_STATE_STORE_PREFIX = `project-read-state-v${PROJECT_READ_STATE_STORE_VERSION}`;

// The DKV itself is already scoped by project_id, so the store name only needs
// to vary by account_id to give each user their own read-state view.
export function getProjectReadStateStoreName(account_id: string): string {
  return `${PROJECT_READ_STATE_STORE_PREFIX}-${account_id}`;
}

export interface ChatThreadReadState {
  m: string;
  t: Date;
}

export interface ChatReadStateEntry {
  kind: "chat";
  threads: Record<string, ChatThreadReadState>;
}

export interface NotebookReadStateEntry {
  kind: "ipynb";
  t: Date;
  p?: string;
  cells?: number;
}

export interface TextReadStateEntry {
  kind: "text";
  t: Date;
  p?: string;
}

export interface TasksReadStateEntry {
  kind: "tasks";
  t: Date;
  p?: string;
}

export type ProjectReadStateEntry =
  | ChatReadStateEntry
  | NotebookReadStateEntry
  | TextReadStateEntry
  | TasksReadStateEntry;

export type ProjectReadStateKind = ProjectReadStateEntry["kind"];

export interface ProjectReadStateListEntry {
  path: string;
  value: ProjectReadStateEntry;
}

export interface ProjectReadStateRecentEntry extends ProjectReadStateListEntry {
  t: Date;
}

interface ReadStateKV {
  get: (
    key?: string,
  ) =>
    | ProjectReadStateEntry
    | Record<string, ProjectReadStateEntry>
    | undefined;
  getAll: () => Record<string, ProjectReadStateEntry>;
  set: (key: string, value: ProjectReadStateEntry) => void;
  delete: (key: string) => void;
  close: () => void;
  on?: (event: string, listener: (event: any) => void) => void;
  off?: (event: string, listener: (event: any) => void) => void;
  removeListener?: (event: string, listener: (event: any) => void) => void;
}

export interface ProjectReadStateStore {
  readonly project_id: string;
  readonly account_id: string;
  readonly name: string;
  get: (path: string) => ProjectReadStateEntry | undefined;
  set: (path: string, value: ProjectReadStateEntry) => ProjectReadStateEntry;
  delete: (path: string) => void;
  listEntries: (opts?: {
    kind?: ProjectReadStateKind;
  }) => ProjectReadStateListEntry[];
  listRecent: (opts?: {
    kind?: ProjectReadStateKind;
    limit?: number;
  }) => ProjectReadStateRecentEntry[];
  getChatThreads: (path: string) => Record<string, ChatThreadReadState>;
  getChatThread: (
    path: string,
    thread_id: string,
  ) => ChatThreadReadState | undefined;
  touchChatThread: (
    path: string,
    thread_id: string,
    opts: { message_id: string; at?: Date },
  ) => ChatReadStateEntry;
  markChatThreadRead: (
    path: string,
    thread_id: string,
    opts: { message_id: string; at?: Date },
  ) => ChatReadStateEntry;
  onChange: (listener: (path: string) => void) => () => void;
  close: () => void;
}

export async function openProjectReadState({
  account_id,
  project_id,
  client,
}: {
  account_id: string;
  project_id: string;
  client: Client;
}): Promise<ProjectReadStateStore> {
  const store = await dkv<ProjectReadStateEntry>({
    client,
    project_id,
    name: getProjectReadStateStoreName(account_id),
    merge: ({ local, remote }) => mergeProjectReadStateEntries(local, remote),
  });
  return createProjectReadStateStore({
    account_id,
    project_id,
    store,
  });
}

export function createProjectReadStateStore({
  account_id,
  project_id,
  store,
}: {
  account_id: string;
  project_id: string;
  store: ReadStateKV;
}): ProjectReadStateStore {
  const get = (path: string): ProjectReadStateEntry | undefined => {
    const value = store.get(path);
    return value == null
      ? undefined
      : cloneEntry(value as ProjectReadStateEntry);
  };

  const set = (
    path: string,
    value: ProjectReadStateEntry,
  ): ProjectReadStateEntry => {
    const next = cloneEntry(value);
    store.set(path, next);
    return cloneEntry(next);
  };

  const listEntries = ({
    kind,
  }: {
    kind?: ProjectReadStateKind;
  } = {}): ProjectReadStateListEntry[] => {
    return Object.entries(store.getAll())
      .filter(
        ([, value]) => value != null && (kind == null || value.kind === kind),
      )
      .map(([path, value]) => ({ path, value: cloneEntry(value) }));
  };

  const listRecent = ({
    kind,
    limit,
  }: {
    kind?: ProjectReadStateKind;
    limit?: number;
  } = {}): ProjectReadStateRecentEntry[] => {
    const entries = listEntries({ kind })
      .map(({ path, value }) => {
        const t = getEntryTouchedAt(value);
        return t == null ? undefined : { path, value, t };
      })
      .filter((entry): entry is ProjectReadStateRecentEntry => entry != null)
      .sort((a, b) => b.t.valueOf() - a.t.valueOf());
    if (limit == null || limit < 0) {
      return entries;
    }
    return entries.slice(0, limit);
  };

  const getChatThreads = (
    path: string,
  ): Record<string, ChatThreadReadState> => {
    const entry = get(path);
    if (entry?.kind !== "chat") {
      return {};
    }
    return cloneDeep(entry.threads);
  };

  const getChatThread = (
    path: string,
    thread_id: string,
  ): ChatThreadReadState | undefined => {
    const threads = getChatThreads(path);
    const thread = threads[thread_id];
    return thread == null ? undefined : cloneDeep(thread);
  };

  const touchChatThread = (
    path: string,
    thread_id: string,
    opts: { message_id: string; at?: Date },
  ): ChatReadStateEntry => {
    const nextThread: ChatThreadReadState = {
      m: opts.message_id,
      t: opts.at ?? new Date(),
    };
    const current = get(path);
    const merged = mergeProjectReadStateEntries(current, {
      kind: "chat",
      threads: { [thread_id]: nextThread },
    });
    const next =
      merged?.kind === "chat"
        ? merged
        : ({
            kind: "chat",
            threads: { [thread_id]: nextThread },
          } satisfies ChatReadStateEntry);
    set(path, next);
    return cloneEntry(next);
  };

  const markChatThreadRead = (
    path: string,
    thread_id: string,
    opts: { message_id: string; at?: Date },
  ): ChatReadStateEntry => touchChatThread(path, thread_id, opts);

  const onChange = (listener: (path: string) => void): (() => void) => {
    if (store.on == null) {
      return () => {};
    }
    const handleChange = (event: any) => {
      const key =
        typeof event === "string"
          ? event
          : typeof event?.key === "string"
            ? event.key
            : undefined;
      if (key) {
        listener(key);
      }
    };
    store.on("change", handleChange);
    return () => {
      store.off?.("change", handleChange);
      store.removeListener?.("change", handleChange);
    };
  };

  return {
    account_id,
    project_id,
    name: getProjectReadStateStoreName(account_id),
    get,
    set,
    delete: store.delete,
    listEntries,
    listRecent,
    getChatThreads,
    getChatThread,
    touchChatThread,
    markChatThreadRead,
    onChange,
    close: store.close,
  };
}

export function mergeProjectReadStateEntries(
  local?: ProjectReadStateEntry,
  remote?: ProjectReadStateEntry,
): ProjectReadStateEntry | undefined {
  if (local == null) return remote == null ? undefined : cloneEntry(remote);
  if (remote == null) return cloneEntry(local);
  if (local.kind === "chat" && remote.kind === "chat") {
    const threads: Record<string, ChatThreadReadState> = {};
    const ids = new Set([
      ...Object.keys(remote.threads ?? {}),
      ...Object.keys(local.threads ?? {}),
    ]);
    for (const id of ids) {
      const localThread = local.threads?.[id];
      const remoteThread = remote.threads?.[id];
      if (localThread == null) {
        if (remoteThread != null) {
          threads[id] = cloneDeep(remoteThread);
        }
        continue;
      }
      if (remoteThread == null) {
        threads[id] = cloneDeep(localThread);
        continue;
      }
      threads[id] = chooseNewerChatThread(localThread, remoteThread);
    }
    return { kind: "chat", threads };
  }
  return chooseNewerEntry(local, remote);
}

function chooseNewerEntry(
  local: ProjectReadStateEntry,
  remote: ProjectReadStateEntry,
): ProjectReadStateEntry {
  const localAt =
    getEntryTouchedAt(local)?.valueOf() ?? Number.NEGATIVE_INFINITY;
  const remoteAt =
    getEntryTouchedAt(remote)?.valueOf() ?? Number.NEGATIVE_INFINITY;
  return cloneEntry(remoteAt > localAt ? remote : local);
}

function chooseNewerChatThread(
  local: ChatThreadReadState,
  remote: ChatThreadReadState,
): ChatThreadReadState {
  const localAt = local.t.valueOf();
  const remoteAt = remote.t.valueOf();
  return cloneDeep(remoteAt > localAt ? remote : local);
}

function getEntryTouchedAt(entry: ProjectReadStateEntry): Date | undefined {
  if (entry.kind === "chat") {
    let best: Date | undefined;
    for (const value of Object.values(entry.threads ?? {})) {
      if (value?.t == null) continue;
      if (best == null || value.t.valueOf() > best.valueOf()) {
        best = value.t;
      }
    }
    return best == null ? undefined : new Date(best);
  }
  return "t" in entry && entry.t != null ? new Date(entry.t) : undefined;
}

function cloneEntry<T extends ProjectReadStateEntry>(value: T): T {
  return cloneDeep(value);
}
