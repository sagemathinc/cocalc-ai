/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApartmentOutlined } from "@ant-design/icons";
import { Alert, Button, Modal, Spin } from "antd";
import type { MenuProps } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { CocalcConnector } from "./cocalc-connector";
import { AgentNetworkTagsEditor } from "./agent-network-tags-editor";
import { AgentNetworkDetailsModal } from "./agent-network-details-modal";
import { activeNetworkMembers } from "./agent-network-utils";
import { refreshAgentNetworks, sameEndpoint, useAgentNetworks } from "./api";

interface Props {
  agent?: NamedAgent;
  children: (items: MenuProps["items"]) => ReactNode;
}

export function ComposerConnectors({ agent, children }: Props) {
  return agent ? (
    <NamedAgentConnectors
      key={`${agent.endpoint.project_id}:${agent.endpoint.agent_id}`}
      agent={agent}
    >
      {children}
    </NamedAgentConnectors>
  ) : (
    children([])
  );
}

function ConnectorIcon({
  label,
  icon,
  onClick,
  muted = false,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  muted?: boolean;
}) {
  return (
    <Tooltip title={label}>
      <Button
        type="text"
        shape="circle"
        aria-label={label}
        aria-haspopup="dialog"
        icon={icon}
        onClick={onClick}
        style={{
          width: 32,
          minWidth: 32,
          height: 32,
          opacity: muted ? 0.6 : 1,
        }}
      />
    </Tooltip>
  );
}

function NamedAgentConnectors({
  agent,
  children,
}: Props & { agent: NamedAgent }) {
  const { directory, error } = useAgentNetworks();
  const menuRef = useRef<HTMLSpanElement>(null);
  const [networksOpen, setNetworksOpen] = useState(false);
  const [detailsId, setDetailsId] = useState<string>();
  const networks = directory?.networks ?? [];
  const assigned = networks.filter(
    (network) =>
      network.state !== "closed" &&
      activeNetworkMembers(network).some(
        (member) =>
          member.kind === "registered" &&
          sameEndpoint(member.endpoint, agent.endpoint),
      ),
  );
  const paused =
    directory?.controls.paused ||
    assigned.every((network) => network.state !== "active");
  const openNetworks = () => setNetworksOpen(true);
  return (
    <>
      <CocalcConnector
        agent={agent}
        onRemoved={() => menuRef.current?.querySelector("button")?.focus()}
        renderTrigger={({ config, onOpen }) => (
          <>
            <span ref={menuRef} style={{ display: "inline-flex" }}>
              {children([
                {
                  key: "cocalc-connector",
                  label: "CoCalc",
                  icon: (
                    <span aria-hidden>
                      <Icon name="cocalc-ring" />
                    </span>
                  ),
                  onClick: onOpen,
                },
                {
                  key: "agent-networks",
                  label: "Agent Networks",
                  icon: <ApartmentOutlined aria-hidden />,
                  onClick: openNetworks,
                },
              ])}
            </span>
            {config && (
              <ConnectorIcon
                label={`CoCalc connector${config.enabled ? "" : " (disabled)"}`}
                icon={<Icon name="cocalc-ring" />}
                onClick={onOpen}
                muted={!config.enabled}
              />
            )}
            {assigned.length > 0 && (
              <ConnectorIcon
                label={`Agent Networks connector (${assigned.length} ${assigned.length === 1 ? "tag" : "tags"}${paused ? ", paused" : ""})`}
                icon={<ApartmentOutlined />}
                onClick={openNetworks}
                muted={paused}
              />
            )}
          </>
        )}
      />
      {directory ? (
        <AgentNetworkTagsEditor
          open={networksOpen}
          agent={agent}
          directory={directory}
          onClose={() => setNetworksOpen(false)}
          onOpenNetwork={(network) => setDetailsId(network.agent_network_id)}
        />
      ) : (
        <Modal
          open={networksOpen}
          title={`Network tags for @${agent.name}`}
          onCancel={() => setNetworksOpen(false)}
          footer={null}
          modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
        >
          {error ? (
            <Alert
              type="error"
              title="Unable to load Agent Networks"
              description={error}
              action={
                <Button onClick={() => void refreshAgentNetworks()}>
                  Retry
                </Button>
              }
            />
          ) : (
            <Spin aria-label="Loading Agent Networks" />
          )}
        </Modal>
      )}
      <AgentNetworkDetailsModal
        network={networks.find(
          (network) => network.agent_network_id === detailsId,
        )}
        networks={networks}
        onSelectNetwork={(network) => setDetailsId(network.agent_network_id)}
        onClose={() => setDetailsId(undefined)}
        onChanged={refreshAgentNetworks}
      />
    </>
  );
}
