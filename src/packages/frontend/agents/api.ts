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
const listeners = new Set<() => void>();
const directoryRequests = new Map<string, Promise<NamedAgentDirectory>>();
const networkRequests = new Map<string, Promise<AgentNetworkDirectory>>();
export function refreshNamedAgents() {
  directoryRequests.clear();
  networkRequests.clear();
  for (const listener of listeners) listener();
}

export const refreshAgentNetworks = refreshNamedAgents;

function loadNamedAgents(accountId: string): Promise<NamedAgentDirectory> {
  let request = directoryRequests.get(accountId);
  if (!request) {
    request = personalAgentApi()
      .listNamedAgents({})
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

export function useNamedAgents(enabled = true) {
  const accountId = useTypedRedux("account", "account_id");
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
    let disposed = false;
    if (!accountId || !enabled) {
      setState({ loading: false });
      return;
    }
    setState((old) => ({ ...old, loading: true }));
    void loadNamedAgents(accountId)
      .then((directory) => {
        if (!disposed) setState({ accountId, directory, loading: false });
      })
      .catch((err) => {
        if (!disposed) setState({ accountId, loading: false, error: `${err}` });
      });
    return () => {
      disposed = true;
    };
  }, [accountId, revision, enabled]);
  return !enabled
    ? { loading: false }
    : state.accountId === accountId
      ? state
      : { loading: !!accountId };
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
