/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

// Which computers an agent can use: those connected to its project (a
// computer serves exactly one project, and anything running there can use
// it). Used by the send check for @computer mentions and the composer's
// Computers dialog. Design: src/.agents/computers-direct-host-2026-10-16.md.

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Space, Spin, Tag } from "antd";
import type { ReactNode } from "react";
import type { ComputerSummary } from "@cocalc/util/computers/api";
import { extractComputerMentions } from "@cocalc/util/computer-mentions";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { ConnectComputer, errorText } from "../account/computer-pairing";
import {
  computerState,
  isListed,
  STATE_COLOR,
  STATE_LABEL,
} from "../account/computer-state";
import type { ComputerState } from "../account/computer-state";
import { loadComputersStrict } from "../account/use-computers";

export interface AgentComputer {
  computer: ComputerSummary;
  state: ComputerState;
  /** It serves the agent's project. */
  canUse: boolean;
}

export function agentComputers(
  computers: ComputerSummary[],
  project_id: string | undefined,
  now = Date.now(),
): AgentComputer[] {
  return computers
    .filter((c) => isListed(c, now))
    .map((computer) => ({
      computer,
      state: computerState(computer),
      canUse: project_id != null && computer.project_id === project_id,
    }));
}

/** Everything is fine: connected, and this agent's project can use it. */
export function ready(item: AgentComputer): boolean {
  return item.state === "connected" && item.canUse;
}

/** One computer: its state, whether the agent can use it, and what to do. */
export function ComputerRow({
  item,
  agentLabel,
}: {
  item: AgentComputer;
  agentLabel: string;
}) {
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
      {!item.canUse ? (
        <span>
          @{c.name} serves another project. A computer serves exactly one
          project; connect it again here (Settings → Computers) to use it from
          this one.
        </span>
      ) : item.state === "offline" ? (
        <span>
          @{c.name} isn&apos;t connected now. On {c.machine_user}@{c.hostname},
          run <code>cocalc computer daemon</code>.
        </span>
      ) : item.state === "ended" ? (
        <span>@{c.name} was revoked. Connect it again to use it.</span>
      ) : null}
    </Space>
  );
}

/**
 * Before sending a message that mentions computers: if one isn't connected,
 * or doesn't serve this project, a dialog says so (or sends anyway).
 * Everything is bound to the conversation it started in: switching account,
 * project, file or thread closes the dialog, and nothing started for the old
 * one acts after the switch.
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

  async function evaluate(ids: string[], names: Map<string, string>) {
    // Strict: a failed load is an error, never a stale "ready".
    const all = agentComputers(await loadComputersStrict(), projectId);
    const items = ids
      .map((id) => all.find((x) => x.computer.computer_id === id))
      .filter((x): x is AgentComputer => x != null);
    const missing = ids
      .filter((id) => !items.some((x) => x.computer.computer_id === id))
      .map((id) => names.get(id) ?? id);
    return { items, missing };
  }

  async function preflight(value: string, send: () => void | Promise<void>) {
    const refs = enabled ? extractComputerMentions(value) : [];
    if (refs.length === 0) return await send();
    if (lock.current) return;
    lock.current = true;
    const epoch = generation.current;
    setError("");
    try {
      const ids = refs.map((r) => r.computer_id);
      const names = new Map(refs.map((r) => [r.computer_id, `@${r.name}`]));
      const result = await evaluate(ids, names);
      if (epoch !== generation.current) return;
      if (result.missing.length === 0 && result.items.every(ready)) {
        await send();
        return;
      }
      setCheck({ epoch, ids, send, ...result });
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
      const result = await evaluate(check.ids, names);
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
          <Button key="recheck" onClick={() => void recheck()}>
            Check again
          </Button>,
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
            {current.items.map((item) => (
              <ComputerRow
                key={`${current.epoch}:${item.computer.computer_id}`}
                item={item}
                agentLabel={agentLabel}
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
  projectId,
  agentLabel,
  open,
  computers,
  onChanged,
  onClose,
}: {
  projectId: string;
  agentLabel: string;
  open: boolean;
  computers: ComputerSummary[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const items = agentComputers(computers, projectId);
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
          computer serves one project; everything running there, agents
          included, can use it. Mention one in a message as @name.
        </span>
        {items.length === 0 && <span>You have no computers yet.</span>}
        {items.map((item) => (
          <ComputerRow
            key={item.computer.computer_id}
            item={item}
            agentLabel={agentLabel}
          />
        ))}
        {connecting ? (
          <ConnectComputer
            defaultProjectId={projectId}
            onDone={() => {
              setConnecting(false);
              onChanged();
            }}
          />
        ) : (
          <Button onClick={() => setConnecting(true)}>
            Connect a computer to this project…
          </Button>
        )}
      </Space>
    </Modal>
  );
}
