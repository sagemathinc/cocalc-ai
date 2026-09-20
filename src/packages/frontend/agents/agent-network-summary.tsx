/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { Card, Descriptions, Space, Tag, Typography } from "antd";
import type {
  AgentNetwork,
  AgentNetworkMember,
  AgentNetworkProposal,
  NamedAgent,
} from "@cocalc/conat/agents/personal";
import { isExternalAgentSource } from "@cocalc/conat/agents/rpc";
import { Icon } from "@cocalc/frontend/components/icon";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { networkColor, networkProjectCount } from "./agent-network-utils";

const { Text } = Typography;

function memberLabel(member: AgentNetworkMember): string {
  if (member.kind === "external") return member.label;
  return member.name
    ? `@${member.name}`
    : (member.thread_title ?? member.member_id);
}

export function AgentNetworkSummary({
  network,
  compact = false,
}: {
  network: AgentNetwork;
  compact?: boolean;
}) {
  const projects = networkProjectCount(network);
  return (
    <Card
      size="small"
      title={
        <Space wrap>
          <Tag color={networkColor(network)}>{network.title}</Tag>
          <Tag>{network.delivery_mode}</Tag>
          {network.state !== "active" && (
            <Tag
              icon={
                <Icon name={network.state === "paused" ? "pause" : "lock"} />
              }
            >
              {network.state}
            </Tag>
          )}
        </Space>
      }
      style={{ width: "100%" }}
    >
      <Space
        orientation="vertical"
        size={compact ? 4 : 8}
        style={{ width: "100%" }}
      >
        <Text type="secondary">
          {network.members.length} members across {projects} project
          {projects === 1 ? "" : "s"}; every member can communicate with every
          other member.
        </Text>
        <Space wrap size={[4, 4]}>
          {network.members.map((member) => (
            <Tag
              key={member.member_id}
              icon={
                <Icon name={member.kind === "external" ? "network" : "robot"} />
              }
              title={member.member_id}
            >
              {memberLabel(member)}
              {member.kind === "registered" && member.project_title
                ? ` · ${member.project_title}`
                : ""}
            </Tag>
          ))}
        </Space>
        {!compact && (
          <Descriptions size="small" column={1}>
            <Descriptions.Item label="Network ID">
              <Text copyable code style={{ color: UI_COLORS.secondary }}>
                {network.agent_network_id}
              </Text>
            </Descriptions.Item>
            <Descriptions.Item label="Generation">
              <Text copyable code style={{ color: UI_COLORS.secondary }}>
                {network.generation}
              </Text>
            </Descriptions.Item>
          </Descriptions>
        )}
      </Space>
    </Card>
  );
}

export function AgentNetworkProposalSummary({
  proposal,
  agents,
}: {
  proposal: AgentNetworkProposal;
  agents: NamedAgent[];
}) {
  const projects = new Set(
    proposal.members.flatMap((member) =>
      member.kind === "registered" ? [member.endpoint.project_id] : [],
    ),
  );
  const sourceLabel = isExternalAgentSource(proposal.source)
    ? `External ${proposal.source.agent_id}`
    : (agents.find(
        ({ endpoint }) =>
          endpoint.project_id === proposal.source.project_id &&
          endpoint.agent_id === proposal.source.agent_id,
      )?.name ?? proposal.source.agent_id);
  return (
    <Card size="small" style={{ width: "100%" }}>
      <Space orientation="vertical" size={8} style={{ width: "100%" }}>
        <Space wrap>
          <Tag color="gold">{proposal.title}</Tag>
          <Tag>{proposal.delivery_mode}</Tag>
          <Tag>{proposal.members.length} members</Tag>
          <Tag>{projects.size} projects</Tag>
        </Space>
        <Text>
          Proposed by{" "}
          <strong>
            {sourceLabel.startsWith("External ")
              ? sourceLabel
              : `@${sourceLabel}`}
          </strong>
        </Text>
        <Space wrap size={[4, 4]}>
          {proposal.members.map((member) => {
            const named =
              member.kind === "registered"
                ? agents.find(
                    ({ endpoint }) =>
                      endpoint.project_id === member.endpoint.project_id &&
                      endpoint.agent_id === member.endpoint.agent_id,
                  )
                : undefined;
            const immutableId =
              member.kind === "registered"
                ? `${member.endpoint.project_id}:${member.endpoint.agent_id}`
                : `${member.agent_id}:${member.installation_id}`;
            return (
              <Tag
                key={`${member.kind}:${immutableId}`}
                icon={
                  <Icon
                    name={member.kind === "external" ? "network" : "robot"}
                  />
                }
                title={immutableId}
              >
                {member.kind === "external"
                  ? `External ${member.agent_id}`
                  : named
                    ? `@${named.name} · ${named.project_title ?? member.endpoint.project_id}`
                    : immutableId}
              </Tag>
            );
          })}
        </Space>
        <Descriptions size="small" column={1}>
          <Descriptions.Item label="Proposal ID">
            <Text copyable code>
              {proposal.proposal_id}
            </Text>
          </Descriptions.Item>
          <Descriptions.Item label="Source ID">
            <Text copyable code>
              {proposal.source.agent_id}
            </Text>
          </Descriptions.Item>
        </Descriptions>
      </Space>
    </Card>
  );
}
