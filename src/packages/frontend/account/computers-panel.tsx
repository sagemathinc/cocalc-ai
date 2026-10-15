/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Computers connected for your agents: open requests (with the line to run
// on the machine), approving a paired machine after checking its pairing
// phrase (fresh auth), and revoking. Plan:
// src/.agents/computers-plan-2026-10-11.md ("How it looks to the human").

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Space, Table, Tag, Typography } from "antd";
import type {
  ComputerRequestSummary,
  ComputerSummary,
} from "@cocalc/util/computers/api";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { useAgentNetworks } from "@cocalc/frontend/agents/api";
import {
  approvalText,
  approveRequest,
  computersApi as api,
  errorText,
  ConnectOnMachine,
  ReconnectComputer,
  timeLimit,
} from "./computer-pairing";
import {
  computerState,
  isListed,
  STATE_COLOR,
  STATE_LABEL,
} from "./computer-state";
import { LeaseSummary } from "./computer-lease";

const OPEN = new Set(["pending", "paired"]);
/** Expired requests stay listed this long, so the owner sees what happened. */
const SHOW_EXPIRED_MS = 60 * 60 * 1000;

/** Open, but its time ran out (the list may not have caught up yet). */
function stateNow(r: ComputerRequestSummary, now: number): string {
  return OPEN.has(r.state) && r.expires_at <= now ? "expired" : r.state;
}

export function ComputersPanel() {
  const [requests, setRequests] = useState<ComputerRequestSummary[]>([]);
  const [computers, setComputers] = useState<ComputerSummary[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const [reconnecting, setReconnecting] = useState<ComputerSummary>();
  const { directory: networks } = useAgentNetworks(true);
  const networkTitle = (id: string) =>
    networks?.networks.find((n) => n.agent_network_id === id)?.title;

  async function refresh() {
    try {
      const [r, c] = await Promise.all([
        api().listComputerRequests({}),
        api().listComputers({}),
      ]);
      const now = Date.now();
      setRequests(
        r.filter(
          (x) =>
            OPEN.has(stateNow(x, now)) ||
            (stateNow(x, now) === "expired" &&
              x.expires_at > now - SHOW_EXPIRED_MS),
        ),
      );
      setComputers(c.filter((x) => isListed(x, now)));
    } catch (err) {
      setError(errorText(err));
    }
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, []);

  async function act(fn: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errorText(err));
      void refresh();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function approve(r: ComputerRequestSummary) {
    if (r.transcript_hash == null || r.agent_network == null) return;
    Modal.confirm({
      title: `Connect ${r.machine?.hostname ?? "this machine"} as @${r.name}?`,
      width: 560,
      content: (
        <Space orientation="vertical">
          <div>
            Only approve if the machine shows exactly this pairing phrase:
          </div>
          <Typography.Text strong code style={{ fontSize: "16px" }}>
            {r.pairing_phrase}
          </Typography.Text>
          <div>{approvalText(r)}</div>
        </Space>
      ),
      okText: "Approve",
      onOk: () =>
        act(async () => {
          await runFreshAuthAction(() => approveRequest(r));
        }),
    });
  }

  if (requests.length === 0 && computers.length === 0 && !error) {
    return null;
  }
  return (
    <Space orientation="vertical" style={{ width: "100%", maxWidth: 1000 }}>
      <Typography.Title level={4} style={{ marginBottom: 0 }}>
        Computers
      </Typography.Title>
      {error && (
        <div role="alert">
          <Alert
            type="error"
            title={error}
            closable
            onClose={() => setError("")}
          />
        </div>
      )}
      {requests.length > 0 && (
        <Table
          size="small"
          rowKey="request_id"
          pagination={false}
          dataSource={requests}
          columns={[
            {
              key: "name",
              title: "Request",
              render: (_, r) => (
                <Space orientation="vertical" size={0}>
                  <b>@{r.name}</b>
                  {r.why && <span>{r.why}</span>}
                  <span>{timeLimit(r.requested_policy)}</span>
                  <LeaseSummary policy={r.requested_policy} />
                </Space>
              ),
            },
            {
              key: "state",
              title: "State",
              render: (_, r) =>
                stateNow(r, Date.now()) === "expired" ? (
                  <Space orientation="vertical" size={0}>
                    <Tag>expired</Tag>
                    <span>
                      Not approved in time. Ask the agent for a new request.
                    </span>
                  </Space>
                ) : r.state === "pending" ? (
                  <Space
                    orientation="vertical"
                    size={4}
                    style={{ width: "100%" }}
                  >
                    <Tag>waiting for the machine</Tag>
                    <span>In a terminal on the machine, run:</span>
                    {r.pairing_url && (
                      <ConnectOnMachine pairing_url={r.pairing_url} />
                    )}
                  </Space>
                ) : (
                  <Space orientation="vertical" size={0}>
                    <Tag color="blue">machine paired</Tag>
                    <span>
                      {r.machine?.user}@{r.machine?.hostname} ({r.machine?.os}{" "}
                      {r.machine?.arch})
                    </span>
                    <span>
                      Phrase: <b>{r.pairing_phrase}</b>
                    </span>
                  </Space>
                ),
            },
            {
              key: "actions",
              title: "",
              align: "right",
              render: (_, r) =>
                stateNow(r, Date.now()) === "expired" ? null : (
                  <Space>
                    {r.state === "paired" && (
                      <Button
                        type="primary"
                        disabled={busy}
                        onClick={() => approve(r)}
                      >
                        Approve…
                      </Button>
                    )}
                    <Button
                      disabled={busy}
                      onClick={() =>
                        act(() =>
                          api().declineComputerRequest({
                            request_id: r.request_id,
                          }),
                        )
                      }
                    >
                      Decline
                    </Button>
                  </Space>
                ),
            },
          ]}
        />
      )}
      {computers.length > 0 && (
        <Table
          size="small"
          rowKey="computer_id"
          pagination={false}
          dataSource={computers}
          columns={[
            {
              key: "name",
              title: "Computer",
              render: (_, c) => (
                <Space orientation="vertical" size={0}>
                  <b>@{c.name}</b>
                  <span>
                    {c.machine_user}@{c.hostname} ({c.os} {c.arch}), {c.mode}
                  </span>
                  {networkTitle(c.agent_network_id) && (
                    <span>
                      For the {networkTitle(c.agent_network_id)} network
                    </span>
                  )}
                  <LeaseSummary policy={c.effective_policy} />
                </Space>
              ),
            },
            {
              key: "state",
              title: "State",
              render: (_, c) => {
                const state = computerState(c);
                return (
                  <Tag color={STATE_COLOR[state]}>{STATE_LABEL[state]}</Tag>
                );
              },
            },
            {
              key: "seen",
              title: "Last seen",
              render: (_, c) =>
                c.connected ? (
                  "now"
                ) : c.last_seen ? (
                  <TimeAgo date={c.last_seen} />
                ) : (
                  "never"
                ),
            },
            {
              key: "until",
              title: "Until",
              render: (_, c) =>
                c.revoked_at ? (
                  <span>
                    disconnected <TimeAgo date={c.revoked_at} />
                  </span>
                ) : c.deadline ? (
                  <TimeAgo date={c.deadline} />
                ) : c.certificate_not_after ? (
                  <span title="Its certificate ends then: connect it again to keep using it.">
                    <TimeAgo date={c.certificate_not_after} />
                  </span>
                ) : (
                  "no limit"
                ),
            },
            {
              key: "actions",
              title: "",
              align: "right",
              render: (_, c) => {
                const state = computerState(c);
                return (
                  <Space>
                    {state !== "connected" && (
                      <Button
                        type={state === "offline" ? "primary" : "default"}
                        disabled={busy}
                        onClick={() => setReconnecting(c)}
                      >
                        Reconnect…
                      </Button>
                    )}
                    {state !== "ended" && (
                      <Button
                        danger
                        disabled={busy}
                        onClick={() =>
                          Modal.confirm({
                            title: `Disconnect @${c.name}?`,
                            content:
                              "New operations are refused at once and the machine's connection is closed within seconds. Commands and jobs already running there are NOT stopped yet: stop them on the machine if needed.",
                            okText: "Disconnect",
                            okButtonProps: { danger: true },
                            onOk: () =>
                              act(() =>
                                api().revokeComputer({
                                  computer_id: c.computer_id,
                                }),
                              ),
                          })
                        }
                      >
                        Disconnect
                      </Button>
                    )}
                  </Space>
                );
              },
            },
          ]}
        />
      )}
      <Modal
        open={reconnecting != null}
        title={reconnecting ? `Reconnect @${reconnecting.name}` : ""}
        footer={null}
        destroyOnHidden
        onCancel={() => {
          setReconnecting(undefined);
          void refresh();
        }}
      >
        {reconnecting && (
          <ReconnectComputer
            computer={reconnecting}
            onDone={() => void refresh()}
          />
        )}
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </Space>
  );
}
