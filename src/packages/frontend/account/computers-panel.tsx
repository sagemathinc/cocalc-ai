/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Your computers: connect one to a project, approve a machine after checking
// its pairing phrase (fresh auth), and revoke. Design:
// src/.agents/computers-direct-host-2026-10-16.md.

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
import {
  approvalText,
  approveRequest,
  computersApi as api,
  ConnectComputer,
  ConnectOnMachine,
  errorText,
  projectTitle,
  useComputerProjects,
} from "./computer-pairing";
import {
  computerState,
  isListed,
  STATE_COLOR,
  STATE_LABEL,
} from "./computer-state";

const OPEN = new Set(["pending", "claimed"]);
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
  const [connecting, setConnecting] = useState(false);
  const lock = useRef(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const projects = useComputerProjects();

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
    if (r.pairing_phrase == null) return;
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
          <div>{approvalText(r, projectTitle(projects, r.project_id))}</div>
        </Space>
      ),
      okText: "Approve",
      onOk: () =>
        act(async () => {
          await runFreshAuthAction(() => approveRequest(r));
        }),
    });
  }

  return (
    <Space orientation="vertical" style={{ width: "100%", maxWidth: 1000 }}>
      <Typography.Title level={4} style={{ marginBottom: 0 }}>
        Computers
      </Typography.Title>
      <span>
        Connect a machine (a laptop, a server) to one of your projects, and
        anything running in that project, agents included, can run commands
        there as you. The machine connects out to the project&apos;s host: it
        needs no open port, and you can revoke it here at any time.
      </span>
      <div>
        <Button onClick={() => setConnecting(true)}>Connect a computer…</Button>
      </div>
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
                  <span>For {projectTitle(projects, r.project_id)}</span>
                </Space>
              ),
            },
            {
              key: "state",
              title: "State",
              render: (_, r) =>
                stateNow(r, Date.now()) === "expired" ? (
                  <Tag>expired</Tag>
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
                    <Tag color="blue">machine answered</Tag>
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
                    {r.state === "claimed" && (
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
                    {c.machine_user}@{c.hostname} ({c.os} {c.arch})
                  </span>
                  <span>For {projectTitle(projects, c.project_id)}</span>
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
              title: "Last connected",
              render: (_, c) =>
                c.revoked_at ? (
                  <span>
                    revoked <TimeAgo date={c.revoked_at} />
                  </span>
                ) : c.connected_at ? (
                  <TimeAgo date={c.connected_at} />
                ) : (
                  "never"
                ),
            },
            {
              key: "actions",
              title: "",
              align: "right",
              render: (_, c) =>
                computerState(c) === "ended" ? null : (
                  <Button
                    danger
                    disabled={busy}
                    onClick={() =>
                      Modal.confirm({
                        title: `Revoke @${c.name}?`,
                        content:
                          "Its project can't use it any more: its connection is closed within seconds, every command it is running is stopped, and its connector ends. Connect it again to use it.",
                        okText: "Revoke",
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
                    Revoke
                  </Button>
                ),
            },
          ]}
        />
      )}
      <Modal
        open={connecting}
        title="Connect a computer"
        footer={null}
        destroyOnHidden
        onCancel={() => {
          setConnecting(false);
          void refresh();
        }}
      >
        <ConnectComputer onDone={() => void refresh()} />
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </Space>
  );
}
