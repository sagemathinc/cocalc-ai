import type { AgentSearchProgress } from "./search-runner";
import type { NamedAgent } from "@cocalc/conat/agents/personal";

export interface AgentSearchState {
  artifactsOpen?: boolean;
  open: boolean;
  query: string;
  projectId?: string;
  past: boolean;
  width: number;
  scroll: number;
  busy: boolean;
  searchedQuery: string;
  progress?: AgentSearchProgress;
  error?: string;
  pending?: NamedAgent[];
  searchedPast?: boolean;
}

const stores = new Map<string, ReturnType<typeof createStore>>();
function createStore(account: string) {
  const key = `agent-search-v1:${account}`;
  let saved: any = {};
  try {
    saved = JSON.parse(sessionStorage.getItem(key) || "{}");
  } catch {
    /* Unavailable storage is fine. */
  }
  let value: AgentSearchState = {
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
    set: (change: Partial<AgentSearchState>) => {
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
export function agentSearchStore(account: string) {
  let store = stores.get(account);
  if (!store) {
    store = createStore(account);
    stores.set(account, store);
  }
  return store;
}
