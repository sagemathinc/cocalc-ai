/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Settings > Connectors: the services the account's agents can use and which
// agents use each. A connector is turned on for an agent, and scoped, from the
// connectors list (+) in that agent's message box.

import { DeleteOutlined } from "@ant-design/icons";
import { Alert, Button, Spin, Table, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { defineMessage } from "react-intl";
import type { AgentNetwork, NamedAgent } from "@cocalc/conat/agents/personal";
import type { CocalcConnectorConfig } from "@cocalc/conat/hub/api/agent";
import { Panel } from "@cocalc/frontend/antd-bootstrap";
import { FreshAuthModal } from "@cocalc/frontend/auth/fresh-auth";
import { Tooltip } from "@cocalc/frontend/components";
import {
  personalAgentApi,
  refreshAgentNetworks,
  useAgentNetworks,
  useNamedAgents,
} from "@cocalc/frontend/agents/api";
import { activeNetworkMembers } from "@cocalc/frontend/agents/agent-network-utils";
import { CliConnectorSection } from "@cocalc/frontend/agents/cli-connectors";
import { CocalcConnector } from "@cocalc/frontend/agents/cocalc-connector";
import { cocalcAccessSummary } from "@cocalc/frontend/agents/composer-connectors";
import { useAgentNetworkActions } from "@cocalc/frontend/agents/use-agent-network-actions";
import { AgentMessagingSettings } from "./agent-messaging-settings";
import { openAccountSettings } from "./settings-routing";
import type { SettingsPageDefinition } from "./settings-page";

const COCALC_ACCESS = "CoCalc access";
const AGENT_NETWORKS = "Agent Networks";

export const CONNECTORS_SETTINGS_PAGE = {
  component: ConnectorsPage,
  description: defineMessage({
    id: "account.settings.overview.connectors",
    defaultMessage: "Services your agents can use, and which agents use each.",
  }),
  controls: [
    COCALC_ACCESS,
    "GitHub",
    "Cloudflare",
    AGENT_NETWORKS,
    "Pause all messaging",
    "Revoke all networks",
    "External agent installations",
  ],
  icon: "api",
  key: "connectors",
  label: defineMessage({
    id: "account.settings.connectors.label",
    defaultMessage: "Connectors",
  }),
} satisfies SettingsPageDefinition;

export function ConnectorsPage() {
  return (
    <>
      <Typography.Paragraph type="secondary" style={{ maxWidth: 900 }}>
        Connectors let your agents use services beyond their own project. Turn
        one on for an agent, and choose what it can reach, from the connectors
        list (+) in that agent&apos;s message box. Agents use connectors only
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
      <CliConnectorSection connector="github" />
      <CliConnectorSection connector="cloudflare" />
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

// A small borderless button for a table cell that toggles one setting.
function ToggleCell({
  label,
  text,
  disabled,
  onClick,
}: {
  label: string;
  text: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip title={label}>
      <Button
        type="link"
        size="small"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        style={{ paddingInline: 0 }}
      >
        {text}
      </Button>
    </Tooltip>
  );
}

function AgentNetworksSection() {
  const { directory, error } = useAgentNetworks();
  const actions = useAgentNetworkActions();
  const networks = (directory?.networks ?? []).filter(
    ({ state }) => state !== "closed",
  );
  const allPaused = directory?.controls.paused === true;
  return (
    <Panel header={AGENT_NETWORKS}>
      <Typography.Paragraph type="secondary">
        Lets your agents message each other, across projects and across Claude
        and Codex. You create networks and choose their members on the Agents
        page; agents cannot create them. A live network can add a message to a
        member&apos;s running turn as guidance; a queued one waits for the turn
        to finish.
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
      ) : networks.length === 0 ? (
        <Typography.Paragraph>You have no Agent Networks.</Typography.Paragraph>
      ) : (
        <>
          {actions.error && (
            <Alert
              role="alert"
              type="error"
              showIcon
              title={actions.error}
              style={{ marginBottom: 12 }}
            />
          )}
          <Table<AgentNetwork>
            size="small"
            pagination={false}
            rowKey="agent_network_id"
            dataSource={networks}
            style={{ marginBottom: 16 }}
            columns={[
              { key: "title", title: "Network", dataIndex: "title" },
              {
                key: "members",
                title: "Agents",
                render: (_, network) => activeNetworkMembers(network).length,
              },
              {
                key: "status",
                title: "Status",
                render: (_, network) =>
                  allPaused ? (
                    "Paused (all messaging)"
                  ) : (
                    <ToggleCell
                      text={network.state === "paused" ? "Paused" : "Active"}
                      label={`${network.state === "paused" ? "Resume" : "Pause"} the ${network.title} network`}
                      disabled={actions.busy != null}
                      onClick={() => actions.togglePaused(network)}
                    />
                  ),
              },
              {
                key: "delivery",
                title: "Delivery",
                render: (_, network) => (
                  <ToggleCell
                    text={network.delivery_mode === "live" ? "Live" : "Queued"}
                    label={`Use ${network.delivery_mode === "live" ? "queued" : "live"} delivery in the ${network.title} network`}
                    disabled={actions.busy != null}
                    onClick={() => actions.toggleDelivery(network)}
                  />
                ),
              },
              {
                key: "delete",
                title: "",
                align: "right",
                render: (_, network) => (
                  <Button
                    size="small"
                    danger
                    type="text"
                    icon={<DeleteOutlined aria-hidden />}
                    aria-label={`Delete the ${network.title} network`}
                    disabled={actions.busy != null}
                    onClick={() => actions.remove(network)}
                  />
                ),
              },
            ]}
          />
        </>
      )}
      <AgentMessagingSettings />
      <FreshAuthModal {...actions.freshAuthModalProps} />
    </Panel>
  );
}
