/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { Button, Popover, Space, Tag } from "antd";
import type { AgentNetwork } from "@cocalc/conat/agents/personal";
import { Icon } from "@cocalc/frontend/components/icon";
import { Tooltip } from "@cocalc/frontend/components/tip";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
export { networkColor, networkProjectCount } from "./agent-network-utils";
import { networkColor, networkProjectCount } from "./agent-network-utils";

function NetworkPill({
  network,
  selected,
  onSelect,
  onOpen,
}: {
  network: AgentNetwork;
  selected?: boolean;
  onSelect?: (network: AgentNetwork) => void;
  onOpen?: (network: AgentNetwork) => void;
}) {
  const projects = networkProjectCount(network);
  const interactive = !!onSelect || (selected && !!onOpen);
  const tooltip = `${network.members.length} members · ${network.delivery_mode} delivery · ${projects} project${projects === 1 ? "" : "s"}${selected && onOpen ? " · Open network details" : ""}`;
  const activate = () => {
    if (selected && onOpen) {
      onOpen(network);
    } else {
      onSelect?.(network);
    }
  };
  return (
    <Tooltip title={tooltip}>
      <Tag
        color={network.state === "paused" ? undefined : networkColor(network)}
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-pressed={interactive ? selected : undefined}
        onClick={(event) => {
          event.stopPropagation();
          activate();
        }}
        onKeyDown={(event) => {
          if (!interactive || (event.key !== "Enter" && event.key !== " "))
            return;
          event.preventDefault();
          event.stopPropagation();
          activate();
        }}
        style={{
          cursor: interactive ? "pointer" : undefined,
          marginInlineEnd: 0,
          maxWidth: 150,
          opacity: network.state === "paused" ? 0.72 : 1,
          outline: selected ? `2px solid ${UI_COLORS.focus}` : undefined,
          outlineOffset: selected ? 1 : undefined,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {network.state === "paused" && <Icon name="pause" />} {network.title}
      </Tag>
    </Tooltip>
  );
}

export function AgentNetworkPills({
  networks,
  maxVisible = 1,
  selectedNetworkId,
  onSelect,
  onOpen,
}: {
  networks: AgentNetwork[];
  maxVisible?: number;
  selectedNetworkId?: string;
  onSelect?: (network: AgentNetwork) => void;
  onOpen?: (network: AgentNetwork) => void;
}) {
  if (!networks.length) return null;
  const visible = networks.slice(0, maxVisible);
  const overflow = networks.slice(maxVisible);
  return (
    <Space size={4} wrap>
      {visible.map((network) => (
        <NetworkPill
          key={network.agent_network_id}
          network={network}
          selected={network.agent_network_id === selectedNetworkId}
          onSelect={onSelect}
          onOpen={onOpen}
        />
      ))}
      {overflow.length > 0 && (
        <Popover
          trigger="click"
          title="Agent Networks"
          content={
            <Space orientation="vertical" size={4}>
              {overflow.map((network) => (
                <Button
                  key={network.agent_network_id}
                  type="text"
                  size="small"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (
                      network.agent_network_id === selectedNetworkId &&
                      onOpen
                    ) {
                      onOpen(network);
                    } else {
                      onSelect?.(network);
                    }
                  }}
                >
                  {network.title}
                </Button>
              ))}
            </Space>
          }
        >
          <Tag style={{ cursor: "pointer", marginInlineEnd: 0 }}>
            +{overflow.length}
          </Tag>
        </Popover>
      )}
    </Space>
  );
}
