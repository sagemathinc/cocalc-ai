/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The account's CLI connector connections, grants and site setup, loaded
// once for the settings page and every message box. Kept apart from the
// dialogs so message boxes do not load those until one is opened.

import { useEffect, useState } from "react";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type {
  CliConnection,
  CliConnectorGrant,
  CliConnectorSetup,
} from "@cocalc/conat/hub/api/agent";
import type { CliConnector } from "@cocalc/util/ai/cli-connectors";
import { personalAgentApi } from "./api";

export interface CliConnectorData {
  connections: CliConnection[];
  grants: CliConnectorGrant[];
  setup: CliConnectorSetup;
}

// One shared load for the settings page and every message box.
let request: Promise<CliConnectorData> | undefined;
const listeners = new Set<() => void>();

export function refreshCliConnectors(): void {
  request = undefined;
  for (const listener of listeners) listener();
}

function loadCliConnectors(): Promise<CliConnectorData> {
  if (request == null) {
    const api = personalAgentApi();
    const pending = Promise.all([
      api.listCliConnections(),
      api.listCliConnectorGrants(),
      api.getCliConnectorSetup(),
    ]).then(([connections, grants, setup]) => ({ connections, grants, setup }));
    request = pending;
    // A failed load is retried on the next use.
    pending.catch(() => {
      if (request === pending) request = undefined;
    });
  }
  return request;
}

export function useCliConnectors(): {
  data?: CliConnectorData;
  error?: string;
} {
  const [state, setState] = useState<{
    data?: CliConnectorData;
    error?: string;
  }>({});
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    loadCliConnectors().then(
      (data) => {
        if (!cancelled) setState({ data });
      },
      (err) => {
        if (!cancelled) setState({ error: `${err}` });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [version]);
  return state;
}

export function agentGrant(
  data: CliConnectorData | undefined,
  agent: NamedAgent,
  connector: CliConnector,
): CliConnectorGrant | undefined {
  return data?.grants.find(
    (grant) =>
      grant.connector === connector &&
      grant.agent_id === agent.endpoint.agent_id &&
      grant.source_project_id === agent.endpoint.project_id,
  );
}

/** What the connector does for the agent, in a few words. */
export function cliConnectorSummary(
  data: CliConnectorData | undefined,
  agent: NamedAgent,
  connector: CliConnector,
): string {
  const grant = agentGrant(data, agent, connector);
  if (!grant?.enabled) return "Off";
  const connection = data?.connections.find(
    ({ connection_id }) => connection_id === grant.connection_id,
  );
  return connection?.description || "On";
}
