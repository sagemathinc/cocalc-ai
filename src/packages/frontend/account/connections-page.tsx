/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Settings > Connections: the services the account's agents can use and which
// agents use each. A connection is turned on for an agent, and scoped, from
// the connectors list (+) in that agent's message box.

import { Alert, Button, Spin, Table, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { defineMessage } from "react-intl";
import type { AgentNetwork, NamedAgent } from "@cocalc/conat/agents/personal";
import type { CocalcConnectorConfig } from "@cocalc/conat/hub/api/agent";
import { Panel } from "@cocalc/frontend/antd-bootstrap";
import {
  personalAgentApi,
  refreshAgentNetworks,
  useAgentNetworks,
  useNamedAgents,
} from "@cocalc/frontend/agents/api";
import { activeNetworkMembers } from "@cocalc/frontend/agents/agent-network-utils";
import { CocalcConnector } from "@cocalc/frontend/agents/cocalc-connector";
import { cocalcAccessSummary } from "@cocalc/frontend/agents/composer-connectors";
import { openAccountSettings } from "./settings-routing";
import type { SettingsPageDefinition } from "./settings-page";

const COCALC_ACCESS = "CoCalc access";
const AGENT_NETWORKS = "Agent Networks";

export const CONNECTIONS_SETTINGS_PAGE = {
  component: ConnectionsPage,
  description: defineMessage({
    id: "account.settings.overview.connections",
    defaultMessage: "Services your agents can use, and which agents use each.",
  }),
  controls: [COCALC_ACCESS, AGENT_NETWORKS],
  icon: "api",
  key: "connections",
  label: defineMessage({
    id: "account.settings.connections.label",
    defaultMessage: "Connections",
  }),
} satisfies SettingsPageDefinition;

export function ConnectionsPage() {
  return (
    <>
      <Typography.Paragraph type="secondary" style={{ maxWidth: 900 }}>
        Connections let your agents use services beyond their own project. Turn
        one on for an agent, and choose what it can reach, from the connectors
        list (+) in that agent&apos;s message box. Agents use connections only
        during their turns, through CoCalc. The Claude and ChatGPT subscriptions
        agents run on are in{" "}
        <Button
          type="link"
          style={{ padding: 0, height: "auto" }}
          onClick={() => openAccountSettings({ page: "ai" })}
        >
          AI settings
        </Button>
        .
      </Typography.Paragraph>
      <CocalcAccessSection />
      <AgentNetworksSection />
    </>
  );
}

function useCocalcAccessConfigs() {
  const [state, setState] = useState<{
    configs?: CocalcConnectorConfig[];
    error?: string;
  }>({});
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    personalAgentApi()
      .listCocalcConnectorConfigs()
      .then(
        (configs) => {
          if (!cancelled) setState({ configs });
        },
        (err) => {
          if (!cancelled) setState({ error: `${err}` });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [revision]);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  return { ...state, refresh };
}

type AccessRow = {
  key: string;
  agent: NamedAgent;
  config: CocalcConnectorConfig;
};

function CocalcAccessSection() {
  const { directory, error: agentsError } = useNamedAgents();
  const { configs, error, refresh } = useCocalcAccessConfigs();
  // Settings for agents the account can no longer reach stay unused.
  const rows: AccessRow[] = (configs ?? []).flatMap((config) => {
    const agent = directory?.agents.find(
      ({ endpoint }) =>
        endpoint.agent_id === config.agent_id &&
        endpoint.project_id === config.source_project_id,
    );
    return agent ? [{ key: config.config_id, agent, config }] : [];
  });
  return (
    <Panel header={COCALC_ACCESS}>
      <Typography.Paragraph type="secondary">
        Lets an agent use your other CoCalc projects (their files and commands)
        during its turns. Every agent can always use its own project.
      </Typography.Paragraph>
      {error || agentsError ? (
        <Alert
          type="error"
          title="Unable to load CoCalc access"
          description={error ?? agentsError}
          action={<Button onClick={refresh}>Retry</Button>}
        />
      ) : configs == null || directory == null ? (
        <Spin aria-label="Loading CoCalc access" />
      ) : rows.length === 0 ? (
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          No agent has CoCalc access.
        </Typography.Paragraph>
      ) : (
        <Table<AccessRow>
          size="small"
          pagination={false}
          rowKey="key"
          dataSource={rows}
          columns={[
            {
              key: "agent",
              title: "Agent",
              render: (_, { agent }) => `@${agent.name}`,
            },
            {
              key: "project",
              title: "Project",
              render: (_, { agent }) => agent.project_title ?? "",
            },
            {
              key: "access",
              title: "Access",
              render: (_, { agent, config }) =>
                cocalcAccessSummary(config, agent.endpoint.project_id),
            },
            {
              key: "manage",
              title: "",
              align: "right",
              render: (_, { agent }) => (
                <CocalcConnector
                  agent={agent}
                  onChanged={refresh}
                  renderTrigger={({ onOpen }) => (
                    <Button
                      size="small"
                      aria-label={`Manage CoCalc access for @${agent.name}`}
                      onClick={onOpen}
                    >
                      Manage
                    </Button>
                  )}
                />
              ),
            },
          ]}
        />
      )}
    </Panel>
  );
}

function networkState(network: AgentNetwork, allPaused: boolean): string {
  if (allPaused || network.state === "paused") return "Paused";
  return network.delivery_mode === "live" ? "Active, live" : "Active";
}

function AgentNetworksSection() {
  const { directory, error } = useAgentNetworks();
  const networks = (directory?.networks ?? []).filter(
    ({ state }) => state !== "closed",
  );
  const allPaused = directory?.controls.paused === true;
  return (
    <Panel header={AGENT_NETWORKS}>
      <Typography.Paragraph type="secondary">
        Lets your agents message each other, across projects and across Claude
        and Codex. You create networks and choose their members on the Agents
        page; agents cannot create them.
      </Typography.Paragraph>
      {error ? (
        <Alert
          type="error"
          title="Unable to load Agent Networks"
          description={error}
          action={
            <Button onClick={() => void refreshAgentNetworks()}>Retry</Button>
          }
        />
      ) : directory == null ? (
        <Spin aria-label="Loading Agent Networks" />
      ) : (
        <>
          {allPaused && (
            <Alert
              type="warning"
              showIcon
              title="All agent messaging is paused."
              style={{ marginBottom: 12 }}
            />
          )}
          {networks.length === 0 ? (
            <Typography.Paragraph>
              You have no Agent Networks.
            </Typography.Paragraph>
          ) : (
            <Table<AgentNetwork>
              size="small"
              pagination={false}
              rowKey="agent_network_id"
              dataSource={networks}
              style={{ marginBottom: 12 }}
              columns={[
                { key: "title", title: "Network", dataIndex: "title" },
                {
                  key: "members",
                  title: "Agents",
                  render: (_, network) => activeNetworkMembers(network).length,
                },
                {
                  key: "state",
                  title: "State",
                  render: (_, network) => networkState(network, allPaused),
                },
              ]}
            />
          )}
        </>
      )}
      <Button onClick={() => openAccountSettings({ page: "ai" })}>
        Messaging settings
      </Button>
    </Panel>
  );
}
