import { useEffect, useState } from "react";
import type {
  NamedAgent,
  NamedAgentDirectory,
} from "@cocalc/conat/agents/personal";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { AgentMentionReference } from "@cocalc/util/agent-mentions";

export const personalAgentApi = () => webapp_client.conat_client.hub.agent;
const listeners = new Set<() => void>();
export function refreshNamedAgents() {
  for (const listener of listeners) listener();
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

export function useNamedAgents() {
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
    if (!accountId) {
      setState({ loading: false });
      return;
    }
    setState((old) => ({ ...old, loading: true }));
    void personalAgentApi()
      .listNamedAgents({})
      .then((directory) => {
        if (!disposed) setState({ accountId, directory, loading: false });
      })
      .catch((err) => {
        if (!disposed) setState({ accountId, loading: false, error: `${err}` });
      });
    return () => {
      disposed = true;
    };
  }, [accountId, revision]);
  return state.accountId === accountId ? state : { loading: !!accountId };
}
