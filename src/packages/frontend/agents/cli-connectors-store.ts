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
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { useProjectRunQuota } from "@cocalc/frontend/project/use-project-run-quota";
import { PLATFORM_MODE_SINGLE_NODE } from "@cocalc/util/db-schema/site-defaults";
import { personalAgentApi } from "./api";

/**
 * Whether the project can reach the internet (undefined while unknown).
 * Free projects have none, so gh, git and cf there cannot reach GitHub or
 * Cloudflare and the connectors cannot work.
 */
export function useProjectHasNetwork(
  project_id: string,
  { enabled = true }: { enabled?: boolean } = {},
): boolean | undefined {
  const singleNode =
    useTypedRedux("customize", "platform_mode") === PLATFORM_MODE_SINGLE_NODE;
  const { runQuota } = useProjectRunQuota(project_id, {
    enabled: enabled && !singleNode,
  });
  if (!enabled) return undefined;
  // Single-node sites do not limit project networking.
  if (singleNode) return true;
  if (runQuota == null) return undefined;
  const network = (runQuota as any)?.network;
  return !(network === false || network === 0);
}

/**
 * The connectors this site has set up. Until an admin sets one up, nothing
 * about connectors is shown and nothing is loaded.
 */
export function useEnabledCliConnectors(): CliConnector[] {
  const github =
    useTypedRedux("customize", "cli_connector_github_enabled") === true;
  const cloudflare =
    useTypedRedux("customize", "cli_connector_cloudflare_enabled") === true;
  return [
    ...(github ? (["github"] as const) : []),
    ...(cloudflare ? (["cloudflare"] as const) : []),
  ];
}

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
  /** The connectors the site has set up; empty means none at all. */
  enabled: CliConnector[];
} {
  const enabled = useEnabledCliConnectors();
  const active = enabled.length > 0;
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
    if (!active) return;
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
  }, [version, active]);
  return { ...state, enabled };
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
