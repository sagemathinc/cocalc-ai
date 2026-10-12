/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

// Which computers an agent can use, and the fixes when it can't: reconnect a
// computer that isn't connected, or add the agent to the network a computer
// serves (saying what else that grants). Used by the send check for
// @computer mentions and the composer's Computers dialog. Design:
// src/.agents/computers-lifecycle-ui-2026-10-12.md.

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Space, Spin, Tag } from "antd";
import type { ReactNode } from "react";
import type {
  AgentNetwork,
  AgentNetworkDirectory,
} from "@cocalc/conat/agents/personal";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import type { ComputerSummary } from "@cocalc/util/computers/api";
import { extractComputerMentions } from "@cocalc/util/computer-mentions";
import { uuid } from "@cocalc/util/misc";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { errorText, ReconnectComputer } from "../account/computer-pairing";
import {
  computerState,
  isListed,
  STATE_COLOR,
  STATE_LABEL,
} from "../account/computer-state";
import type { ComputerState } from "../account/computer-state";
import { loadComputersStrict } from "../account/use-computers";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { activeNetworkMembers } from "./agent-network-utils";
import { personalAgentApi, refreshAgentNetworks, sameEndpoint } from "./api";
import { useSourceAgentName } from "./source-agent-name";

export interface AgentComputer {
  computer: ComputerSummary;
  state: ComputerState;
  /** The network the computer serves, if it is still there. */
  network?: AgentNetwork;
  /** The agent is in that network, the network is active, nothing paused. */
  canUse: boolean;
}

export function isMember(network: AgentNetwork, agent: AgentEndpoint) {
  return activeNetworkMembers(network).some(
    (m) => m.kind === "registered" && sameEndpoint(m.endpoint, agent),
  );
}

export function agentComputers(
  computers: ComputerSummary[],
  directory: AgentNetworkDirectory | undefined,
  agent: AgentEndpoint | undefined,
  now = Date.now(),
): AgentComputer[] {
  return computers
    .filter((c) => isListed(c, now))
    .map((computer) => {
      const network = directory?.networks.find(
        (n) =>
          n.agent_network_id === computer.agent_network_id &&
          n.state !== "closed",
      );
      return {
        computer,
        state: computerState(computer, now),
        network,
        canUse:
          agent != null &&
          network != null &&
          network.state === "active" &&
          directory?.controls.paused !== true &&
          isMember(network, agent),
      };
    });
}

/** Everything is fine: connected, and this agent can use it. */
export function ready(item: AgentComputer): boolean {
  return item.state === "connected" && item.canUse;
}

async function loadNetworks(): Promise<AgentNetworkDirectory> {
  return await personalAgentApi().listAgentNetworks({ limit: 100 });
}

/**
 * Add the agent to the network a computer serves, after saying why and what
 * else it grants (messaging the network's agents, its other computers).
 */
function GiveAccess({
  agent,
  agentLabel,
  computer,
  network,
  paused,
  isCurrent,
  onDone,
}: {
  agent: AgentEndpoint;
  agentLabel: string;
  computer: ComputerSummary;
  network: AgentNetwork | undefined;
  paused: boolean;
  /** False once the conversation this was opened for is gone. */
  isCurrent: () => boolean;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const naming = useSourceAgentName(agent, undefined, busy);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const requestId = useRef(uuid());
  const label = naming.known ? `@${naming.known.name}` : agentLabel;
  if (paused) {
    return (
      <span>
        All agent messaging is paused for your account, so no agent can use a
        computer. Resume it in Settings → Agent Networks.
      </span>
    );
  }
  if (network == null) {
    return (
      <span>
        The network @{computer.name} served is gone, so no agent can use it.
        Pair it again for a network this agent is in.
      </span>
    );
  }
  if (network.state !== "active") {
    return (
      <span>
        @{computer.name} serves the {network.title} network, which is paused.
        Resume it in Settings → Agent Networks.
      </span>
    );
  }
  const others = activeNetworkMembers(network).filter(
    (m) => !(m.kind === "registered" && sameEndpoint(m.endpoint, agent)),
  );
  const names = others.map((m) =>
    m.kind === "registered" ? `@${m.name ?? "unnamed"}` : m.label,
  );

  async function add() {
    setBusy(true);
    setError("");
    try {
      await naming.ensureNamed();
      const completed = await runFreshAuthAction(async () => {
        if (!isCurrent()) {
          throw Error("The conversation changed; nothing was added.");
        }
        await personalAgentApi().updateAgentNetwork({
          request_id: requestId.current,
          agent_network_id: network!.agent_network_id,
          action: "add-member",
          member: { kind: "registered", endpoint: agent },
        });
      });
      if (!completed) return;
      refreshAgentNetworks();
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <span>
        {label} can&apos;t use @{computer.name}: @{computer.name} serves the{" "}
        <b>{network.title}</b> network, and {label} isn&apos;t in it. Adding{" "}
        {label} lets it run commands on @{computer.name} (and any other computer
        for {network.title})
        {names.length > 0
          ? `, and message the network's agents: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ` and ${names.length - 8} more` : ""}`
          : ""}
        .
      </span>
      {naming.field}
      {error && <Alert type="error" title={error} />}
      <Button
        type="primary"
        disabled={busy || !naming.canApprove}
        onClick={add}
      >
        Add {label} to {network.title}
      </Button>
      <FreshAuthModal {...freshAuthModalProps} />
    </Space>
  );
}

/** One computer: its state, whether the agent can use it, and the fixes. */
export function ComputerRow({
  item,
  agent,
  agentLabel,
  paused,
  isCurrent = () => true,
  onChanged,
}: {
  item: AgentComputer;
  agent: AgentEndpoint | undefined;
  agentLabel: string;
  paused: boolean;
  isCurrent?: () => boolean;
  onChanged: () => void;
}) {
  const [fixing, setFixing] = useState<"reconnect" | "access">();
  const c = item.computer;
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Space wrap>
        <b>@{c.name}</b>
        <span>
          {c.machine_user}@{c.hostname}
        </span>
        <Tag color={STATE_COLOR[item.state]}>{STATE_LABEL[item.state]}</Tag>
        {item.canUse ? (
          <Tag color="blue">{agentLabel} can use it</Tag>
        ) : (
          <Tag>{agentLabel} can&apos;t use it</Tag>
        )}
      </Space>
      <Space wrap>
        {item.state !== "connected" && fixing !== "reconnect" && (
          <Button size="small" onClick={() => setFixing("reconnect")}>
            Reconnect…
          </Button>
        )}
        {!item.canUse && agent != null && fixing !== "access" && (
          <Button size="small" onClick={() => setFixing("access")}>
            Give {agentLabel} access…
          </Button>
        )}
      </Space>
      {fixing === "reconnect" && (
        <ReconnectComputer
          computer={c}
          onDone={() => {
            setFixing(undefined);
            onChanged();
          }}
        />
      )}
      {fixing === "access" && agent != null && (
        <GiveAccess
          agent={agent}
          agentLabel={agentLabel}
          computer={c}
          network={item.network}
          paused={paused}
          isCurrent={isCurrent}
          onDone={() => {
            setFixing(undefined);
            onChanged();
          }}
        />
      )}
    </Space>
  );
}

/**
 * Before sending a message that mentions computers: if one isn't connected,
 * or this agent can't use it, a dialog guides the fixes (or sends anyway).
 * Everything is bound to the conversation it started in: switching account,
 * project, file or thread closes the dialog, and nothing started for the old
 * one (a lookup, a grant, its send) acts after the switch.
 */
export function useComputerMentionCheck({
  projectId,
  path,
  threadId,
  agentLabel,
  enabled,
}: {
  projectId: string;
  path: string;
  threadId?: string;
  agentLabel: string;
  enabled: boolean;
}) {
  const accountId = useTypedRedux("account", "account_id");
  const [check, setCheck] = useState<{
    epoch: number;
    ids: string[];
    items: AgentComputer[];
    missing: string[];
    agent?: AgentEndpoint;
    paused: boolean;
    send: () => void | Promise<void>;
  }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    lock.current = false;
    setCheck(undefined);
    setError("");
    return () => {
      generation.current += 1;
    };
  }, [accountId, projectId, path, threadId]);

  async function agentEndpoint(): Promise<AgentEndpoint | undefined> {
    if (!threadId) return;
    const api = personalAgentApi();
    const locator = { project_id: projectId, path, thread_id: threadId };
    const identity =
      (await api.resolveIdentity(locator)) ??
      (await api.registerIdentity(locator));
    return identity
      ? { project_id: projectId, agent_id: identity.agent_id }
      : undefined;
  }

  async function evaluate(
    ids: string[],
    names: Map<string, string>,
    agent?: AgentEndpoint,
  ) {
    // Strict: a failed load is an error, never a stale "ready".
    const [computers, directory] = await Promise.all([
      loadComputersStrict(),
      loadNetworks(),
    ]);
    const all = agentComputers(computers, directory, agent);
    const items = ids
      .map((id) => all.find((x) => x.computer.computer_id === id))
      .filter((x): x is AgentComputer => x != null);
    const missing = ids
      .filter((id) => !items.some((x) => x.computer.computer_id === id))
      .map((id) => names.get(id) ?? id);
    return { items, missing, paused: directory.controls.paused === true };
  }

  async function preflight(value: string, send: () => void | Promise<void>) {
    const refs = enabled ? extractComputerMentions(value) : [];
    if (refs.length === 0) return await send();
    if (lock.current) return;
    lock.current = true;
    const epoch = generation.current;
    setError("");
    try {
      const agent = await agentEndpoint();
      if (epoch !== generation.current) return;
      const ids = refs.map((r) => r.computer_id);
      const names = new Map(refs.map((r) => [r.computer_id, `@${r.name}`]));
      const result = await evaluate(ids, names, agent);
      if (epoch !== generation.current) return;
      if (result.missing.length === 0 && result.items.every(ready)) {
        await send();
        return;
      }
      setCheck({ epoch, ids, agent, send, ...result });
    } catch (err) {
      if (epoch === generation.current) setError(errorText(err));
    } finally {
      if (epoch === generation.current) lock.current = false;
    }
  }

  async function recheck() {
    if (!check || check.epoch !== generation.current) return;
    const { epoch } = check;
    setLoading(true);
    try {
      const names = new Map(
        check.items.map((x) => [x.computer.computer_id, `@${x.computer.name}`]),
      );
      const result = await evaluate(check.ids, names, check.agent);
      if (epoch !== generation.current) return;
      setCheck((old) => (old?.epoch === epoch ? { ...old, ...result } : old));
    } catch (err) {
      if (epoch === generation.current) setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }

  async function sendNow() {
    if (!check || check.epoch !== generation.current) return;
    const { send } = check;
    setCheck(undefined);
    try {
      await send();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const current = check?.epoch === generation.current ? check : undefined;
  const allReady =
    current != null &&
    current.missing.length === 0 &&
    current.items.every(ready);
  const ui: ReactNode = (
    <>
      {error && (
        <div role="alert">
          <Alert
            type="warning"
            title={error}
            closable
            onClose={() => setError("")}
          />
        </div>
      )}
      <Modal
        open={current != null}
        title={
          allReady
            ? "Ready to send"
            : "The computers in this message need attention"
        }
        width={640}
        destroyOnHidden
        onCancel={() => setCheck(undefined)}
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
        footer={[
          <Button key="cancel" onClick={() => setCheck(undefined)}>
            Cancel
          </Button>,
          <Button
            key="send"
            type={allReady ? "primary" : "default"}
            onClick={sendNow}
          >
            {allReady ? "Send" : "Send anyway"}
          </Button>,
        ]}
      >
        {current != null && (
          <Space orientation="vertical" style={{ width: "100%" }} size="large">
            {loading && <Spin size="small" />}
            {current.missing.map((name) => (
              <Alert
                key={name}
                type="warning"
                title={`${name} isn't one of your computers anymore. Remove it from the message, or pick another.`}
              />
            ))}
            {current.agent == null && (
              <Alert
                type="info"
                title="This conversation has no agent yet, so whether it may use these computers is checked once it starts."
              />
            )}
            {current.items.map((item) => (
              <ComputerRow
                key={`${current.epoch}:${item.computer.computer_id}`}
                item={item}
                agent={current.agent}
                agentLabel={agentLabel}
                paused={current.paused}
                isCurrent={() => current.epoch === generation.current}
                onChanged={() => void recheck()}
              />
            ))}
          </Space>
        )}
      </Modal>
    </>
  );
  return { preflight, ui };
}

/** The composer's Computers dialog: every computer, as this agent sees it. */
export function AgentComputersModal({
  agent,
  agentLabel,
  open,
  computers,
  directory,
  onChanged,
  onClose,
}: {
  agent: AgentEndpoint;
  agentLabel: string;
  open: boolean;
  computers: ComputerSummary[];
  directory: AgentNetworkDirectory | undefined;
  onChanged: () => void;
  onClose: () => void;
}) {
  const items = agentComputers(computers, directory, agent);
  return (
    <Modal
      open={open}
      title={`Computers for ${agentLabel}`}
      width={640}
      footer={null}
      onCancel={onClose}
      modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
    >
      <Space orientation="vertical" style={{ width: "100%" }} size="large">
        <span>
          Your computers, and whether {agentLabel} can run commands on them. A
          computer serves one agent network; agents in it can use it. Mention
          one in a message as @name.
        </span>
        {items.length === 0 ? (
          <span>
            You have no computers yet. An agent asks for one with{" "}
            <code>cocalc computer request NAME</code>, and you approve it in
            Settings → Agent Networks.
          </span>
        ) : (
          items.map((item) => (
            <ComputerRow
              key={item.computer.computer_id}
              item={item}
              agent={agent}
              agentLabel={agentLabel}
              paused={directory?.controls.paused === true}
              onChanged={onChanged}
            />
          ))
        )}
      </Space>
    </Modal>
  );
}
