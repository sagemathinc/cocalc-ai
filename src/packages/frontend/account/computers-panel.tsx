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
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";

const api = () => webapp_client.conat_client.hub.computers;
const OPEN = new Set(["pending", "paired"]);

function timeLimit(policy: {
  duration: null | { initial_seconds: number; max_seconds: number };
}) {
  if (policy?.duration == null) return "no time limit";
  const { initial_seconds, max_seconds } = policy.duration;
  return `${Math.round(initial_seconds / 60)} min (at most ${Math.round(max_seconds / 3600)} h)`;
}

export function ComputersPanel() {
  const [requests, setRequests] = useState<ComputerRequestSummary[]>([]);
  const [computers, setComputers] = useState<ComputerSummary[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  async function refresh() {
    try {
      const [r, c] = await Promise.all([
        api().listComputerRequests({}),
        api().listComputers({}),
      ]);
      setRequests(r.filter((x) => OPEN.has(x.state)));
      setComputers(c.filter((x) => x.revoked_at == null));
    } catch (err) {
      setError(`${err}`);
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
      setError(`${err}`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function approve(r: ComputerRequestSummary) {
    if (r.transcript_hash == null || r.agent_network == null) return;
    const members = r.agent_network.members.length;
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
          <div>
            DIRECT mode: the {members} agent{members === 1 ? "" : "s"} in the{" "}
            <b>{r.agent_network.title}</b> network will be able to run any
            command there as <b>{r.machine?.user}</b>, with all of that user's
            access, for {timeLimit(r.resolved_policy ?? r.requested_policy)}.
          </div>
        </Space>
      ),
      okText: "Approve",
      onOk: () =>
        act(async () => {
          await runFreshAuthAction(async () => {
            await api().approveComputerRequest({
              request_id: r.request_id,
              transcript_hash: r.transcript_hash!,
              agent_network_generation: r.agent_network!.generation,
            });
          });
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
          <Alert type="error" title="Computers" description={error} />
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
                </Space>
              ),
            },
            {
              key: "state",
              title: "State",
              render: (_, r) =>
                r.state === "pending" ? (
                  <Space orientation="vertical" size={0}>
                    <Tag>waiting for the machine</Tag>
                    <span>Run this on the machine:</span>
                    <Typography.Text code copyable>
                      {`cocalc computer connect ${location.origin}/c/${r.request_id}`}
                    </Typography.Text>
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
              render: (_, r) => (
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
                </Space>
              ),
            },
            {
              key: "seen",
              title: "Last seen",
              render: (_, c) =>
                c.last_seen ? new Date(c.last_seen).toLocaleString() : "never",
            },
            {
              key: "until",
              title: "Until",
              render: (_, c) =>
                c.deadline ? new Date(c.deadline).toLocaleString() : "no limit",
            },
            {
              key: "revoke",
              title: "",
              align: "right",
              render: (_, c) => (
                <Button
                  danger
                  disabled={busy}
                  onClick={() =>
                    Modal.confirm({
                      title: `Disconnect @${c.name}?`,
                      content:
                        "Agents lose access at once; running jobs are stopped when the machine learns of it.",
                      okText: "Disconnect",
                      okButtonProps: { danger: true },
                      onOk: () =>
                        act(() =>
                          api().revokeComputer({ computer_id: c.computer_id }),
                        ),
                    })
                  }
                >
                  Disconnect
                </Button>
              ),
            },
          ]}
        />
      )}
      <FreshAuthModal {...freshAuthModalProps} />
    </Space>
  );
}
