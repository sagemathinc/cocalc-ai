/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Select, Space, Tag, Typography } from "antd";
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
import { personalAgentApi, refreshAgentNetworks, sameEndpoint } from "./api";
import {
  activeNetworkMembers,
  duplicateNetworkTitle,
  networkColor,
  networkProjectCount,
} from "./agent-network-utils";
import { AgentNetworkPills } from "./agent-network-pills";

const { Text } = Typography;

function isMember(network: AgentNetwork, agent: NamedAgent): boolean {
  return activeNetworkMembers(network).some(
    (member) =>
      member.kind === "registered" &&
      sameEndpoint(member.endpoint, agent.endpoint),
  );
}

export function AgentNetworkTagsEditor({
  agent,
  directory,
  onClose,
  onOpenNetwork,
}: {
  agent: NamedAgent;
  directory: AgentNetworkDirectory;
  onClose: () => void;
  onOpenNetwork: (network: AgentNetwork) => void;
}) {
  const [optimistic, setOptimistic] = useState<string[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestIds = useRef(new Map<string, string>());
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const networks = directory.networks.filter(
    (network) => network.state !== "closed",
  );
  const selected = networks
    .filter((network) => isMember(network, agent))
    .map(({ agent_network_id }) => agent_network_id);
  const value = optimistic ?? selected;
  const memberNetworks = networks.filter((network) =>
    value.includes(network.agent_network_id),
  );

  useEffect(() => {
    setOptimistic(undefined);
  }, [directory]);

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
    next: string[],
    action: () => Promise<unknown>,
    success: string,
    requireFresh: boolean,
  ) {
    if (busy) return;
    setBusy(true);
    setOptimistic(next);
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
      } else {
        setOptimistic(undefined);
      }
    } catch (err) {
      setOptimistic(undefined);
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  function changeMembership(
    network: AgentNetwork,
    remove: boolean,
    next: string[],
  ) {
    const key = `${network.agent_network_id}:${remove ? "remove" : "add"}:${agent.endpoint.agent_id}:${network.generation}`;
    const members = activeNetworkMembers(network);
    void mutate(
      key,
      next,
      () =>
        personalAgentApi().updateAgentNetwork({
          request_id: requestId(key),
          agent_network_id: network.agent_network_id,
          action: remove ? "remove-member" : "add-member",
          member: { kind: "registered", endpoint: agent.endpoint },
        }),
      remove
        ? `Removed @${agent.name} from ${network.title}.`
        : `Added @${agent.name} to ${network.title}.`,
      !remove &&
        networkProjectCount(network) > 0 &&
        !members.some(
          (member) =>
            member.kind === "registered" &&
            member.endpoint.project_id === agent.endpoint.project_id,
        ),
    );
  }

  function onTagsChange(next: string[]) {
    if (busy) return;
    const added = next.filter((id) => !value.includes(id));
    const removed = value.filter((id) => !next.includes(id));
    if (added.length + removed.length !== 1) return;
    if (removed.length) {
      const network = networks.find(
        ({ agent_network_id }) => agent_network_id === removed[0],
      );
      if (network) changeMembership(network, true, next);
      return;
    }
    const candidate = added[0];
    const existing = networks.find(
      ({ agent_network_id }) => agent_network_id === candidate,
    );
    if (existing) {
      changeMembership(existing, false, next);
      return;
    }
    const title = candidate.trim();
    if (!title || title.length > 120) {
      setError("A network tag name must contain 1 to 120 characters.");
      return;
    }
    const matching = directory.networks.filter(
      (network) =>
        network.title.trim().toLocaleLowerCase() === title.toLocaleLowerCase(),
    );
    if (matching.length) {
      setError(
        matching.length === 1
          ? "This network tag already exists. Select it from the list instead."
          : "Several network tags have this name. Select the intended one from the list.",
      );
      return;
    }
    if (directory.usage.active_networks >= directory.usage.network_limit) {
      setError("The active network tag limit has been reached.");
      return;
    }
    const key = `create:${title}:${agent.endpoint.project_id}:${agent.endpoint.agent_id}`;
    void mutate(
      key,
      next,
      () =>
        personalAgentApi().createAgentNetwork({
          request_id: requestId(key),
          title,
          delivery_mode: "live",
          members: [{ kind: "registered", endpoint: agent.endpoint }],
        }),
      `Created live network tag ${title} for @${agent.name}.`,
      false,
    );
  }

  return (
    <>
      <Modal
        open
        title={`Network tags${value.length ? ` (${value.length})` : ""} for @${agent.name}`}
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
          <AgentNetworkPills networks={memberNetworks} onOpen={onOpenNetwork} />
          {memberNetworks.length === 0 && networks.length > 0 && (
            <Button type="link" onClick={() => onOpenNetwork(networks[0])}>
              Browse existing network tags
            </Button>
          )}
          <Alert
            type="info"
            showIcon
            title="Network tags are permissions, not just labels."
            description="Agents sharing a tag can message each other in both directions. Live delivery may interrupt a running turn; removing a tag blocks new messages and queued work that has not started, but not already-running work."
          />
          <div style={{ width: "100%" }}>
            <label htmlFor="agent-network-tags">Network tags</label>
            <Select
              id="agent-network-tags"
              aria-label={`Network tags for @${agent.name}`}
              mode="tags"
              value={value}
              disabled={busy}
              onChange={onTagsChange}
              placeholder="Select a tag or type a new name"
              style={{ width: "100%", marginTop: 6 }}
              filterOption={(input, option) =>
                `${option?.label ?? ""}`
                  .toLocaleLowerCase()
                  .includes(input.toLocaleLowerCase())
              }
              getPopupContainer={(node) => node.parentElement ?? document.body}
              options={networks.map((network) => ({
                value: network.agent_network_id,
                label: duplicateNetworkTitle(
                  networks,
                  network.title,
                  network.agent_network_id,
                )
                  ? `${network.title} · ${network.agent_network_id.slice(0, 8)}`
                  : network.title,
                disabled:
                  !isMember(network, agent) &&
                  activeNetworkMembers(network).length >=
                    directory.usage.member_limit,
              }))}
              tagRender={({ label, value: tagValue, closable, onClose }) => {
                const network = networks.find(
                  ({ agent_network_id }) => agent_network_id === tagValue,
                );
                return (
                  <Tag
                    color={network ? networkColor(network) : undefined}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                      if (!(event.target as HTMLElement).closest("button"))
                        event.preventDefault();
                    }}
                    style={{ marginInlineEnd: 4 }}
                  >
                    {label}
                    {closable && (
                      <button
                        type="button"
                        aria-label={`Remove ${label} network tag`}
                        onClick={onClose}
                        style={{
                          border: 0,
                          background: "transparent",
                          color: "inherit",
                          cursor: "pointer",
                          marginInlineStart: 4,
                          padding: 0,
                        }}
                      >
                        <span aria-hidden="true">&times;</span>
                      </button>
                    )}
                  </Tag>
                );
              }}
            />
            <Text type="secondary">
              Select an existing tag, or type a new name and press Enter to
              create a live tag.
            </Text>
          </div>
          {error && <Alert role="alert" type="error" showIcon title={error} />}
          {notice && (
            <Alert role="status" type="success" showIcon title={notice} />
          )}
        </Space>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
