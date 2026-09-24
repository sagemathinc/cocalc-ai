/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { Space, Tag } from "antd";
import type { AgentNetwork } from "@cocalc/conat/agents/personal";
import { Icon } from "@cocalc/frontend/components/icon";
import { Tooltip } from "@cocalc/frontend/components/tip";
export { networkColor, networkProjectCount } from "./agent-network-utils";
import {
  activeNetworkMembers,
  networkColor,
  networkProjectCount,
} from "./agent-network-utils";

export function AgentNetworkPills({
  networks,
  onOpen,
}: {
  networks: AgentNetwork[];
  onOpen: (network: AgentNetwork) => void;
}) {
  if (!networks.length) return null;
  return (
    <Space size={4} wrap>
      {networks.map((network) => {
        const projects = networkProjectCount(network);
        return (
          <Tooltip
            key={network.agent_network_id}
            title={`${activeNetworkMembers(network).length} members · ${network.delivery_mode} delivery · ${projects} project${projects === 1 ? "" : "s"}`}
          >
            <button
              type="button"
              aria-label={`Configure ${network.title} network tag`}
              onClick={() => onOpen(network)}
              style={{
                border: 0,
                background: "transparent",
                padding: 0,
                cursor: "pointer",
              }}
            >
              <Tag
                color={
                  network.state === "paused" ? undefined : networkColor(network)
                }
                style={{
                  marginInlineEnd: 0,
                  maxWidth: 200,
                  opacity: network.state === "paused" ? 0.72 : 1,
                }}
              >
                {network.state === "paused" && <Icon name="pause" />}{" "}
                {network.title}
              </Tag>
            </button>
          </Tooltip>
        );
      })}
    </Space>
  );
}
