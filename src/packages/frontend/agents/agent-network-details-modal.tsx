/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import type {
  AgentNetwork,
  AgentNetworkActivity,
} from "@cocalc/conat/agents/personal";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { uuid } from "@cocalc/util/misc";
import { personalAgentApi } from "./api";
import {
  duplicateNetworkTitle,
  networkProjectCount,
} from "./agent-network-utils";
import { AgentNetworkSummary } from "./agent-network-summary";

const { Text } = Typography;

function memberLabel(network: AgentNetwork, memberId: string): string {
  const member = network.members.find(
    ({ member_id }) => member_id === memberId,
  );
  if (!member) return memberId;
  if (member.kind === "external") return member.label;
  return member.name
    ? `@${member.name}`
    : (member.thread_title ?? member.member_id);
}

export function AgentNetworkDetailsModal({
  network,
  networks = [],
  onClose,
  onChanged,
  onSelectNetwork,
}: {
  network?: AgentNetwork;
  networks?: AgentNetwork[];
  onClose: () => void;
  onChanged?: () => void | Promise<void>;
  onSelectNetwork?: (network: AgentNetwork) => void;
}) {
  const [activity, setActivity] = useState<AgentNetworkActivity[]>();
  const [activityLoading, setActivityLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [title, setTitle] = useState("");
  const requestIds = useRef(new Map<string, string>());
  const activityRevision = useRef(0);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  async function loadActivity(value: AgentNetwork) {
    const revision = ++activityRevision.current;
    setActivityLoading(true);
    try {
      const rows = await personalAgentApi().listAgentNetworkActivity({
        agent_network_id: value.agent_network_id,
        limit: 50,
      });
      if (revision === activityRevision.current) setActivity(rows);
    } catch (err) {
      if (revision === activityRevision.current) setError(`${err}`);
    } finally {
      if (revision === activityRevision.current) setActivityLoading(false);
    }
  }

  useEffect(() => {
    activityRevision.current += 1;
    setActivity(undefined);
    setError("");
    setNotice("");
    setTitle(network?.title ?? "");
    if (network) void loadActivity(network);
    return () => {
      activityRevision.current += 1;
    };
  }, [network?.agent_network_id]);

  function requestId(key: string): string {
    let value = requestIds.current.get(key);
    if (!value) {
      value = uuid();
      requestIds.current.set(key, value);
    }
    return value;
  }

  async function mutate(
    key: string,
    action: () => Promise<unknown>,
    success: string,
    requireFresh = false,
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
        await onChanged?.();
      }
      return completed;
    } catch (err) {
      setError(`${err}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!network) return null;
  const projects = networkProjectCount(network);
  const duplicateTitle = duplicateNetworkTitle(
    networks,
    title,
    network.agent_network_id,
  );

  const setDelivery = (deliveryMode: "queued" | "live") => {
    const key = `${network.agent_network_id}:delivery:${deliveryMode}:${network.generation}`;
    return mutate(
      key,
      () =>
        personalAgentApi().updateAgentNetwork({
          request_id: requestId(key),
          agent_network_id: network.agent_network_id,
          action: "set-delivery",
          delivery_mode: deliveryMode,
        }),
      `Delivery changed to ${deliveryMode}.`,
      deliveryMode === "live" && projects > 1,
    );
  };

  return (
    <>
      <Modal
        open
        title="Agent Network details"
        width={760}
        footer={
          <Button onClick={onClose} disabled={busy}>
            Close
          </Button>
        }
        onCancel={() => {
          if (!busy) onClose();
        }}
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          {error && <Alert role="alert" type="error" showIcon title={error} />}
          {notice && (
            <Alert role="status" type="success" showIcon title={notice} />
          )}
          <AgentNetworkSummary
            network={network}
            titleControl={
              <Select
                aria-label="Select Agent Network"
                value={network.agent_network_id}
                onChange={(id) => {
                  const next = networks.find(
                    ({ agent_network_id }) => agent_network_id === id,
                  );
                  if (next) onSelectNetwork?.(next);
                }}
                getPopupContainer={(node) =>
                  node.parentElement ?? document.body
                }
                options={(networks.length ? networks : [network]).map(
                  (item) => ({
                    value: item.agent_network_id,
                    label: duplicateNetworkTitle(
                      networks,
                      item.title,
                      item.agent_network_id,
                    )
                      ? `${item.title} · ${item.agent_network_id.slice(0, 8)}`
                      : item.title,
                  }),
                )}
                style={{ minWidth: 160, maxWidth: "100%" }}
              />
            }
          />

          <section aria-labelledby="agent-network-controls-heading">
            <Space orientation="vertical" size={8} style={{ width: "100%" }}>
              <Text strong id="agent-network-controls-heading">
                Network controls
              </Text>
              <Space.Compact style={{ width: "100%" }}>
                <Input
                  aria-label="Network title"
                  value={title}
                  maxLength={120}
                  onChange={(event) => setTitle(event.target.value)}
                  onPressEnter={() => {
                    const next = title.trim();
                    if (!next || next === network.title || duplicateTitle)
                      return;
                    const key = `${network.agent_network_id}:title:${next}:${network.generation}`;
                    void mutate(
                      key,
                      () =>
                        personalAgentApi().updateAgentNetwork({
                          request_id: requestId(key),
                          agent_network_id: network.agent_network_id,
                          action: "set-title",
                          title: next,
                        }),
                      "Agent Network renamed.",
                    );
                  }}
                />
                <Button
                  disabled={
                    busy ||
                    !title.trim() ||
                    title.trim() === network.title ||
                    duplicateTitle
                  }
                  onClick={() => {
                    const next = title.trim();
                    const key = `${network.agent_network_id}:title:${next}:${network.generation}`;
                    void mutate(
                      key,
                      () =>
                        personalAgentApi().updateAgentNetwork({
                          request_id: requestId(key),
                          agent_network_id: network.agent_network_id,
                          action: "set-title",
                          title: next,
                        }),
                      "Agent Network renamed.",
                    );
                  }}
                >
                  Rename
                </Button>
              </Space.Compact>
              {duplicateTitle && (
                <Text role="alert" type="danger">
                  Another network tag already uses this name. Choose a distinct
                  name.
                </Text>
              )}
              <Space wrap>
                <Button
                  disabled={busy || network.state === "closed"}
                  onClick={() => {
                    const next =
                      network.delivery_mode === "live" ? "queued" : "live";
                    if (next === "live") {
                      Modal.confirm({
                        title: "Enable live agent delivery?",
                        content:
                          "Every network member may interrupt every other member's running turn. Peer messages remain agent-provided content, not human instructions.",
                        okText: "Enable live delivery",
                        onOk: () => setDelivery(next),
                      });
                    } else {
                      void setDelivery(next);
                    }
                  }}
                >
                  Use {network.delivery_mode === "live" ? "queued" : "live"}{" "}
                  delivery
                </Button>
                <Button
                  disabled={busy || network.state === "closed"}
                  onClick={() => {
                    const action =
                      network.state === "paused" ? "resume" : "pause";
                    const key = `${network.agent_network_id}:${action}:${network.generation}`;
                    void mutate(
                      key,
                      () =>
                        personalAgentApi().updateAgentNetwork({
                          request_id: requestId(key),
                          agent_network_id: network.agent_network_id,
                          action,
                        }),
                      `Network ${action === "pause" ? "paused" : "resumed"}.`,
                      action === "resume" && projects > 1,
                    );
                  }}
                >
                  {network.state === "paused" ? "Resume" : "Pause"} network
                </Button>
                <Button
                  danger
                  disabled={busy || network.state === "closed"}
                  onClick={() =>
                    Modal.confirm({
                      title: "Close this Agent Network?",
                      content:
                        "Closing is permanent and blocks new messages and queued work that has not started. It does not cancel already-running work or erase chat history.",
                      okText: "Close network",
                      okButtonProps: { danger: true },
                      onOk: () => {
                        const key = `${network.agent_network_id}:close:${network.generation}`;
                        return mutate(
                          key,
                          () =>
                            personalAgentApi().updateAgentNetwork({
                              request_id: requestId(key),
                              agent_network_id: network.agent_network_id,
                              action: "close",
                            }),
                          "Agent Network closed.",
                        );
                      },
                    })
                  }
                >
                  Close network
                </Button>
              </Space>
              <Text type="secondary">
                Pausing blocks new messages. Queued work is checked again before
                execution; already-running work is not canceled. Membership and
                settings changes remain available.
              </Text>
            </Space>
          </section>

          <section aria-labelledby="agent-network-activity-heading">
            <Space orientation="vertical" size={8} style={{ width: "100%" }}>
              <Space
                wrap
                style={{ justifyContent: "space-between", width: "100%" }}
              >
                <Text strong id="agent-network-activity-heading">
                  Recent message activity
                </Text>
                <Button
                  size="small"
                  loading={activityLoading}
                  onClick={() => void loadActivity(network)}
                >
                  Refresh
                </Button>
              </Space>
              {activity && network.members.length > 0 && (
                <Space wrap size={[4, 4]}>
                  {network.members.map((member) => {
                    const sent = activity.filter(
                      ({ source_member_id }) =>
                        source_member_id === member.member_id,
                    ).length;
                    const received = activity.filter(
                      ({ target_member_id }) =>
                        target_member_id === member.member_id,
                    ).length;
                    return (
                      <Tag key={member.member_id}>
                        {memberLabel(network, member.member_id)}: {sent} sent,{" "}
                        {received} received
                      </Tag>
                    );
                  })}
                </Space>
              )}
              {!activityLoading && activity?.length === 0 && (
                <Text type="secondary">No retained activity.</Text>
              )}
              {activity && activity.length > 0 && (
                <ol style={{ margin: 0, paddingInlineStart: 22 }}>
                  {activity.map((row) => (
                    <li key={row.attempt_id} style={{ marginBlock: 6 }}>
                      <strong>
                        {memberLabel(network, row.source_member_id)}
                      </strong>{" "}
                      to{" "}
                      <strong>
                        {memberLabel(network, row.target_member_id)}
                      </strong>
                      : {row.outcome ?? "pending"}
                      {row.effective_delivery
                        ? ` via ${row.effective_delivery}`
                        : ""}
                      <Text type="secondary">
                        {" "}
                        · {new Date(row.observed_at).toLocaleString()}
                      </Text>
                    </li>
                  ))}
                </ol>
              )}
            </Space>
          </section>
        </Space>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
