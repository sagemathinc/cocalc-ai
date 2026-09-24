/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useRef, useState } from "react";
import { Alert, Button, Input, Modal, Space, Tag, Typography } from "antd";
import type {
  AgentNetwork,
  AgentNetworkDirectory,
  NamedAgent,
} from "@cocalc/conat/agents/personal";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { uuid } from "@cocalc/util/misc";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { personalAgentApi, refreshAgentNetworks, sameEndpoint } from "./api";
import {
  duplicateNetworkTitle,
  networkColor,
  networkProjectCount,
} from "./agent-network-utils";

const { Text } = Typography;

export function AgentNetworkTagsEditor({
  agent,
  agents,
  directory,
  onClose,
}: {
  agent: NamedAgent;
  agents: NamedAgent[];
  directory: AgentNetworkDirectory;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [peerId, setPeerId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestIds = useRef(new Map<string, string>());
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const networks = directory.networks.filter(
    (network) => network.state !== "closed",
  );
  const peers = agents.filter(
    (candidate) => !sameEndpoint(candidate.endpoint, agent.endpoint),
  );
  const duplicate = duplicateNetworkTitle(directory.networks, title);

  function requestId(key: string): string {
    let id = requestIds.current.get(key);
    if (!id) {
      id = uuid();
      requestIds.current.set(key, id);
    }
    return id;
  }

  async function mutate(
    key: string,
    action: () => Promise<unknown>,
    success: string,
    requireFresh: boolean,
  ) {
    if (busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const completed = requireFresh
        ? await runFreshAuthAction(async () => {
            await action();
          })
        : await action().then(() => true);
      if (completed) {
        requestIds.current.delete(key);
        setNotice(success);
        refreshAgentNetworks();
      }
      return completed;
    } catch (err) {
      setError(`${err}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function setMembership(network: AgentNetwork, member: boolean) {
    const key = `${network.agent_network_id}:${member ? "remove" : "add"}:${agent.endpoint.agent_id}:${network.generation}`;
    const projects = networkProjectCount(network);
    void mutate(
      key,
      () =>
        personalAgentApi().updateAgentNetwork({
          request_id: requestId(key),
          agent_network_id: network.agent_network_id,
          action: member ? "remove-member" : "add-member",
          member: { kind: "registered", endpoint: agent.endpoint },
        }),
      member
        ? `Removed @${agent.name} from ${network.title}.`
        : `Added @${agent.name} to ${network.title}. Members can now message each other.`,
      !member &&
        projects > 0 &&
        !network.members.some(
          (existing) =>
            existing.kind === "registered" &&
            !existing.removed_at &&
            existing.endpoint.project_id === agent.endpoint.project_id,
        ),
    );
  }

  async function create() {
    const peer = peers.find(
      (candidate) => candidate.endpoint.agent_id === peerId,
    );
    if (!peer || !title.trim() || duplicate) return;
    const key = `create:${title.trim()}:${agent.endpoint.agent_id}:${peer.endpoint.agent_id}`;
    const completed = await mutate(
      key,
      () =>
        personalAgentApi().createAgentNetwork({
          request_id: requestId(key),
          title: title.trim(),
          delivery_mode: "live",
          members: [
            { kind: "registered", endpoint: agent.endpoint },
            { kind: "registered", endpoint: peer.endpoint },
          ],
        }),
      `Created live network tag ${title.trim()} for @${agent.name} and @${peer.name}.`,
      peer.endpoint.project_id !== agent.endpoint.project_id,
    );
    if (completed) {
      setTitle("");
      setPeerId(undefined);
    }
  }

  return (
    <>
      <Modal
        open
        title={`Network tags for @${agent.name}`}
        onCancel={() => {
          if (!busy) onClose();
        }}
        footer={
          <Button onClick={onClose} disabled={busy}>
            Close
          </Button>
        }
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            title="Network tags are permissions, not just labels."
            description="Every agent sharing a network tag can message every other member in both directions. Live delivery can interrupt a running turn. Removing a tag blocks future messages, but does not cancel work already accepted."
          />
          {error && <Alert role="alert" type="error" showIcon title={error} />}
          {notice && (
            <Alert role="status" type="success" showIcon title={notice} />
          )}
          <section
            aria-label="Available network tags"
            style={{ width: "100%" }}
          >
            <Space orientation="vertical" style={{ width: "100%" }}>
              <Text strong>Available network tags</Text>
              {networks.length === 0 && (
                <Text type="secondary">No network tags yet.</Text>
              )}
              {networks.map((network) => {
                const member = network.members.some(
                  (existing) =>
                    existing.kind === "registered" &&
                    !existing.removed_at &&
                    sameEndpoint(existing.endpoint, agent.endpoint),
                );
                const cannotRemove = member && network.members.length <= 2;
                const cannotAdd =
                  !member &&
                  network.members.length >= directory.usage.member_limit;
                return (
                  <div
                    key={network.agent_network_id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <Tag
                      color={
                        network.state === "paused"
                          ? undefined
                          : networkColor(network)
                      }
                    >
                      {network.title}
                    </Tag>
                    <Text type="secondary">
                      {network.delivery_mode} · {network.members.length} members
                      {network.state === "paused" ? " · paused" : ""}
                    </Text>
                    <Button
                      size="small"
                      disabled={busy || cannotRemove || cannotAdd}
                      title={
                        cannotRemove
                          ? "A network must retain at least two members"
                          : undefined
                      }
                      aria-label={`${member ? "Remove" : "Add"} @${agent.name} ${member ? "from" : "to"} ${network.title} network tag`}
                      onClick={() => setMembership(network, member)}
                    >
                      {member ? "Remove" : "Add"}
                    </Button>
                    {duplicateNetworkTitle(
                      networks,
                      network.title,
                      network.agent_network_id,
                    ) && (
                      <Text type="warning">
                        Same name as another tag; ID{" "}
                        {network.agent_network_id.slice(0, 8)}
                      </Text>
                    )}
                  </div>
                );
              })}
            </Space>
          </section>
          <section aria-label="Create network tag">
            <Space orientation="vertical" style={{ width: "100%" }}>
              <Text strong>Create a live network tag</Text>
              <Text type="secondary">
                A new network needs at least two agents. Its color is assigned
                from its stable ID.
              </Text>
              <label htmlFor="new-network-tag-title">Tag name</label>
              <Input
                id="new-network-tag-title"
                value={title}
                maxLength={120}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Release review"
                status={duplicate ? "error" : undefined}
                aria-describedby={
                  duplicate ? "network-tag-duplicate" : undefined
                }
              />
              {duplicate && (
                <Text id="network-tag-duplicate" type="danger">
                  A network tag with this name already exists. Choose a distinct
                  name.
                </Text>
              )}
              <label htmlFor="new-network-tag-peer">Second agent</label>
              <select
                id="new-network-tag-peer"
                value={peerId ?? ""}
                onChange={(event) => setPeerId(event.target.value || undefined)}
                style={{
                  width: "100%",
                  minHeight: 34,
                  border: `1px solid ${UI_COLORS.border}`,
                  borderRadius: 6,
                  background: UI_COLORS.surface,
                  color: UI_COLORS.text,
                  paddingInline: 8,
                }}
              >
                <option value="">Choose another agent</option>
                {peers.map((peer) => (
                  <option
                    key={peer.endpoint.agent_id}
                    value={peer.endpoint.agent_id}
                  >
                    @{peer.name} - {peer.project_title ?? "Project"}
                  </option>
                ))}
              </select>
              <Button
                type="primary"
                disabled={
                  busy ||
                  !title.trim() ||
                  duplicate ||
                  !peerId ||
                  directory.usage.active_networks >=
                    directory.usage.network_limit
                }
                onClick={() => void create()}
              >
                Create network tag
              </Button>
            </Space>
          </section>
        </Space>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
