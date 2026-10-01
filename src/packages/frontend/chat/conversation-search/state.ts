import type { ConversationSearchProgress } from "./runner";
import type { ConversationSearchTarget } from "./runner";

export interface ConversationSearchState {
  open: boolean;
  query: string;
  projectId?: string;
  past: boolean;
  width: number;
  scroll: number;
  busy: boolean;
  searchedQuery: string;
  progress?: ConversationSearchProgress;
  error?: string;
  pending?: ConversationSearchTarget[];
  next?: string;
  notice?: string;
  searchedProjectId?: string;
  searchedPast?: boolean;
}

const stores = new Map<string, ReturnType<typeof createStore>>();
function createStore(account: string, scope: string) {
  const key = `${scope}-search-v1:${account}`;
  let saved: any = {};
  try {
    saved = JSON.parse(sessionStorage.getItem(key) || "{}");
  } catch {
    /* Unavailable storage is fine. */
  }
  let value: ConversationSearchState = {
    open: saved.open === true,
    query: typeof saved.query === "string" ? saved.query.slice(0, 256) : "",
    projectId:
      typeof saved.projectId === "string" ? saved.projectId : undefined,
    past: saved.past === true,
    width: Math.max(320, Math.min(1000, Number(saved.width) || 560)),
    scroll: 0,
    busy: false,
    searchedQuery: "",
  };
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (change: Partial<ConversationSearchState>) => {
      value = { ...value, ...change };
      // Only UI preferences go on disk. Results remain account-scoped in memory.
      const { open, query, projectId, past, width } = value;
      try {
        sessionStorage.setItem(
          key,
          JSON.stringify({ open, query, projectId, past, width }),
        );
      } catch {
        /* Optional persistence. */
      }
      for (const listener of listeners) listener();
    },
  };
}
export function conversationSearchStore(account: string, scope: string) {
  const key = JSON.stringify([account, scope]);
  let store = stores.get(key);
  if (!store) {
    store = createStore(account, scope);
    stores.set(key, store);
  }
  return store;
}
