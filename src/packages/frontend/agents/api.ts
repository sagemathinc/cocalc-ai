import { useEffect, useState } from "react";
import type {
  AgentNetworkDirectory,
  NamedAgent,
  NamedAgentDirectory,
} from "@cocalc/conat/agents/personal";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { AgentMentionReference } from "@cocalc/util/agent-mentions";

export const personalAgentApi = () => webapp_client.conat_client.hub.agent;
const listeners = new Set<(accountId?: string) => void>();
const directoryRequests = new Map<string, Promise<NamedAgentDirectory>>();
const networkRequests = new Map<string, Promise<AgentNetworkDirectory>>();
const generations = new Map<string, number>();
function generation(accountId: string) {
  if (!generations.has(accountId)) generations.set(accountId, 0);
  return generations.get(accountId)!;
}
function refreshDirectories(accountId?: string) {
  for (const id of accountId ? [accountId] : generations.keys())
    generations.set(id, generation(id) + 1);
  if (accountId) {
    directoryRequests.delete(accountId);
    networkRequests.delete(accountId);
  } else {
    directoryRequests.clear();
    networkRequests.clear();
  }
  for (const listener of listeners) listener(accountId);
}

export function refreshNamedAgents() {
  refreshDirectories();
}

export function refreshNamedAgentsForAccount(accountId: string) {
  refreshDirectories(accountId);
}

export const refreshAgentNetworks = refreshNamedAgents;

export function loadNamedAgents(
  accountId: string,
): Promise<NamedAgentDirectory> {
  let request = directoryRequests.get(accountId);
  if (!request) {
    request = personalAgentApi()
      .listNamedAgents({})
      .catch((err) => {
        if (directoryRequests.get(accountId) === request)
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
        if (networkRequests.get(accountId) === request)
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

export function useNamedAgents(enabled = true) {
  const accountId = useTypedRedux("account", "account_id");
  const projectMap = useTypedRedux("projects", "project_map");
  const projectIds = projectMap?.keySeq().sort().join(",");
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    accountId?: string;
    directory?: NamedAgentDirectory;
    error?: string;
    loading: boolean;
  }>({ loading: true });
  useEffect(() => {
    const refresh = (id?: string) => {
      if (!id || id === accountId) setRevision((n) => n + 1);
    };
    listeners.add(refresh);
    return () => {
      listeners.delete(refresh);
    };
  }, [accountId]);
  useEffect(() => {
    let disposed = false;
    if (!accountId || !enabled) {
      // An unresolved account is not an empty agent directory.
      setState({ loading: enabled });
      return;
    }
    setState((old) => ({ ...old, loading: true }));
    const epoch = generation(accountId);
    void loadNamedAgents(accountId)
      .then((directory) => {
        if (!disposed && epoch === generation(accountId))
          setState({ accountId, directory, loading: false });
      })
      .catch((err) => {
        if (!disposed && epoch === generation(accountId))
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
    const refresh = (id?: string) => {
      if (!id || id === accountId) setRevision((n) => n + 1);
    };
    listeners.add(refresh);
    return () => {
      listeners.delete(refresh);
    };
  }, [accountId]);
  useEffect(() => {
    let disposed = false;
    if (!accountId || !enabled) {
      setState({ loading: false });
      return;
    }
    setState((old) => ({ ...old, loading: true }));
    const epoch = generation(accountId);
    void loadAgentNetworks(accountId)
      .then((directory) => {
        if (!disposed && epoch === generation(accountId))
          setState({ accountId, directory, loading: false });
      })
      .catch((err) => {
        if (!disposed && epoch === generation(accountId))
          setState({ accountId, loading: false, error: `${err}` });
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
