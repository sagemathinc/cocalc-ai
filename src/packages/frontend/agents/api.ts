import { useEffect, useState } from "react";
import type {
  AgentNetworkDirectory,
  NamedAgent,
  NamedAgentDirectory,
} from "@cocalc/conat/agents/personal";
import {
  accountFeedStreamName,
  type AccountFeedEvent,
} from "@cocalc/conat/hub/api/account-feed";
import { getSharedAccountDStream } from "@cocalc/frontend/conat/account-dstream";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { AgentMentionReference } from "@cocalc/util/agent-mentions";

export const personalAgentApi = () => webapp_client.conat_client.hub.agent;
const listeners = new Set<() => void>();
const directoryRequests = new Map<string, Promise<NamedAgentDirectory>>();
const networkRequests = new Map<string, Promise<AgentNetworkDirectory>>();
export function refreshNamedAgents() {
  directoryRequests.clear();
  networkRequests.clear();
  for (const listener of listeners) listener();
}

export const refreshAgentNetworks = refreshNamedAgents;

// The latest directory per account, patched in place by the account feed
// (agent.upsert / agent.remove), so every open view updates within moments of
// a change on any device without reloading the list.
const directories = new Map<string, NamedAgentDirectory>();
const versions = new Map<string, number>();
const directoryListeners = new Set<(accountId: string) => void>();

function setDirectory(accountId: string, directory: NamedAgentDirectory) {
  directories.set(accountId, directory);
  for (const listener of directoryListeners) listener(accountId);
}

const byName = (a: NamedAgent, b: NamedAgent) => a.name.localeCompare(b.name);

/** Apply one live change; exported for tests. */
export function applyNamedAgentEvent(
  accountId: string,
  event: AccountFeedEvent,
): void {
  if (event.type !== "agent.upsert" && event.type !== "agent.remove") return;
  versions.set(accountId, (versions.get(accountId) ?? 0) + 1);
  const directory = directories.get(accountId);
  if (!directory) return;
  const id =
    event.type === "agent.upsert"
      ? event.agent.endpoint.agent_id
      : event.agent_id;
  const agents = directory.agents.filter(
    (agent) => agent.endpoint.agent_id !== id,
  );
  if (event.type === "agent.upsert") agents.push(event.agent);
  setDirectory(accountId, { ...directory, agents: agents.sort(byName) });
}

let feedAccountId: string | undefined;
let feed: Awaited<ReturnType<typeof getSharedAccountDStream>> | undefined;

function onFeedChange(event?: AccountFeedEvent) {
  if (feedAccountId && event) applyNamedAgentEvent(feedAccountId, event);
}

function onFeedGap() {
  // Missed events: one reload of the (cheap, single-query) directory.
  refreshNamedAgents();
}

async function ensureNamedAgentsFeed(accountId: string): Promise<void> {
  if (feedAccountId === accountId && feed && !feed.isClosed()) return;
  feed?.removeListener("change", onFeedChange);
  feed?.removeListener("history-gap", onFeedGap);
  feedAccountId = accountId;
  try {
    const next = await getSharedAccountDStream<AccountFeedEvent>({
      account_id: accountId,
      name: accountFeedStreamName(),
      ephemeral: true,
      maxListeners: 100,
    });
    if (feedAccountId !== accountId) return;
    next.on("change", onFeedChange);
    next.on("history-gap", onFeedGap);
    feed = next as typeof feed;
  } catch (err) {
    console.warn("agents realtime feed error", err);
  }
}

export function loadNamedAgents(
  accountId: string,
): Promise<NamedAgentDirectory> {
  let request = directoryRequests.get(accountId);
  if (!request) {
    const version = versions.get(accountId) ?? 0;
    request = personalAgentApi()
      .listNamedAgents({})
      .then((directory) => {
        setDirectory(accountId, directory);
        // A live change raced this load; take one more (cheap) look.
        if ((versions.get(accountId) ?? 0) !== version)
          setTimeout(refreshNamedAgents, 0);
        return directory;
      })
      .catch((err) => {
        directoryRequests.delete(accountId);
        throw err;
      });
    directoryRequests.set(accountId, request);
    const clear = () => {
      if (directoryRequests.get(accountId) === request) {
        directoryRequests.delete(accountId);
      }
    };
    void request.then(clear, clear);
  }
  return request;
}

function loadAgentNetworks(accountId: string): Promise<AgentNetworkDirectory> {
  let request = networkRequests.get(accountId);
  if (!request) {
    request = personalAgentApi()
      .listAgentNetworks({ limit: 100 })
      .catch((err) => {
        networkRequests.delete(accountId);
        throw err;
      });
    networkRequests.set(accountId, request);
    const clear = () => {
      if (networkRequests.get(accountId) === request) {
        networkRequests.delete(accountId);
      }
    };
    void request.then(clear, clear);
  }
  return request;
}

export function sameEndpoint(a: AgentEndpoint, b: AgentEndpoint): boolean {
  return a.project_id === b.project_id && a.agent_id === b.agent_id;
}

export function namedAgentReference(agent: NamedAgent): AgentMentionReference {
  return {
    version: 1,
    naming_account_id: agent.account_id,
    target: agent.endpoint,
    name: agent.name,
  };
}

// Sorting every project id is costly with many projects and this runs on
// each render of every composer, so compute it once per project map version.
const projectIdsKeyCache = new WeakMap<object, string>();

function projectIdsKey(projectMap): string | undefined {
  if (projectMap == null) return undefined;
  let key = projectIdsKeyCache.get(projectMap);
  if (key == null) {
    key = projectMap.keySeq().sort().join(",");
    projectIdsKeyCache.set(projectMap, key!);
  }
  return key;
}

export function useNamedAgents(enabled = true) {
  const accountId = useTypedRedux("account", "account_id");
  const projectMap = useTypedRedux("projects", "project_map");
  const projectIds = projectIdsKey(projectMap);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    accountId?: string;
    directory?: NamedAgentDirectory;
    error?: string;
    loading: boolean;
  }>({ loading: true });
  useEffect(() => {
    const refresh = () => setRevision((n) => n + 1);
    listeners.add(refresh);
    return () => {
      listeners.delete(refresh);
    };
  }, []);
  useEffect(() => {
    if (!accountId || !enabled) return;
    void ensureNamedAgentsFeed(accountId);
    const changed = (changedAccountId: string) => {
      const directory = directories.get(changedAccountId);
      if (changedAccountId === accountId && directory)
        setState({ accountId, directory, loading: false });
    };
    directoryListeners.add(changed);
    return () => {
      directoryListeners.delete(changed);
    };
  }, [accountId, enabled]);
  useEffect(() => {
    let disposed = false;
    if (!accountId || !enabled) {
      // An unresolved account is not an empty agent directory.
      setState({ loading: enabled });
      return;
    }
    setState((old) => ({ ...old, loading: true }));
    void loadNamedAgents(accountId)
      .then((directory) => {
        if (!disposed) setState({ accountId, directory, loading: false });
      })
      .catch((err) => {
        if (!disposed)
          setState((old) => ({
            accountId,
            directory: old.accountId === accountId ? old.directory : undefined,
            loading: false,
            error: `${err}`,
          }));
      });
    return () => {
      disposed = true;
    };
  }, [accountId, revision, enabled, projectIds]);
  return !enabled
    ? { loading: false }
    : state.accountId === accountId
      ? state
      : { loading: true };
}

export function useAgentNetworks(enabled = true) {
  const accountId = useTypedRedux("account", "account_id");
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    accountId?: string;
    directory?: AgentNetworkDirectory;
    error?: string;
    loading: boolean;
  }>({ loading: true });
  useEffect(() => {
    const refresh = () => setRevision((n) => n + 1);
    listeners.add(refresh);
    return () => {
      listeners.delete(refresh);
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    if (!accountId || !enabled) {
      setState({ loading: false });
      return;
    }
    setState((old) => ({ ...old, loading: true }));
    void loadAgentNetworks(accountId)
      .then((directory) => {
        if (!disposed) setState({ accountId, directory, loading: false });
      })
      .catch((err) => {
        if (!disposed) setState({ accountId, loading: false, error: `${err}` });
      });
    return () => {
      disposed = true;
    };
  }, [accountId, enabled, revision]);
  return !enabled
    ? { loading: false }
    : state.accountId === accountId
      ? state
      : { loading: !!accountId };
}
